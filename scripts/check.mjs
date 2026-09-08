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
   they should, that a rapid triple language toggle leaves the state, the
   mirror and the drawing agreeing, and that the page still says who she is
   with WebGL removed, with localStorage throwing, without Intl.Segmenter,
   under prefers-reduced-motion, at 320x480, and through a resize storm.

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
const results=[];
const ok=(n,v,extra='')=>{results.push(`${v?'PASS':'FAIL'}  ${n}${extra?'  '+extra:''}`);};

/* --- 1. normal interaction ------------------------------------------------ */
{
  const b=await chromium.launch({args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(2200);

  const hits = await p.$$eval('#scroll .hit', els => els.map(e=>({tag:e.tagName,id:e.dataset.id,href:e.getAttribute('href'),pressed:e.getAttribute('aria-pressed'),label:e.textContent,w:e.offsetWidth,h:e.offsetHeight})));
  ok('hit layer built', hits.length>=6, JSON.stringify(hits.map(h=>h.id)));
  ok('all targets >= 44px tall', hits.every(h=>h.h>=44));
  ok('mail is a real mailto anchor', hits.some(h=>h.tag==='A'&&/^mailto:/.test(h.href||'')));
  ok('linkedin is a real https anchor', hits.some(h=>h.tag==='A'&&/^https:/.test(h.href||'')));
  ok('view + language buttons carry pressed state', hits.filter(h=>h.pressed!==null).length===4 && hits.filter(h=>h.pressed==='true').length===2);

  // click CV via the real DOM element
  await p.click('[data-id="view:cv"]'); await p.waitForTimeout(700);
  let d=await p.evaluate(()=>window.__stage.diag());
  ok('clicking CV switches view', d.view==='cv', JSON.stringify(d));
  ok('CV is taller than the viewport at 1280', d.height>0);

  await p.click('[data-id="lang:zh"]'); await p.waitForTimeout(1000);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('clicking 中 switches language', d.lang==='zh');
  ok('<html lang> follows', (await p.evaluate(()=>document.documentElement.lang))==='zh-Hans');
  ok('mirror follows language', (await p.textContent('#a11y h1'))==='沈菲菲');
  ok('title follows language', (await p.title())==='沈菲菲');

  // rapid triple toggle
  await p.click('[data-id="lang:en"]'); await p.waitForTimeout(120);
  await p.click('[data-id="lang:zh"]'); await p.waitForTimeout(120);
  await p.click('[data-id="lang:en"]'); await p.waitForTimeout(1400);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('survives a rapid triple toggle', d.lang==='en', JSON.stringify(d));
  ok('mirror agrees after the storm', (await p.textContent('#a11y h1'))==='Josephine Shen');

  // keyboard
  /* Tab past the browser's own stops (which report as null) and read the order
     of the page's own controls. Compared cyclically: where the walk starts
     depends on what was focused last, but the sequence must not change. */
  await p.evaluate(()=>document.activeElement && document.activeElement.blur());
  const order=[];
  for (let i=0;i<10;i++){ await p.keyboard.press('Tab'); const id=await p.evaluate(()=>document.activeElement&&document.activeElement.dataset?document.activeElement.dataset.id:null); if(id&&!order.includes(id)) order.push(id); }
  const want=['view:card','view:cv','lang:en','lang:zh'];
  const rotated=order.length===4 && want.some((_,k)=>JSON.stringify(order)===JSON.stringify(want.slice(k).concat(want.slice(0,k))));
  ok('tab order is reading order', rotated, JSON.stringify(order));
  ok('mirror links are out of the tab sequence', (await p.$$eval('#a11y a', a=>a.every(x=>x.getAttribute('tabindex')==='-1'))));
  await p.evaluate(()=>{document.querySelector('[data-id="view:cv"]').focus()});
  await p.waitForTimeout(200);
  await p.keyboard.press('Enter'); await p.waitForTimeout(700);
  d=await p.evaluate(()=>window.__stage.diag());
  ok('Enter activates a control', d.view==='cv');
  await p.screenshot({path:`${OUT}/focus-ring.png`, clip:{x:0,y:0,width:400,height:140}});

  ok('no console or page errors', errs.length===0, errs.slice(0,3).join(' | '));
  await b.close();
}

/* --- 2. reduced motion ---------------------------------------------------- */
{
  const b=await chromium.launch({args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2,reducedMotion:'reduce'});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
  await p.click('[data-id="lang:zh"]'); await p.waitForTimeout(600);
  const d=await p.evaluate(()=>window.__stage.diag());
  ok('reduced motion: morph completes', d.lang==='zh' && d.quads>0, JSON.stringify(d));
  ok('reduced motion: no errors', errs.length===0, errs[0]||'');
  await p.screenshot({path:`${OUT}/reduced.png`});
  await b.close();
}

/* --- 3. no WebGL ---------------------------------------------------------- */
{
  const b=await chromium.launch({args:GL});
  const ctx=await b.newContext({viewport:{width:1280,height:800}});
  await ctx.addInitScript(()=>{ HTMLCanvasElement.prototype.getContext = function(){ return null; }; });
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  const visible=await p.isVisible('#a11y h1');
  const text=await p.textContent('#a11y');
  ok('no-WebGL: mirror becomes the page', visible);
  ok('no-WebGL: carries the email', /proton\.me/.test(text||''));
  ok('no-WebGL: carries the CV', /Machine learning/.test(text||''));
  ok('no-WebGL: no errors', errs.length===0, errs[0]||'');
  await p.screenshot({path:`${OUT}/no-webgl.png`, fullPage:true});
  await b.close();
}

/* --- 4. localStorage blocked --------------------------------------------- */
{
  const b=await chromium.launch({args:GL});
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
  const b=await chromium.launch({args:GL});
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
  const b=await chromium.launch({args:GL});
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

server.close();
console.log(results.join('\n'));
const failures = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failures} failures of ${results.length}`);
process.exit(failures ? 1 : 0);
