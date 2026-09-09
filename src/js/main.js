/* ===========================================================================
   Josephine Shen - entry point.

   Wires the three pieces together and owns the one piece of state the whole
   site has: which language you are reading.

     content.json  ->  layout.js   builds the scene
     text.js       ->  rasterises every run into one atlas texture
     gl.js         ->  draws the ground and the marks

   One page, and nothing on it animates except the ground. The language toggle
   is a cut.

   Everything visible is on the canvas, and this build ships NO readable text
   anywhere else - no title, no description, no accessible mirror. That is a
   deliberate decision by the owner and it has a real cost, set out in the
   README. What remains in the DOM is one invisible layer: real anchors and
   buttons positioned over the marks they stand for, so that Tab order, Enter,
   the pointer cursor, mailto: context menus and cmd-click all work because the
   browser is doing them and not because we reimplemented them. They carry no
   labels, which is part of the same decision.
   =========================================================================== */

/* content.json does not arrive as an object. The build XORs and base64s it
   (see rollup.config.mjs) so that no string on this site survives as a
   literal in the shipped bundle - the whole point of drawing the page into a
   canvas is undone if the same sentences sit in plain sight three files
   later. This is obfuscation and nothing stronger: the key is one line above
   the payload. It defeats grep and a text-extracting crawler, which is the
   threat it was chosen for. */
import payload from '../content/content.json';
import '../styles/main.css';
import { TextEngine, loadFonts } from './text.js';
import { createStage, Marks, drawScene } from './gl.js';
import { buildScene, fontSpecs, deferredFontSpecs, INK } from './layout.js';

const content = JSON.parse(new TextDecoder().decode(
  Uint8Array.from(atob(payload), (ch, i) => ch.charCodeAt(0) ^ ((0x5a + (i & 31)) & 255)),
));

/* ---- the redaction, OFF by default -----------------------------------------
   The page ships with nothing redacted. The machinery below is complete, it is
   audited by the check suite, and it is one query parameter away - but the
   resting page is a document, not a document being declassified, and the owner
   chose the document.

   It exists at all because every glyph here is already a graphic on the same
   plane as the sheet, so a bar of ink and a line of type are the same kind of
   object and can be cut against each other exactly. In the DOM this is a div
   stacked over a paragraph; here it is one buffer, and a run that is partway
   open is a partial-UV quad plus a rectangle.

   A SEAL - one CV entry, one section name, the pair of links in the footer -
   arrives under a bar and releases when it is comfortably inside the window.

   Three parameters, and they are parameters because the behaviour is a matter
   of taste rather than of correctness. Set any of them from the URL -
   ?reveal=on | once | repeat | off, and ?load=0 | 1 - which is how they were
   audited and how they can be audited again.

     on      whether anything is ever redacted at all. FALSE here.
     onLoad  whether the first screen arrives sealed and opens, or is simply
             already open on the first frame. With it off, the page begins
             finished and the redaction is something you meet by going deeper.
     repeat  whether a seal re-closes once it is well outside the window, so
             that every arrival is a reveal rather than only the first.

   What none of them can turn off is the guarantee that a STOPPED page is
   legible: a seal only ever closes far outside the window, so there is no
   scroll position at which something visible stays hidden.

   Reduced motion opens everything on the first layout, everywhere, and nothing
   here ever moves again. */
const REVEAL = { on: false, onLoad: true, repeat: true, ms: 620, lead: 0.15 };
try {
  /* The query string is the control. `window.__reveal` is the same string by
     another route, and exists for one reason: the single-file previews open
     from file://, where a reader cannot add a query to the URL and where
     history.replaceState is not reliably allowed. Nothing in the shipped site
     sets it. */
  const q = new URLSearchParams(location.search);
  const r = q.get('reveal') || window.__reveal;
  if (r === 'off') REVEAL.on = false;
  else if (r === 'on') REVEAL.on = true;
  else if (r === 'once') { REVEAL.on = true; REVEAL.repeat = false; }
  else if (r === 'repeat') { REVEAL.on = true; REVEAL.repeat = true; }
  const l = q.get('load') || window.__load;
  if (l === '0') REVEAL.onLoad = false;
  if (l === '1') REVEAL.onLoad = true;
} catch (e) { /* no URL, no overrides */ }

/* seal key -> the moment it starts opening, or -1 for "open, no animation". */
const revealed = new Map();

const DPR_CAP = 2;
/* The ground drifts about 0.005px a frame, so redrawing it sixty times a
   second buys nothing but heat. Five is indistinguishable, and scroll,
   pointer and transitions all set `dirty` and redraw immediately anyway. */
const IDLE_FRAME_MS = 200;

const canvas = document.getElementById('stage');
const proxy = document.getElementById('scroll');
const fixedLayer = document.getElementById('fixed');
const svhProbe = document.getElementById('svh');
const safeProbe = document.getElementById('safe');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  lang: 'en',
  scene: null,
  grid: null,
  lost: false,
  dirty: true,
  lastDraw: 0,
  hover: null,
  focus: null,
  vw: 0,
  vhStable: 0,
  dprCap: DPR_CAP,
};

try {
  const saved = localStorage.getItem('lang');
  if (saved === 'zh' || saved === 'en') state.lang = saved;
} catch (e) { /* private mode: English it is */ }

document.documentElement.lang = state.lang === 'zh' ? 'zh-Hans' : 'en';

const stage = createStage(canvas);
/* boot() is async and everything after the context exists runs inside it - the
   atlas allocation, a 2048px texture upload, the first layout. Any of those
   throwing on a low-memory device would otherwise leave a blank grey rectangle
   and no way back. */
if (!stage) fallback();
else boot(stage).catch(fallback);

/* No WebGL, or a context we could not create. There is nothing to fall back
   TO any more - the mirror that used to become the page here was the text this
   build exists not to publish - so this clears the canvas and leaves bare
   ground. Rare, and the cost of the decision. */
function fallback() {
  document.documentElement.classList.add('no-js');
  if (canvas) canvas.remove();
  if (proxy) proxy.remove();
}

async function boot(stage) {
  const engine = new TextEngine(stage.gl);
  const marks = new Marks(engine);

  /* Rasterising before the webfonts arrive would bake the fallback face into
     the atlas, so the first layout waits - but only on the language actually
     being read. The concrete is already painted by CSS underneath, so the wait
     reads as a beat, not a blank. */
  /* Raced against a deadline. DOM text gets a fallback face after the browser's
     block period; a canvas gets nothing, so a font request that stalls rather
     than fails would hold the page at blank concrete indefinitely. If the
     deadline wins, the first layout uses whatever is available and the deferred
     pass below re-rasterises when the real faces land. */
  await Promise.race([
    loadFonts(fontSpecs(content, innerWidth, state.lang)),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  /* --- layout ------------------------------------------------------------ */

  /* cut = "this layout is a cut, not an arrival": the language switch, a
     resize, a restored context. Everything already in the window counts as
     read, so nothing re-seals under the reader and the switch is finished on
     the frame it lands. Called with nothing, it is an arrival, and whether
     that plays the reveal is REVEAL.onLoad's decision. */
  function relayout(cut) {
    const dpr = Math.min(devicePixelRatio || 1, state.dprCap);
    const box = stage.resize(...viewport(), dpr);
    state.vw = box.cssW;
    state.vhStable = stableHeight();
    const safeTop = safeProbe ? safeProbe.offsetHeight : 0;

    engine.reset(dpr);
    const built = buildScene(engine, content, state.vw, state.vhStable, state.lang, safeTop);
    const atlas = engine.build();
    state.scene = built.scene;
    state.grid = built.grid;

    /* Atlas overflow means the page needs more texture than this GPU will give
       us. One lever, not a multi-atlas state machine: halve the resolution and
       lay out again. */
    if (atlas.overflow && state.dprCap > 1) {
      state.dprCap = 1;
      relayout(cut);
      return;
    }

    syncProxy();
    syncHits();
    /* The seal map is NOT cleared here. Seal keys are stable across layouts,
       and the one relayout nobody asked for - the deferred faces landing, a
       tenth of a second in - would otherwise cut the arrival short by
       re-arming everything instantly. Carrying the map means an animation
       in flight survives the swap, and a seal already read stays read. */
    arm(cut === undefined ? !REVEAL.onLoad : true);
    state.dirty = true;
  }

  /* Open every seal that has come far enough into the window, and - in repeat
     mode - re-close the ones that have left it entirely.

     The threshold rides up at the end of the document. A line held at a fixed
     fraction of the window is a trap: at maximum scroll the last screenful
     sits below it and can never cross it, so the footer - the address, the one
     thing a visitor came for - would stay under a bar forever. So the line is
     never further from the bottom of the window than there is scrolling left
     to do, and a document shorter than the window is open on arrival. */
  function arm(instant) {
    if (!state.scene) return;
    const still = reduced.matches || !REVEAL.on;
    if (still) {
      for (const b of state.scene.seals) revealed.set(b.key, -1);
      return;
    }
    /* innerHeight, not the stable height: this has to agree with where the
       browser will actually clamp the scroll. */
    const vh = innerHeight;
    const top = scrollY;
    const bottom = top + vh;
    const slack = Math.max(0, Math.ceil(state.scene.height) - vh - top);
    const lead = Math.min(vh * REVEAL.lead, slack);
    const now = performance.now();
    for (const b of state.scene.seals) {
      const open = revealed.has(b.key);
      if (open) {
        /* A cut flattens whatever is still moving: after a language switch
           there must be nothing left animating, which is what makes the
           switch instantaneous rather than merely fast. */
        if (instant) { revealed.set(b.key, -1); continue; }
        /* Re-close only well outside the window, and only in repeat mode. A
           seal that closed at the edge would be seen doing it. */
        if (REVEAL.repeat && (b.top < top - vh * 0.6 || b.top > bottom + vh * 0.35)) revealed.delete(b.key);
        continue;
      }
      if (b.top > bottom - lead || b.top < top - vh * 0.6) continue;
      revealed.set(b.key, instant ? -1 : now + b.delay);
    }
  }

  /* How many CSS pixels there actually are to draw into.

     The canvas is position:fixed with inset:0, so its own box is the authority
     and neither obvious alternative is. innerWidth INCLUDES a classic desktop
     scrollbar that the box excludes, so sizing the drawing buffer from it makes
     the buffer wider than the element and the whole page is silently rescaled
     the moment the CV view introduces a scrollbar. visualViewport.height is the
     zoomed, visible region, which shrinks under pinch-zoom while a fixed
     element's box does not. Measure the element. */
  function viewport() {
    return [canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight];
  }

  /* The SMALL viewport height - what is available with the browser chrome at
     its largest. LAYOUT uses this, so the opening is guaranteed to fill the
     worst case and never jitters as the iOS bars animate in and out. */
  function stableHeight() {
    return (svhProbe && svhProbe.offsetHeight) || innerHeight;
  }

  function syncProxy() {
    proxy.style.height = `${Math.ceil(state.scene.height)}px`;
  }

  /* --- language ----------------------------------------------------------- */

  /* A cut, and a whole re-layout to make it: only the language being read is
     in the atlas, so this measures, rasterises and re-uploads the other one.
     That is exactly the work a window resize already does, it happens inside
     the click, and it lands on the next frame - which is the only thing a cut
     has to promise. Keeping both languages in the texture would save nothing a
     reader could perceive and cost twice the atlas.

     The document does change height under them - the Chinese page is shorter
     than the English one - and the browser will clamp a scroll past the new
     end. That is correct: the page really is that length now. */
  function setLang(next) {
    if (next === state.lang || !state.scene) return;
    state.lang = next;
    document.documentElement.lang = next === 'zh' ? 'zh-Hans' : 'en';
    try { localStorage.setItem('lang', next); } catch (e) { /* ignore */ }
    relayout(true);
  }

  /* One control, one action. The scene records which language the toggle would
     switch TO, so nothing here has to know how many languages there are or
     which half of the mark was pressed. */
  function act(id) {
    if (id !== 'lang:toggle') return;
    const el = document.querySelector('.hit[data-id="lang:toggle"]');
    setLang((el && el.dataset.other) || (state.lang === 'en' ? 'zh' : 'en'));
  }

  /* --- the hit layer ------------------------------------------------------
     Real elements, absolutely positioned in content coordinates inside the
     scroll proxy, so they scroll with the document and no scrollY arithmetic
     exists anywhere in the interaction path.

     Marks drawn viewport-anchored (scene: fixed) get the same treatment in
     #fixed instead, where their coordinates are already viewport coordinates
     and position:fixed does the tracking. Two containers, one routine: the
     only difference between them is which one an element is appended to.

     Tab order follows DOM order, so the fixed container sits after the proxy
     in the document and the toggle is the last stop rather than the first.
     That is the right end for it: the reading order is the page, then the
     control that changes the page's language. */

  function syncHits() {
    const all = state.scene.hits;
    sync(proxy, all.filter((h) => !h.fixed));
    sync(fixedLayer, all.filter((h) => h.fixed));
  }

  function sync(root, hits) {
    while (root.children.length > hits.length) root.removeChild(root.lastChild);
    hits.forEach((h, i) => {
      let el = root.children[i];
      const tag = h.href ? 'a' : 'button';
      if (!el || el.tagName.toLowerCase() !== tag) {
        const next = document.createElement(tag);
        next.className = 'hit';
        if (el) root.replaceChild(next, el);
        else root.appendChild(next);
        el = next;
      }
      el.dataset.id = h.id;
      el.dataset.key = h.key || '';
      if (h.other) el.dataset.other = h.other; else delete el.dataset.other;
      el.style.left = `${h.x}px`;
      el.style.top = `${h.y}px`;
      el.style.width = `${h.w}px`;
      el.style.height = `${h.h}px`;
      if (h.href) {
        el.setAttribute('href', h.href);
        if (h.href.startsWith('http')) { el.target = '_blank'; el.rel = 'me noopener'; }
      } else {
        el.type = 'button';
        if (h.pressed !== undefined) el.setAttribute('aria-pressed', String(h.pressed));
      }
      if (h.lang) el.setAttribute('lang', h.lang);
    });
  }

  [proxy, fixedLayer].forEach((root) => bindHits(root));

  function bindHits(root) {
    root.addEventListener('click', (e) => {
      const el = e.target.closest('.hit');
      if (el && el.tagName === 'BUTTON') act(el.dataset.id);
    });
    root.addEventListener('pointerover', (e) => {
      const el = e.target.closest('.hit');
      const key = el ? el.dataset.key : null;
      if (key !== state.hover) { state.hover = key || null; state.dirty = true; }
    });
    root.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.hit')) {
        if (state.hover) { state.hover = null; state.dirty = true; }
      }
    });
    /* The focus ring is drawn on the canvas, because that is where the thing
       being focused visually lives. :focus-visible keeps it off a mouse click. */
    root.addEventListener('focusin', (e) => {
      const el = e.target.closest('.hit');
      /* Element.matches() THROWS on a selector the engine cannot parse - it is
         not a silent false - and the canvas ring is the only focus indicator
         there is, since the native outline is removed. On an engine without
         :focus-visible, treat every focus as keyboard focus. */
      let keyboard = true;
      try { keyboard = el ? el.matches(':focus-visible') : false; } catch (err) { keyboard = !!el; }
      state.focus = keyboard && el ? el.dataset.id : null;
      state.dirty = true;
    });
    root.addEventListener('focusout', () => { state.focus = null; state.dirty = true; });
  }

  /* --- viewport ----------------------------------------------------------- */

  /* A lost context takes every GL object with it, and unless the event is
     cancelled the browser is spec-bound never to offer it back - the page would
     be a permanently blank grey rectangle. Cancel it, stop drawing, and rebuild
     when the browser returns; if it does not come back, give up and clear the
     canvas rather than leave a frozen half-drawn page on screen. */
  let lostTimer = 0;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    state.lost = true;
    lostTimer = setTimeout(() => { if (state.lost) fallback(); }, 5000);
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    clearTimeout(lostTimer);
    state.lost = false;
    stage.restore();
    engine.restore();
    relayout(true);
  }, false);

  addEventListener('scroll', () => { state.dirty = true; }, { passive: true });

  let resizeTimer = 0;
  function onResize() {
    /* Collapsing the iOS URL bar fires resize and changes the live height by
       60-90px. Rebuilding the whole atlas mid-scroll for that is the bug, so
       the buffer is resized on every event and the LAYOUT only when something
       it depends on has actually changed: the width, the small-viewport height,
       or the pixel ratio (dragging the window to a display with a different
       one, which leaves the atlas rasterised for the old screen). */
    const dpr = Math.min(devicePixelRatio || 1, state.dprCap);
    const [w, h] = viewport();
    stage.resize(w, h, dpr);
    state.dirty = true;
    if (Math.abs(w - state.vw) < 1
      && Math.abs(stableHeight() - state.vhStable) < 2
      && dpr === engine.dpr) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(true), 120);
  }
  addEventListener('resize', onResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onResize, { passive: true });
  }

  if (reduced.addEventListener) reduced.addEventListener('change', () => { state.dirty = true; });

  /* --- the loop ---------------------------------------------------------- */

  const t0 = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || state.lost || !state.scene) return;

    if (!state.dirty && now - state.lastDraw < IDLE_FRAME_MS) return;
    if (reduced.matches && !state.dirty) return;
    state.lastDraw = now;
    state.dirty = false;

    arm(false);

    let moving = false;

    marks.clear();
    /* Cubic ease out: fast off the mark and long in the settle, which is how a
       mask drawn back behaves and is the opposite of a fade. A seal still
       moving keeps the page dirty, so the loop runs at frame rate for exactly
       as long as something is resolving and drops back to one frame in five
       the moment it stops. */
    drawScene(marks, state.scene, 1, state.hover, (key) => {
      const start = revealed.get(key);
      if (start === undefined) return 0;
      if (start < 0) return 1;
      const t = (now - start) / REVEAL.ms;
      if (t <= 0) { moving = true; return 0; }
      if (t >= 1) return 1;
      moving = true;
      return 1 - Math.pow(1 - t, 3);
    }, scrollY);
    if (moving) state.dirty = true;

    /* The ring is a mark like any other, so it is drawn in scene coordinates
       and the renderer's scroll translation applies to it. A fixed hit's box
       is already in viewport coordinates, so scrollY goes back in first -
       the same correction drawScene makes for the marks it belongs to. */
    if (state.focus) {
      const h = state.scene.hits.find((x) => x.id === state.focus);
      if (h) {
        const fy = h.fixed ? h.y + scrollY : h.y;
        marks.strokeRect(h.x - 4, fy - 4, h.w + 8, h.h + 8, 2, INK, 0.85);
      }
    }

    const time = reduced.matches ? 0 : (now - t0) / 1000;
    /* The wash is a gradient across the DOCUMENT, so the renderer needs its
       length as well as the scroll. */
    stage.render(marks, engine.texture, time, scrollY, state.scene.height);
  }

  relayout();
  requestAnimationFrame(frame);

  /* The other language's faces follow without blocking anything, so that the
     toggle - which re-lays out and re-rasterises on the spot - has them in
     memory before it is ever pressed. Without this the first press of 中 would
     set the whole page in a fallback face for as long as a download takes,
     inside the one transition that is supposed to be instantaneous. */
  loadFonts(deferredFontSpecs(content, innerWidth, state.lang)).then(() => relayout()).catch(() => {});

  /* The test surface. scripts/check.mjs drives the built site through this,
     because there is no other way to ask a canvas what it is showing. Kept
     small and read-only; `act` is the same function the hit layer calls. */
  window.__stage = {
    act,
    toggleLang: () => act('lang:toggle'),
    diag: () => ({
      lang: state.lang, cols: state.grid.cols, dpr: engine.dpr,
      atlas: `${engine.atlas.width}x${engine.atlas.height}`, overflow: engine.overflow,
      quads: marks.count, height: Math.round(state.scene.height),
    }),
    grid: () => ({ ...state.grid, colX: undefined }),
    /* Every placed run, for checking that nothing overflows its column. */
    items: () => state.scene.items.filter((i) => i.kind === 'text').map((i) => ({
      key: i.key, text: i.run.text, seal: i.seal || null, fixed: !!i.fixed,
      x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.run.width),
    })),
    /* The redaction, as the renderer sees it: the parameters in force and, per
       seal, how far open it is right now - 0 fully barred, 1 fully drawn, -1
       never barred at all. The checks read this rather than pixels, because
       the difference between "reveals on load" and "reveals on scroll" is a
       difference in when a key enters this map and nothing else. */
    reveal: () => ({
      ...REVEAL,
      seals: Object.fromEntries(state.scene.seals.map((b) => {
        const start = revealed.get(b.key);
        if (start === undefined) return [b.key, 0];
        if (start < 0) return [b.key, -1];
        return [b.key, Math.min(1, Math.max(0, (performance.now() - start) / REVEAL.ms))];
      })),
    }),
    /* The atlas itself, as a PNG data URL - the fastest way to tell whether a
       packing or rasterisation bug is in the texture or in the draw. */
    atlas: () => engine.atlas.toDataURL('image/png'),
    /* Every run reserved in the current atlas, in DEVICE px. The companion to
       atlas(): one run wider than the texture forces the packer to the next
       size and quadruples the memory, and this is the only way to see which
       run it was. */
    runs: () => engine.pending.map((r) => ({ w: r.devW, h: r.devH, text: r.text })),
  };
}
