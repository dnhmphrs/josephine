/* ===========================================================================
   Josephine Shen - entry point.

   Wires the four pieces together and owns the two bits of state the whole site
   has: which view you are on, and which language you are reading.

     content.json  ->  layout.js   builds four scenes (card/cv x en/zh)
     text.js       ->  rasterises every run into one atlas texture
     morph.js      ->  interpolates between two scenes
     gl.js         ->  draws the ground and the marks

   Everything visible is on the canvas. Two invisible DOM layers keep the page
   an actual document rather than a picture of one: a mirror of every string,
   for screen readers, crawlers and the no-WebGL path; and a layer of real
   anchors and buttons positioned over the marks they stand for, so that Tab
   order, Enter, the pointer cursor, mailto: context menus and cmd-click all
   work because the browser is doing them, not because we reimplemented them.
   =========================================================================== */

import content from '../content/content.json';
import '../styles/main.css';
import { TextEngine, loadFonts } from './text.js';
import { createStage, Marks } from './gl.js';
import { buildScenes, fontSpecs, deferredFontSpecs, INK } from './layout.js';
import { planLanguage, planView, drawScene, drawPlan, TIMING } from './morph.js';
import { renderMirror } from './mirror.js';

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
  view: 'card',
  lang: 'en',
  scenes: null,
  grid: null,
  transition: null,
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

/* No WebGL, or a context we could not create: promote the mirror to the
   visible page. Rare, but a researcher's contact details should not depend on
   a GPU. */
function fallback() {
  document.documentElement.classList.add('no-js');
  updateMirror(state.lang);
  if (canvas) canvas.remove();
  if (proxy) proxy.remove();
}

async function boot(stage) {
  const engine = new TextEngine(stage.gl);
  const marks = new Marks(engine);

  updateMirror(state.lang, true);

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

  const scene = () => state.scenes[`${state.view}:${state.lang}`];

  /* --- layout ------------------------------------------------------------ */

  function relayout() {
    const dpr = Math.min(devicePixelRatio || 1, state.dprCap);
    const box = stage.resize(...viewport(), dpr);
    state.vw = box.cssW;
    state.vhStable = stableHeight();
    const safeTop = safeProbe ? safeProbe.offsetHeight : 0;

    engine.reset(dpr);
    const built = buildScenes(engine, content, state.vw, state.vhStable, safeTop);
    const atlas = engine.build();
    state.scenes = built.scenes;
    state.grid = built.grid;
    state.transition = null;

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
     its largest. LAYOUT uses this, so the card is guaranteed to fit in the
     worst case and never jitters as the iOS bars animate in and out. */
  function stableHeight() {
    return (svhProbe && svhProbe.offsetHeight) || innerHeight;
  }

  function syncProxy() {
    proxy.style.height = `${Math.ceil(scene().height)}px`;
  }

  /* --- transitions ------------------------------------------------------- */

  function begin(plan, kind, opts = {}) {
    state.transition = {
      plan, kind, ms: 0, dir: 1,
      duration: reduced.matches ? TIMING.DURATION_REDUCED : plan.duration,
      suppressTrace: !!opts.suppressTrace,
      fromLang: opts.fromLang,
    };
    state.dirty = true;
  }

  function setLang(next) {
    if (next === state.lang || !state.scenes) return;
    const tr = state.transition;
    /* A second press mid-flight reverses the motion rather than snapping or
       stacking a new plan on top of it. The remaining time is what has already
       elapsed, so correcting yourself feels quicker than committing - which is
       right. Traces are suppressed for the rest of a reversed transition;
       strobing hairlines are the one way this becomes cheap. */
    if (tr && tr.kind === 'lang' && tr.fromLang === next) {
      tr.dir = -1;
      tr.suppressTrace = true;
    } else {
      const fromLang = state.lang;
      begin(planLanguage(marks,
        state.scenes[`${state.view}:${fromLang}`],
        state.scenes[`${state.view}:${next}`]), 'lang', { fromLang });
    }
    state.lang = next;
    document.documentElement.lang = next === 'zh' ? 'zh-Hans' : 'en';
    try { localStorage.setItem('lang', next); } catch (e) { /* ignore */ }
    updateMirror(state.lang, true);
    syncProxy();
    syncHits();
    state.dirty = true;
  }

  function setView(next) {
    if (next === state.view || !state.scenes) return;
    const from = scene();
    state.view = next;
    begin(planView(marks, from, scene()), 'view');
    scrollTo(0, 0);
    syncProxy();
    syncHits();
  }

  function act(id) {
    if (id === 'view:card') setView('card');
    else if (id === 'view:cv') setView('cv');
    else if (id === 'lang:en') setLang('en');
    else if (id === 'lang:zh') setLang('zh');
  }

  /* --- the hit layer ------------------------------------------------------
     Real elements, absolutely positioned in content coordinates inside the
     scroll proxy, so they scroll with the document and no scrollY arithmetic
     exists anywhere in the interaction path. */

  function syncHits() {
    const hits = scene().hits;
    while (proxy.children.length > hits.length) proxy.removeChild(proxy.lastChild);
    hits.forEach((h, i) => {
      let el = proxy.children[i];
      const tag = h.href ? 'a' : 'button';
      if (!el || el.tagName.toLowerCase() !== tag) {
        const next = document.createElement(tag);
        next.className = 'hit';
        next.appendChild(document.createElement('span'));
        if (el) proxy.replaceChild(next, el);
        else proxy.appendChild(next);
        el = next;
      }
      el.dataset.id = h.id;
      el.dataset.key = h.key || '';
      el.style.left = `${h.x}px`;
      el.style.top = `${h.y}px`;
      el.style.width = `${h.w}px`;
      el.style.height = `${h.h}px`;
      el.firstChild.textContent = h.label || h.id;
      if (h.href) {
        el.setAttribute('href', h.href);
        if (h.href.startsWith('http')) { el.target = '_blank'; el.rel = 'me noopener'; }
      } else {
        el.type = 'button';
        /* Plain toggle buttons, not a tablist. A correct tablist owes the user
           roving tabindex, arrow-key navigation and a hidden inactive panel;
           half of that is worse than none, and aria-pressed says the one thing
           there is to say - which of the two you are looking at. */
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
     when the browser returns; if it does not come back, fall through to the
     mirror, which is a readable page. */
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
  let last = t0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(64, now - last);
    last = now;
    if (document.hidden || state.lost || !state.scenes) return;

    const tr = state.transition;
    if (!tr && !state.dirty && now - state.lastDraw < IDLE_FRAME_MS) return;
    if (!tr && reduced.matches && !state.dirty) return;
    state.lastDraw = now;
    state.dirty = false;

    marks.clear();
    if (tr) {
      tr.ms += dt * tr.dir;
      if (tr.ms >= tr.duration || tr.ms <= 0) {
        /* Land exactly: at the end, draw the destination through the plain
           snapped path. Trusting the transform to evaluate to an identity
           leaves it half a pixel out, and the type finishes soft. */
        state.transition = null;
        drawScene(marks, scene());
        syncProxy();
        syncHits();
      } else {
        drawPlan(marks, tr.plan, tr.ms, { reduced: reduced.matches, suppressTrace: tr.suppressTrace });
      }
    } else {
      drawScene(marks, scene(), 1, state.hover);
    }

    if (state.focus) {
      const h = scene().hits.find((x) => x.id === state.focus);
      if (h) marks.strokeRect(h.x - 4, h.y - 4, h.w + 8, h.h + 8, 2, INK, 0.85);
    }

    const time = reduced.matches ? 0 : (now - t0) / 1000;
    stage.render(marks, engine.texture, time, scrollY);
  }

  relayout();
  requestAnimationFrame(frame);

  /* The other language's faces follow without blocking anything. Its scenes
     exist from the first layout - the morph needs both sides - so they are
     briefly measured in a fallback face, off screen, and this re-rasterises
     them properly the moment the real one lands. */
  loadFonts(deferredFontSpecs(content, innerWidth, state.lang)).then(relayout).catch(() => {});

  /* The test surface. scripts/check.mjs drives the built site through this,
     because there is no other way to ask a canvas what it is showing. Kept
     small and read-only; `act` is the same function the hit layer calls. */
  window.__stage = {
    act,
    toggleLang: () => act(state.lang === 'en' ? 'lang:zh' : 'lang:en'),
    diag: () => ({
      view: state.view, lang: state.lang, cols: state.grid.cols, dpr: engine.dpr,
      atlas: engine.size, overflow: engine.overflow,
      quads: marks.count, height: Math.round(scene().height),
      /* Elapsed ms of the running transition, or null. The only way to sample
         the morph at a known point: a screenshot's own latency is larger than
         several of its phases. */
      t: state.transition ? Math.round(state.transition.ms) : null,
    }),
    grid: () => ({ ...state.grid, colX: undefined }),
    /* Every placed run, for checking that nothing overflows its column. */
    items: () => scene().items.filter((i) => i.kind === 'text').map((i) => ({
      key: i.key, text: i.run.text,
      x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.run.width),
    })),
    /* The atlas itself, as a PNG data URL - the fastest way to tell whether a
       packing or rasterisation bug is in the texture or in the draw. */
    atlas: () => engine.atlas.toDataURL('image/png'),
  };
}

/* The mirror's markup comes from mirror.js, which the build also calls to
   inline the same thing into index.html. This adds the two things a string
   cannot: the document's own title and description, and the listeners on the
   language buttons that only the degraded path renders. */
function updateMirror(lang, inert) {
  const host = document.getElementById('a11y');
  if (!host) return;
  const t = (n) => (n && n[lang] != null ? n[lang] : '');

  document.title = t(content.site.title);
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', t(content.site.description));

  host.innerHTML = renderMirror(content, lang, inert);
  if (inert) {
    /* Whatever links remain are duplicates of the hit layer's; keep them in the
       accessibility tree but out of the tab sequence. */
    host.querySelectorAll('a').forEach((a) => a.setAttribute('tabindex', '-1'));
  } else {
    host.querySelectorAll('[data-lang]').forEach((b) => {
      b.addEventListener('click', () => updateMirror(b.getAttribute('data-lang'), false));
    });
  }
}
