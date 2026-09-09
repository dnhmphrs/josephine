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

const DPR_CAP = 2;
/* The ground drifts about 0.005px a frame, so redrawing it sixty times a
   second buys nothing but heat. Five is indistinguishable, and scroll,
   pointer and transitions all set `dirty` and redraw immediately anyway. */
const IDLE_FRAME_MS = 200;

const canvas = document.getElementById('stage');
const proxy = document.getElementById('scroll');
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

  function relayout() {
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
      relayout();
      return;
    }

    syncProxy();
    syncHits();
    state.dirty = true;
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
    relayout();
  }

  /* One control, one action. The scene records which language the toggle would
     switch TO, so nothing here has to know how many languages there are or
     which half of the mark was pressed. */
  function act(id) {
    if (id !== 'lang:toggle') return;
    const el = proxy.querySelector('[data-id="lang:toggle"]');
    setLang((el && el.dataset.other) || (state.lang === 'en' ? 'zh' : 'en'));
  }

  /* --- the hit layer ------------------------------------------------------
     Real elements, absolutely positioned in content coordinates inside the
     scroll proxy, so they scroll with the document and no scrollY arithmetic
     exists anywhere in the interaction path. */

  function syncHits() {
    const hits = state.scene.hits;
    while (proxy.children.length > hits.length) proxy.removeChild(proxy.lastChild);
    hits.forEach((h, i) => {
      let el = proxy.children[i];
      const tag = h.href ? 'a' : 'button';
      if (!el || el.tagName.toLowerCase() !== tag) {
        const next = document.createElement(tag);
        next.className = 'hit';
        if (el) proxy.replaceChild(next, el);
        else proxy.appendChild(next);
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

  proxy.addEventListener('click', (e) => {
    const el = e.target.closest('.hit');
    if (el && el.tagName === 'BUTTON') act(el.dataset.id);
  });
  proxy.addEventListener('pointerover', (e) => {
    const el = e.target.closest('.hit');
    const key = el ? el.dataset.key : null;
    if (key !== state.hover) { state.hover = key || null; state.dirty = true; }
  });
  proxy.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.hit')) {
      if (state.hover) { state.hover = null; state.dirty = true; }
    }
  });
  /* The focus ring is drawn on the canvas, because that is where the thing
     being focused visually lives. :focus-visible keeps it off a mouse click. */
  proxy.addEventListener('focusin', (e) => {
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
  proxy.addEventListener('focusout', () => { state.focus = null; state.dirty = true; });

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
    relayout();
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
    resizeTimer = setTimeout(relayout, 120);
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

    marks.clear();
    drawScene(marks, state.scene, 1, state.hover);

    if (state.focus) {
      const h = state.scene.hits.find((x) => x.id === state.focus);
      if (h) marks.strokeRect(h.x - 4, h.y - 4, h.w + 8, h.h + 8, 2, INK, 0.85);
    }

    const time = reduced.matches ? 0 : (now - t0) / 1000;
    stage.render(marks, engine.texture, time, scrollY);
  }

  relayout();
  requestAnimationFrame(frame);

  /* The other language's faces follow without blocking anything, so that the
     toggle - which re-lays out and re-rasterises on the spot - has them in
     memory before it is ever pressed. Without this the first press of 中 would
     set the whole page in a fallback face for as long as a download takes,
     inside the one transition that is supposed to be instantaneous. */
  loadFonts(deferredFontSpecs(content, innerWidth, state.lang)).then(relayout).catch(() => {});

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
      key: i.key, text: i.run.text,
      x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.run.width),
    })),
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
