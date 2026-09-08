/* ===========================================================================
   The language morph.

   Pressing 中 does not swap one block of text for another. It computes a soft
   alignment between the glyphs of the English string and the glyphs of the
   Chinese one - the same shape of object a transformer's cross-attention
   produces when it translates - and plays that alignment as motion.

   ONE matrix, read in both directions:

       A[j][i] = softmax_i( -(u_i - v_j)^2 / 2s^2 ),   u_i = (i+0.5)/n
                                                        v_j = (j+0.5)/m

   Row-normalised, A says where a Chinese glyph came from. Column-normalised,
   the same numbers say where an English glyph is going. Deriving both from one
   matrix matters: two independent softmaxes are two different alignments, the
   departures would then draw one picture and the arrivals another, and the
   trace could only be honest about one of them.

   A real cross-attention map on a translation pair is strongly near-diagonal,
   peaked, with a light tail either side - which is exactly this kernel plus the
   uniform floor. On "Josephine Shen" -> "沈菲菲", 沈 is born out of "Jose",
   the first 菲 out of "phine", the second out of "Shen", and the eye reads a
   mapping rather than a dissolve.

   Two honesties worth keeping: the alignment is positional, not semantic - it
   makes no claim to know that 沈 is the surname - and the motion is short.

   Three tiers, because the page has three kinds of text:
     1. The name and its eyebrow get the full attention morph, and the name
        alone gets the trace. This is the signature.
     2. Short tracked labels get the same mechanism with the travel capped, so
        a nav item does not fly across the page to become two characters.
     3. Everything else gets the decode wipe: one soft edge sweeps the line,
        the old language lifts just ahead of it and the new one lands just
        behind, and a narrow band of bare concrete travels between them. Ink
        lifts, ground shows, ink lands - the one place the sumi-e reference
        gets to be literal.
   =========================================================================== */

const DURATION = 720;          // ms, the full morph; the name lands last
const DURATION_VIEW = 380;     // ms, card <-> cv
const DURATION_REDUCED = 280;  // ms, prefers-reduced-motion: a dissolve in place

const SIGMA = 0.12;   // attention temperature, in normalised glyph position
const FLOOR = 0.02;   // uniform tail, so no glyph is ever left unattended

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/* The last fifth is nearly stationary, so the eye never catches the moment a
   glyph snaps back onto the device-pixel grid at the end. */
const easeOutQuint = (x) => 1 - Math.pow(1 - x, 5);
const easeSine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* Baseline-centre of every glyph of a placed run, in absolute CSS px. Computed
   through the same path the renderer uses, so an anchor lines up exactly with
   where Marks.runTransformed will put the glyph. */
function centres(marks, item) {
  const run = item.run;
  const out = new Float32Array(run.n * 2);
  for (let i = 0; i < run.n; i++) {
    const g = marks.glyphRect(run, item.x, item.y, i);
    out[i * 2] = (g.x0 + g.x1) * 0.5;
    out[i * 2 + 1] = item.y;
  }
  return out;
}

/* The alignment, and the anchors both readings of it imply. */
function align(ca, cb, n, m) {
  const A = new Float64Array(m * n);           // A[j*n + i], row-normalised
  const inv2s2 = 1 / (2 * SIGMA * SIGMA);
  const aAnchor = new Float32Array(n * 2);
  const bAnchor = new Float32Array(m * 2);

  for (let j = 0; j < m; j++) {
    const v = (j + 0.5) / m;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = (i + 0.5) / n - v;
      const w = Math.exp(-d * d * inv2s2) + FLOOR;
      A[j * n + i] = w;
      sum += w;
    }
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      A[j * n + i] /= sum;
      const p = A[j * n + i];
      x += p * ca[i * 2];
      y += p * ca[i * 2 + 1];
    }
    bAnchor[j * 2] = x;
    bAnchor[j * 2 + 1] = y;
  }

  /* Column-normalise the same matrix for the other direction. */
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < m; j++) sum += A[j * n + i];
    let x = 0;
    let y = 0;
    for (let j = 0; j < m; j++) {
      const p = A[j * n + i] / sum;
      x += p * cb[j * 2];
      y += p * cb[j * 2 + 1];
    }
    aAnchor[i * 2] = x;
    aAnchor[i * 2 + 1] = y;
  }

  return { A, aAnchor, bAnchor };
}

/* The strongest pair per glyph of whichever side is shorter, plus one
   off-diagonal filament. Real attention maps have a head that dumps its
   leftover mass on the first token; that single stray line across an otherwise
   near-diagonal picture is the honest part. Never more than seven lines. */
function traces(A, n, m) {
  const out = [];
  if (m <= 6) {
    for (let j = 0; j < m; j++) {
      let best = 0;
      for (let i = 1; i < n; i++) if (A[j * n + i] > A[j * n + best]) best = i;
      out.push([best, j, 1]);
    }
  } else if (n <= 6) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let j = 1; j < m; j++) if (A[j * n + i] > A[best * n + i]) best = j;
      out.push([i, best, 1]);
    }
  } else {
    return null;
  }
  out.push([0, m - 1, 0.55]);   // the sink filament
  return out;
}

/* ---------------------------------------------------------------------------
   Plans. Matching two scenes by key happens once, when the transition starts,
   so the per-frame path is a flat walk over ops.
   --------------------------------------------------------------------------- */
function index(scene) {
  const m = new Map();
  for (const it of scene.items) m.set(it.key, it);
  return m;
}

export function planLanguage(marks, from, to) {
  const B = index(to);
  const ops = [];
  const seen = new Set();
  let wipeIndex = 0;

  for (const a of from.items) {
    seen.add(a.key);
    const b = B.get(a.key);
    if (!b) { ops.push({ op: 'out', a }); continue; }
    if (a.kind === 'rect' || b.kind === 'rect' || a.run === b.run) {
      ops.push({ op: 'persist', a, b });
      continue;
    }

    if (a.mode === 'attn' && a.run.n && b.run.n) {
      const ca = centres(marks, a);
      const cb = centres(marks, b);
      const { A, aAnchor, bAnchor } = align(ca, cb, a.run.n, b.run.n);
      ops.push({
        op: 'attn', a, b, ca, cb, aAnchor, bAnchor,
        trace: a.trace ? traces(A, a.run.n, b.run.n) : null,
        start: 0,
        dur: a.tier === 1 ? DURATION : 300,
        /* Tier 2 caps how far a small label may travel; without it a 12px nav
           item would fly the width of the page to become one character. */
        cap: a.tier === 1 ? Infinity : 0.6 * a.run.spec.size,
      });
    } else {
      /* The wipe is staggered so the page settles as a sweep rather than a
         flash, and settles BEFORE the name does, so the eye ends on the name. */
      ops.push({ op: 'wipe', a, b, start: Math.min(240, 26 * wipeIndex++), dur: 240 });
    }
  }
  for (const b of to.items) if (!seen.has(b.key)) ops.push({ op: 'in', b });
  return { ops, duration: DURATION, kind: 'lang' };
}

/* View change: the chrome holds still and the content is exchanged under it. */
export function planView(marks, from, to) {
  const B = index(to);
  const ops = [];
  const seen = new Set();
  const shared = (k) => k.startsWith('nav.');

  for (const a of from.items) {
    seen.add(a.key);
    const b = B.get(a.key);
    if (b && shared(a.key)) ops.push({ op: 'persist', a, b });
    else ops.push({ op: 'out', a });
  }
  for (const b of to.items) if (!seen.has(b.key) || !shared(b.key)) ops.push({ op: 'in', b });
  return { ops, duration: DURATION_VIEW, kind: 'view' };
}

/* ---------------------------------------------------------------------------
   Drawing.
   --------------------------------------------------------------------------- */
/* `hoverKey` is the one response the page makes to a pointer: the mark under
   it lifts to full ink. The cursor has already said it is clickable; anything
   more would be decoration. */
export function drawScene(marks, scene, alpha = 1, hoverKey = null) {
  for (const it of scene.items) {
    if (it.kind === 'rect') {
      marks.rect(it.x, it.y, it.w, it.h, it.color, it.alpha * alpha);
    } else {
      marks.run(it.run, it.x, it.y, it.key === hoverKey ? HOVER_INK : it.color, it.alpha * alpha);
    }
  }
}

const HOVER_INK = [0.086, 0.086, 0.102];

const lerp = (a, b, t) => a + (b - a) * t;
function lerpCol(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* `ms` is elapsed milliseconds, not a normalised fraction: the three tiers run
   on different clocks inside one transition, and normalising would only mean
   converting back on every op. */
export function drawPlan(marks, plan, ms, opts = {}) {
  const reduced = !!opts.reduced;
  const suppressTrace = !!opts.suppressTrace;
  const D = reduced ? DURATION_REDUCED : plan.duration;
  const e = easeInOut(clamp(ms / D, 0, 1));

  for (const op of plan.ops) {
    switch (op.op) {
      case 'persist': {
        const { a, b } = op;
        if (a.kind === 'rect') {
          marks.rect(lerp(a.x, b.x, e), lerp(a.y, b.y, e), lerp(a.w, b.w, e), lerp(a.h, b.h, e),
            lerpCol(a.color, b.color, e), lerp(a.alpha, b.alpha, e));
        } else {
          marks.run(b.run, lerp(a.x, b.x, e), lerp(a.y, b.y, e),
            lerpCol(a.color, b.color, e), lerp(a.alpha, b.alpha, e));
        }
        break;
      }

      case 'out': {
        const { a } = op;
        const k = 1 - smooth(0, 0.55 * D, ms);
        if (a.kind === 'rect') marks.rect(a.x, a.y, a.w, a.h, a.color, a.alpha * k);
        else marks.run(a.run, a.x, a.y + (reduced ? 0 : -5 * e), a.color, a.alpha * k);
        break;
      }

      case 'in': {
        const { b } = op;
        const k = smooth(0.4 * D, D, ms);
        if (b.kind === 'rect') marks.rect(b.x, b.y, b.w, b.h, b.color, b.alpha * k);
        else marks.run(b.run, b.x, b.y + (reduced ? 0 : 7 * (1 - k)), b.color, b.alpha * k);
        break;
      }

      case 'wipe':
      case 'attn': {
        const { a, b } = op;
        /* Reduced motion: a dissolve in place. No travel, no wipe, no trace,
           no stagger - zero displacement means zero vector to track. Not a
           hard cut either: a cut is a flash, and a flash is worse for a
           vestibular reader than a dissolve. */
        if (reduced) {
          marks.run(a.run, a.x, a.y, a.color, a.alpha * (1 - easeSine(ms / 160)));
          marks.run(b.run, b.x, b.y, b.color, b.alpha * easeSine((ms - 100) / 180));
          break;
        }
        if (op.op === 'wipe') drawWipe(marks, op, ms);
        else drawAttention(marks, op, ms, suppressTrace);
        break;
      }
    }
  }
}

/* One soft vertical edge sweeps the line. The target lags the source by a
   seventh of the sweep, which is what opens the travelling band of bare
   concrete between the two languages.

   Both runs are drawn at the SAME interpolated position rather than each at its
   own. The two languages do not set to the same measure - Chinese is usually
   shorter, so a line that wraps four times in English wraps twice in Chinese -
   and everything below a run therefore sits somewhere else on the other side.
   Drawing each where it belongs leaves the old language hanging over the new
   one further down the card. Interpolating the position makes the wipe what it
   should be: one line, in one place, changing language. */
function drawWipe(marks, op, ms) {
  const { a, b, start, dur } = op;
  const local = clamp((ms - start) / dur, 0, 1);
  if (local <= 0) { marks.run(a.run, a.x, a.y, a.color, a.alpha); return; }
  if (local >= 1) { marks.run(b.run, b.x, b.y, b.color, b.alpha); return; }

  const e = easeSine(local);
  const x = lerp(a.x, b.x, e);
  const y = lerp(a.y, b.y, e);

  const soft = Math.max(24, 1.2 * a.run.spec.size);
  const sweep = Math.max(a.run.width, b.run.width) + soft * 2;
  const E = -soft + sweep * e;
  const lag = 0.14 * sweep;

  marks.runTransformed(a.run, x, y, a.color, a.alpha, (i, g) =>
    ({ x: 0, y: 0, s: 1, a: 1 - smooth(E - soft, E, (g.x0 + g.x1) * 0.5 - x) }));
  marks.runTransformed(b.run, x, y, b.color, b.alpha, (j, g) =>
    ({ x: 0, y: 0, s: 1, a: smooth(E - soft - lag, E - lag, (g.x0 + g.x1) * 0.5 - x) }));
}

function drawAttention(marks, op, ms, suppressTrace) {
  const { a, b, ca, cb, aAnchor, bAnchor, start, dur, cap } = op;
  const n = a.run.n;
  const m = b.run.n;
  const local = clamp((ms - start) / dur, 0, 1);

  /* The trace is drawn BEFORE the glyphs, so type always sits on top of it.
     The discipline is that it must be gone before you can study it: if you can
     stop and count the lines, it has failed. */
  if (op.trace && !suppressTrace) {
    for (const [i, j, k] of op.trace) {
      const t0 = 150 + 55 * j;
      const draw = smooth(t0, t0 + 180, ms);
      if (draw <= 0) continue;
      const alpha = 0.10 * k * draw * (1 - smooth(t0 + 270, t0 + 430, ms));
      if (alpha <= 0.002) continue;
      const x0 = ca[i * 2];
      const y0 = ca[i * 2 + 1] + 2;
      const x1 = cb[j * 2];
      const y1 = cb[j * 2 + 1] + 2;
      marks.line(x0, y0, lerp(x0, x1, draw), lerp(y0, y1, draw),
        1 / marks.engine.dpr, a.color, alpha);
    }
  }

  const scaled = (dx, dy) => {
    if (!Number.isFinite(cap)) return 1;
    const d = Math.hypot(dx, dy);
    return d > cap ? cap / d : 1;
  };

  /* Departures. Each glyph is pulled toward the centroid of the target glyphs
     that attend to it, and holds its ink for most of the journey - fading in
     step with the travel leaves the middle of the transition empty, and an
     empty middle reads as a page that broke rather than a word that changed. */
  marks.runTransformed(a.run, a.x, a.y, a.color, a.alpha, (i) => {
    const delay = n > 1 ? 0.05 * (i / (n - 1)) : 0;
    const u = easeOutQuint(clamp((local - delay) / 0.7, 0, 1));
    const dx = aAnchor[i * 2] - ca[i * 2];
    const dy = aAnchor[i * 2 + 1] - ca[i * 2 + 1];
    const f = scaled(dx, dy) * u;
    return { x: dx * f, y: dy * f, s: 1 - 0.09 * u, a: 1 - smooth(0.45, 1, u) };
  });

  /* Arrivals. They start where the same matrix says they came from and settle
     into place a little later, so the two populations cross. */
  marks.runTransformed(b.run, b.x, b.y, b.color, b.alpha, (j) => {
    const delay = 0.16 + (m > 1 ? 0.10 * (j / (m - 1)) : 0);
    const u = easeOutQuint(clamp((local - delay) / 0.72, 0, 1));
    const dx = bAnchor[j * 2] - cb[j * 2];
    const dy = bAnchor[j * 2 + 1] - cb[j * 2 + 1];
    const f = scaled(dx, dy) * (1 - u);
    return { x: dx * f, y: dy * f, s: 0.92 + 0.08 * u, a: smooth(0, 0.5, u) };
  });
}

export const TIMING = { DURATION, DURATION_VIEW, DURATION_REDUCED };
