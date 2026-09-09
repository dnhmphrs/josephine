/* ===========================================================================
   The check suite.

     npm run build
     npm i -D playwright && npx playwright install chromium   (once)
     node scripts/check.mjs

   Everything visible on this site is inside a canvas, which means the usual
   safety nets do not apply: a unit test cannot see a glyph, and a type error
   is not the failure mode to worry about. What can go wrong here is that the
   page renders something WRONG - or renders nothing at all on a browser that
   is missing one API.

   So this drives the real built site in a real browser and asserts on what it
   actually does: that the hit layer exists and is made of real anchors and
   buttons, that tab order is reading order, that clicking and Enter do what
   they should, that the language switch is a CUT with nothing running after
   it, that the opening holds the first screen and the CV follows it, that a
   rapid triple toggle leaves the state and the drawing agreeing, that NO
   readable text ships anywhere,
   and that it says who she is
   with WebGL removed, with localStorage throwing, without Intl.Segmenter,
   under prefers-reduced-motion, at 320x480, through a resize storm, across a
   lost and restored WebGL context, and with scripting disabled entirely.

   Playwright is deliberately NOT a dependency - see scripts/og.mjs.
   =========================================================================== */

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.error('Playwright is not installed. It is not a dependency of this project - it pulls a browser:\n\n  npm i -D playwright && npx playwright install chromium\n');
  process.exit(1);
}
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};
const server=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html'; let f=path.join(ROOT,p); if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(ROOT,'index.html'); r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); r.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,r)); const PORT=server.address().port;
const URL=`http://localhost:${PORT}/`;
const OUT = path.join(ROOT, '..', '.check');
fs.mkdirSync(OUT, { recursive: true });
const GL=['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'];
/* Playwright normally finds its own browser. CHROMIUM_PATH is for the case
   where the machine has one already and cannot download another - a CI image
   with a pinned Chromium, or a sandbox with no route to the download CDN. */
const LAUNCH = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const results=[];
const ok=(n,v,extra='')=>{results.push(`${v?'PASS':'FAIL'}  ${n}${extra?'  '+extra:''}`);};

/* --- 1. normal interaction ------------------------------------------------ */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(2200);

  const hits = await p.$$eval('#scroll .hit, #fixed .hit', els => els.map(e=>({tag:e.tagName,id:e.dataset.id,href:e.getAttribute('href'),pressed:e.getAttribute('aria-pressed'),label:e.textContent,w:e.offsetWidth,h:e.offsetHeight})));
  ok('hit layer built', hits.length>=3, JSON.stringify(hits.map(h=>h.id)));
  ok('all targets >= 44px tall', hits.every(h=>h.h>=44));
  ok('mail is a real mailto anchor', hits.some(h=>h.tag==='A'&&/^mailto:/.test(h.href||'')));
  ok('linkedin is a real https anchor', hits.some(h=>h.tag==='A'&&/^https:/.test(h.href||'')));
  /* ONE language control, not two. Two targets for a two-state switch asks the
     reader to aim; this asserts the aiming is gone. */
  ok('the language control is a single element',
    hits.filter(h=>/^lang:/.test(h.id)).length===1 && hits.some(h=>h.id==='lang:toggle'),
    JSON.stringify(hits.filter(h=>/^lang:/.test(h.id)).map(h=>h.id)));

  /* One page: the opening holds the first screen on its own and the CV starts
     under it. Both halves matter - an opening that overflows the fold is not
     an opening, and a CV that starts above it is not below it. */
  let d=await p.evaluate(()=>window.__stage.diag());
  const shape = await p.evaluate(() => {
    const items = window.__stage.items();
    const at = (k) => items.find((i) => i.key.startsWith(k));
    return { head: at('index.name').y, cv: at('cv.0.head').y, foot: at('foot.mail').y, vh: innerHeight };
  });
  /* Wide and shallow: the opening sits in the top third and the CV's first
     section head is already on the first screen. The earlier version of this
     page held the CV down to the fold, which made the head as tall as the
     window whatever it contained; both bounds here are what stops that
     returning, from either direction. */
  ok('the opening is shallow and the CV is on the first screen',
    shape.head < shape.vh * 0.35 && shape.cv > shape.vh * 0.45 && shape.cv < shape.vh * 0.95,
    JSON.stringify(shape));
  ok('the CV and the footer are below it', shape.foot > shape.cv && d.height > shape.foot, JSON.stringify(d));

  /* Availability belongs to the head, above the first CV section - it used to
     sit in the body, where four flat facts read as an application. */
  {
    const head = await p.evaluate(() => {
      const items = window.__stage.items();
      const at = (k) => items.find((i) => i.key.startsWith(k));
      return {
        avail: at('index.available') ? at('index.available').y : null,
        cv: at('cv.0.head').y,
        toggleY: (at('nav.') || {}).y,
      };
    });
    ok('availability is in the head, above the CV',
      head.avail !== null && head.avail < head.cv, JSON.stringify(head));
  }

  /* Sticky. The toggle is drawn viewport-anchored and its target lives in the
     fixed layer, so scrolling must not move either: the mark's drawn y rises
     with scrollY by exactly the amount the renderer takes back out, and the
     element's box on screen does not move at all. */
  {
    const before = await p.evaluate(() => {
      const el = document.querySelector('#fixed .hit[data-id="lang:toggle"]');
      return el ? el.getBoundingClientRect().top : null;
    });
    await p.evaluate(() => scrollTo(0, 600));
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => {
      const el = document.querySelector('#fixed .hit[data-id="lang:toggle"]');
      return el ? el.getBoundingClientRect().top : null;
    });
    ok('the language control is sticky', before !== null && Math.abs(after - before) < 1,
      JSON.stringify({ before, after }));
    ok('and its marks are drawn fixed',
      (await p.evaluate(() => window.__stage.items().filter(i => i.key.startsWith('nav.')).every(i => i.fixed))));
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForTimeout(300);
  }

  /* Redaction. It SHIPS OFF - the resting page is a document, not a document
     being declassified - and the parameter that turns it on has to keep
     working, because the machinery is what makes the choice a choice. So:
     nothing is barred by default at any scroll position, and ?reveal=on bars
     what is below the fold and nothing above it. */
  {
    const r = await p.evaluate(() => window.__stage.reveal());
    ok('the page ships with nothing redacted',
      r.on === false && Object.values(r.seals).every((v) => v === -1),
      JSON.stringify({ on: r.on, sealed: Object.values(r.seals).filter((v) => v !== -1).length }));
  }
  {
    const q = await ctx.newPage();
    await q.goto(URL + '?reveal=on');
    await q.waitForTimeout(2200);
    const r = await q.evaluate(() => window.__stage.reveal());
    const above = Object.entries(r.seals).filter(([k]) => /^head\.|^cv\.0\.head/.test(k));
    ok('?reveal=on un-redacts the first screen on load',
      r.on === true && above.length > 0 && above.every(([, v]) => v === -1 || v > 0.9),
      JSON.stringify(above.slice(0, 4)));
    ok('?reveal=on leaves a seal below the fold sealed',
      Object.values(r.seals).some((v) => v === 0),
      String(Object.values(r.seals).filter((v) => v === 0).length));
    await q.close();
  }

  /* A cut, not a transition: read the state on the very next frame, with no
     settling time at all. Anything animating would still be running here. */
  await p.click('[data-id="lang:toggle"]');
  await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  d=await p.evaluate(()=>window.__stage.diag());
  ok('中 switches language on the next frame', d.lang==='zh', JSON.stringify(d));
  /* And nothing is still moving half a second later: what is on screen one
     frame after the click is what is on screen when it settles, quad for quad.
     A transition of any kind would fail this. */
  await p.waitForTimeout(500);
  const settled=await p.evaluate(()=>window.__stage.diag());
  ok('the switch is finished on that frame',
    settled.quads===d.quads && settled.height===d.height, JSON.stringify({d, settled}));
  ok('<html lang> follows', (await p.evaluate(()=>document.documentElement.lang))==='zh-Hans');
  /* The tab carries a mark, not a name: 32 block glyphs and nothing a reader
     of any language could pronounce. It must also not change with the toggle -
     it is the document's identity, not the page's current language. */
  {
    const t = await p.title();
    ok('the tab is a block mark in either language',
      t.length === 32 && /^[\u2580-\u259F]+$/.test(t), JSON.stringify(t));
  }

  /* Nothing may exceed the measure except Chinese punctuation, which hangs
     into the margin on purpose. Everything else running past the right edge is
     a line the breaker failed to break. */
  {
    const over = await p.evaluate(() => {
      const g = window.__stage.grid();
      return window.__stage.items()
        .filter((i) => i.x < g.left - 1 || i.x + i.w > g.right + 16)
        .map((i) => `${i.key}:${i.text}`);
    });
    ok('nothing overflows the measure', over.length === 0, over.slice(0, 3).join(' | '));
  }

  // rapid triple press of the one control
  await p.click('[data-id="lang:toggle"]'); await p.waitForTimeout(120);
  await p.click('[data-id="lang:toggle"]'); await p.waitForTimeout(120);
  await p.click('[data-id="lang:toggle"]'); await p.waitForTimeout(1200);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('survives a rapid triple toggle', d.lang==='en', JSON.stringify(d));
  ok('the drawing agrees after the storm', d.quads>10 && d.overflow===0);

  // keyboard
  /* Tab past the browser's own stops (which report as null) and read the order
     of the page's own controls. Compared cyclically: where the walk starts
     depends on what was focused last, but the sequence must not change. */
  await p.evaluate(()=>document.activeElement && document.activeElement.blur());
  const order=[];
  for (let i=0;i<8;i++){ await p.keyboard.press('Tab'); const id=await p.evaluate(()=>document.activeElement&&document.activeElement.dataset?document.activeElement.dataset.id:null); if(id&&!order.includes(id)) order.push(id); }
  const want=['lang:toggle','mail','linkedin'];
  const rotated=order.length===3 && want.some((_,k)=>JSON.stringify(order)===JSON.stringify(want.slice(k).concat(want.slice(0,k))));
  ok('tab order is reading order', rotated, JSON.stringify(order));
  /* The hit layer carries no text of its own - no labels, no accessible
     names. That is the cost of the zero-text decision and it is asserted here
     so it cannot be softened back in by accident. */
  ok('the hit layer carries no readable text',
    (await p.$$eval('#scroll .hit, #fixed .hit', els => els.every(e => !e.textContent.trim() && !e.getAttribute('aria-label')))));
  await p.evaluate(()=>{document.querySelector('[data-id="lang:toggle"]').focus()});
  await p.waitForTimeout(200);
  await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('Enter activates a control', d.lang==='zh');
  await p.click('[data-id="lang:toggle"]'); await p.waitForTimeout(400);
  await p.screenshot({path:`${OUT}/focus-ring.png`, clip:{x:0,y:0,width:400,height:140}});

  ok('no console or page errors', errs.length===0, errs.slice(0,3).join(' | '));
  await b.close();
}

/* --- 2. reduced motion ---------------------------------------------------- */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2,reducedMotion:'reduce'});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  await p.click('[data-id="lang:toggle"]'); await p.waitForTimeout(600);
  const d=await p.evaluate(()=>window.__stage.diag());
  ok('reduced motion: the switch lands', d.lang==='zh' && d.quads>0, JSON.stringify(d));
  ok('reduced motion: no errors', errs.length===0, errs[0]||'');
  await p.screenshot({path:`${OUT}/reduced.png`});
  await b.close();
}

/* --- 3. no WebGL ---------------------------------------------------------- */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800}});
  await ctx.addInitScript(()=>{ HTMLCanvasElement.prototype.getContext = function(){ return null; }; });
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  /* There is nothing to fall back to any more. The contract is only that it
     fails quietly: no crash, no half-drawn canvas, and still no text. */
  ok('no-WebGL: fails without an error', errs.length===0, errs[0]||'');
  ok('no-WebGL: the canvas is removed', (await p.$('#stage'))===null);
  ok('no-WebGL: still no readable text', ((await p.textContent('body'))||'').trim()==='');
  await p.screenshot({path:`${OUT}/no-webgl.png`, fullPage:true});
  await b.close();
}

/* --- 4. localStorage blocked --------------------------------------------- */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800}});
  await ctx.addInitScript(()=>{ Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}}); });
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  const d=await p.evaluate(()=>window.__stage ? window.__stage.diag() : null);
  ok('localStorage blocked: still boots', !!d, JSON.stringify(d));
  ok('localStorage blocked: no errors', errs.length===0, errs[0]||'');
  await b.close();
}

/* --- 5. no Intl.Segmenter ------------------------------------------------- */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800}});
  await ctx.addInitScript(()=>{ delete Intl.Segmenter; });
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  const d=await p.evaluate(()=>window.__stage ? window.__stage.diag() : null);
  ok('no Intl.Segmenter: still boots', !!d && d.overflow===0, JSON.stringify(d));
  ok('no Intl.Segmenter: no errors', errs.length===0, errs[0]||'');
  await b.close();
}

/* --- 6. tiny + huge viewports and a resize storm -------------------------- */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:320,height:480},deviceScaleFactor:2});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  let d=await p.evaluate(()=>window.__stage.diag());
  ok('320x480 lays out', d.cols===1 && d.overflow===0, JSON.stringify(d));
  await p.screenshot({path:`${OUT}/320.png`});
  for (const w of [360,420,700,760,1100,1300,1700,2400,900,500]) { await p.setViewportSize({width:w,height:700}); await p.waitForTimeout(60); }
  await p.waitForTimeout(900);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('survives a resize storm', d.overflow===0 && d.quads>0, JSON.stringify(d));
  ok('resize storm: no errors', errs.length===0, errs.slice(0,2).join(' | '));
  await b.close();
}

/* --- 7. WebGL context loss and restore ------------------------------------ */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  const lost=await p.evaluate(()=>{ const gl=document.getElementById('stage').getContext('webgl'); const ext=gl.getExtension('WEBGL_lose_context'); if(!ext) return 'no-ext'; ext.loseContext(); setTimeout(()=>ext.restoreContext(),300); return 'ok'; });
  await p.waitForTimeout(2500);
  const d=await p.evaluate(()=>window.__stage ? window.__stage.diag() : null);
  ok('context loss then restore recovers', lost==='no-ext' || (d && d.quads>0), JSON.stringify({lost,d}));
  ok('context loss: no errors', errs.length===0, errs[0]||'');
  await b.close();
}

/* --- 8. scripting disabled ------------------------------------------------ */
{
  const b=await chromium.launch({...LAUNCH,args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},javaScriptEnabled:false});
  const p=await ctx.newPage();
  await p.goto(URL,{waitUntil:'load'});
  ok('no JS: the page renders without an error', (await p.$('body'))!==null);
  ok('no JS: it carries no readable text', ((await p.textContent('body'))||'').trim()==='');
  await p.screenshot({path:`${OUT}/no-js.png`, fullPage:true});
  await b.close();
}

/* --- 9. no readable text ships -------------------------------------------- */
{
  /* The premise of the whole site. Every string is drawn into a canvas by the
     GPU so the page cannot be read by an index, and the premise is undone by
     one <title>, one meta description, one inlined accessibility mirror or one
     JSON literal left in the bundle. Each of those was there and each was
     removed; this is what stops them coming back.

     Read the BUILT files off disk rather than through the browser, because
     what matters is the bytes the server sends. */
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const html = read('index.html');
  const js = read('js/main.js');
  const notfound = read('404.html');

  /* Words from content.json that must not survive anywhere. Not an exhaustive
     list - an exhaustive list is what the encoder is for - but each of these
     was a real leak at some point in this file's history. */
  const CONTENT = ['Josephine', 'Shen', 'proton.me', 'Berlin', 'Geopolitics',
    'Ontological', 'AIxist', 'Machine learning', 'policy researcher'];
  const leaks = (src, where) => CONTENT.filter((w) => src.toLowerCase().includes(w.toLowerCase()))
    .map((w) => `${where}:${w}`);

  ok('the served HTML carries no content', leaks(html, 'index').length === 0, leaks(html, 'index').join(' '));
  ok('the 404 page carries no content', leaks(notfound, '404').length === 0, leaks(notfound, '404').join(' '));
  /* The bundle is the one that regressed silently: @rollup/plugin-json used to
     inline content.json verbatim, so dist/js/main.js opened with her name. */
  ok('the bundle carries no content literals', leaks(js, 'bundle').length === 0, leaks(js, 'bundle').join(' '));
  /* The title is the one head element that survived, and it survived only
     because it is not made of words: it must be block glyphs end to end, with
     no Latin, no Han and no punctuation an index could tokenise. */
  {
    const t = (html.match(/<title>([^<]*)<\/title>/) || ['', ''])[1];
    ok('the served title is glyphs only, no language',
      t.length === 32 && /^[\u2580-\u259F]+$/.test(t), JSON.stringify(t));
  }
  ok('robots noindex is in the served head', /name="robots"[^>]*noindex/.test(html));
  /* Advisory, but it is the half that actually keeps a bare URL out of a
     result page - and it must NOT be paired with a robots.txt Disallow, which
     would stop the crawler ever reading it. */
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'vercel.json'), 'utf8'));
  ok('X-Robots-Tag covers every response',
    vercel.headers.some((h) => h.source === '/(.*)'
      && h.headers.some((x) => x.key === 'X-Robots-Tag' && /noindex/.test(x.value))));
  ok('there is no robots.txt to block the crawl that reads it',
    !fs.existsSync(path.join(ROOT, 'robots.txt')));
}

server.close();
console.log(results.join('\n'));
const failures = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failures} failures of ${results.length}`);
process.exit(failures ? 1 : 0);
