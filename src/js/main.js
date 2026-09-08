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
if (!stage) fallback();
else boot(stage);

/* No WebGL, or a context we could not create: promote the mirror to the
   visible page. Rare, but a researcher's contact details should not depend on
   a GPU. */
function fallback() {
  document.body.classList.add('fallback');
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
  await loadFonts(fontSpecs(content, innerWidth, state.lang));

  const scene = () => state.scenes[`${state.view}:${state.lang}`];

  /* --- layout ------------------------------------------------------------ */

  function relayout() {
    const dpr = Math.min(devicePixelRatio || 1, state.dprCap);
    const box = stage.resize(innerWidth, liveHeight(), dpr);
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

  /* The SMALL viewport height - what is available with the browser chrome at
     its largest. Layout uses this, so the card is guaranteed to fit in the
     worst case and never jitters as the iOS bars animate in and out. */
  function stableHeight() {
    return (svhProbe && svhProbe.offsetHeight) || innerHeight;
  }
  /* The height right now, which drives only the GL viewport. */
  function liveHeight() {
    return (window.visualViewport && window.visualViewport.height) || innerHeight;
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
        if (h.role === 'tab') {
          el.setAttribute('role', 'tab');
          el.setAttribute('aria-selected', String(!!h.selected));
          el.setAttribute('aria-controls', h.id === 'view:card' ? 'p-card' : 'p-cv');
        } else if (h.pressed !== undefined) {
          el.setAttribute('aria-pressed', String(h.pressed));
        }
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
    state.focus = el && el.matches(':focus-visible') ? el.dataset.id : null;
    state.dirty = true;
  });
  proxy.addEventListener('focusout', () => { state.focus = null; state.dirty = true; });

  /* --- viewport ----------------------------------------------------------- */

  addEventListener('scroll', () => { state.dirty = true; }, { passive: true });

  let resizeTimer = 0;
  addEventListener('resize', () => {
    /* Collapsing the iOS URL bar fires resize and changes innerHeight by 60-90
       px. Rebuilding the whole atlas mid-scroll for that is the bug; only a
       width change or a real change of the stable height is a relayout. */
    const dpr = Math.min(devicePixelRatio || 1, state.dprCap);
    stage.resize(innerWidth, liveHeight(), dpr);
    state.dirty = true;
    const nextStable = stableHeight();
    if (Math.abs(innerWidth - state.vw) < 1
      && Math.abs(nextStable - state.vhStable) < state.vhStable * 0.2) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 120);
  }, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      stage.resize(innerWidth, liveHeight(), Math.min(devicePixelRatio || 1, state.dprCap));
      state.dirty = true;
    }, { passive: true });
  }

  if (reduced.addEventListener) reduced.addEventListener('change', () => { state.dirty = true; });

  /* --- the loop ---------------------------------------------------------- */

  const t0 = performance.now();
  let last = t0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(64, now - last);
    last = now;
    if (document.hidden || !state.scenes) return;

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

/* ---------------------------------------------------------------------------
   The accessible mirror.

   The canvas is a picture of text, and a picture of text is not text. This
   rebuilds the same strings as a real document inside #a11y - headings, a
   definition list, links - so that screen readers and search engines have
   something to work with, and so the no-WebGL path has a page to fall back to.
   The interactive controls live in the hit layer instead, which is where the
   browser can give them real behaviour.
   --------------------------------------------------------------------------- */
function updateMirror(lang, inert) {
  const host = document.getElementById('a11y');
  if (!host) return;
  const t = (n) => (n && n[lang] != null ? n[lang] : '');
  const c = content.card;

  document.title = t(content.site.title);
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', t(content.site.description));

  const out = [
    '<section id="p-card" role="tabpanel" aria-labelledby="Card">',
    `<h1>${esc(t(c.name))}</h1>`,
    `<p>${esc(t(c.role))}. ${esc(t(c.line))}</p>`,
    '<dl>',
    ...c.fields.map((f) => `<dt>${esc(t(f.label))}</dt><dd>${esc(t(f.value))}</dd>`),
    '</dl>',
    `<p><a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a>`,
    ` <a href="${esc(c.contact.linkedin.url)}" rel="me noopener">${esc(c.contact.linkedin.label)}</a></p>`,
    '</section>',
    '<section id="p-cv" role="tabpanel">',
    `<h2>${esc(t(content.nav.cv))}</h2>`,
    ...content.cv.flatMap((sec) => [
      `<h3>${esc(t(sec.section))}</h3><ul>`,
      ...sec.entries.map((e) => {
        const bits = [e.year, t(e.title), e.org ? t(e.org) : ''].filter(Boolean);
        return `<li>${esc(bits.join(' - '))}</li>`;
      }),
      '</ul>',
    ]),
    '</section>',
  ];
  host.innerHTML = out.join('');
  /* When the canvas is live, the mirror's links are a second copy of links the
     hit layer already carries at their real positions. Leaving both in the tab
     order makes a keyboard user visit the email twice. tabindex="-1" takes them
     out of the tab sequence while keeping them in the accessibility tree, so a
     screen reader's list of links is still complete. In the no-WebGL fallback
     the mirror IS the page and they stay focusable. */
  if (inert) host.querySelectorAll('a').forEach((a) => a.setAttribute('tabindex', '-1'));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
