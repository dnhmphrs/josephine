/* ===========================================================================
   Glyph atlas — the only place in this project that knows what a letter is.

   Nothing on this site is DOM text, so type has to become pixels somewhere.
   Rather than ship a font parser, we let the browser do the hard part: each
   text RUN (a whole string, at its final device-pixel size) is drawn once into
   a 2D canvas — which gets us real shaping, real kerning, real CJK, real
   italics for free — and the runs are shelf-packed into a single atlas canvas
   uploaded as one WebGL texture.

   A run is then cut into per-glyph vertical SLICES, so the renderer can move
   every glyph independently (that is what makes the language morph possible)
   while a run at rest reassembles into exactly the bitmap the browser drew.

   Two rules keep it crisp:
     - font sizes are rounded to whole device pixels before rasterising;
     - slice boundaries are whole device pixels, and the renderer snaps a run's
       origin to a whole device pixel, so at rest every texel maps 1:1 onto a
       screen pixel and LINEAR filtering is an identity.

   The atlas also reserves an opaque white square at its origin. Rules, hairline
   underlines and the attention traces sample that square, which means the whole
   page — type and geometry alike — is one texture and one draw call.
   =========================================================================== */

/* Default 'auto' lets the engine round advances to hinted integers. The scratch
   context measures and the atlas context draws, so if the two disagree by even
   a fraction of a pixel the error accumulates across a long string: the run's
   rect is sized from the measurement, the ink is drawn wider than that, and it
   spills into whatever was packed next to it.

   This has to be re-applied after EVERY assignment to canvas.width, because
   setting the width resets the whole 2D context to its defaults - which is
   exactly the kind of state loss that produces a bug you can only see on the
   longest line on the page. */
function precise(ctx) {
  try { ctx.textRendering = 'geometricPrecision'; } catch (e) { /* older engine */ }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  try { ctx.letterSpacing = '0px'; } catch (e) { /* we place glyphs ourselves */ }
  return ctx;
}

const WHITE_PX = 4;   // reserved opaque white block at the atlas origin
const GUTTER = 2;     // device px between packed rects, stops neighbours bleeding

let _segmenter = null;
function graphemes(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    if (!_segmenter) _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(_segmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);   // still splits surrogate pairs correctly
}

export class TextEngine {
  constructor(gl) {
    this.gl = gl;
    this.scratch = document.createElement('canvas').getContext('2d');
    this.atlas = document.createElement('canvas');
    this.actx = this.atlas.getContext('2d');
    precise(this.scratch);
    this.texture = gl.createTexture();
    this.cache = new Map();
    this.pending = [];
    this.size = 0;
    this.dpr = 1;
    this.overflow = 0;
    /* UV of the reserved white block's centre — a texel that is always 1.0 */
    this.whiteUv = [0, 0];
  }

  /* The texture died with the context. Making a new name is all that is needed
     here: the next build() re-uploads the atlas into it. */
  restore() {
    this.texture = this.gl.createTexture();
  }

  /* Start a new atlas generation. Everything measured before this is discarded,
     which is what a resize or a DPR change requires (sizes change, so the
     rasterisation does too). */
  reset(dpr) {
    this.dpr = dpr;
    this.cache.clear();
    this.pending = [];
    this.overflow = 0;
  }

  /* Measure a run and reserve it in the next atlas build.

     spec: { text, family, size, weight = 400, italic = false, tracking = 0 }
       size     - CSS px
       tracking - letter-spacing in em; non-zero switches to per-glyph drawing
                  (Canvas2D `letterSpacing` is not portable, and drawing glyph
                  by glyph gives us exact slice boundaries anyway)

     Returns a handle carrying CSS-px metrics for the layout engine and
     device-px slice geometry for the renderer. Identical specs share a handle. */
  run(spec) {
    const key = `${spec.text} ${spec.family} ${spec.size} ${spec.weight || 400} ${spec.italic ? 1 : 0} ${spec.tracking || 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const handle = this._measure(spec);
    this.cache.set(key, handle);
    this.pending.push(handle);
    return handle;
  }

  /* Width of a string in CSS px without reserving atlas space. The line breaker
     asks this about dozens of candidate lines it will never draw, and every one
     of those would otherwise be rasterised and thrown away. */
  measure(spec) {
    const px = Math.max(1, Math.round(spec.size * this.dpr));
    const ctx = this.scratch;
    ctx.font = `${spec.italic ? 'italic ' : ''}${spec.weight || 400} ${px}px ${spec.family}`;
    let w = ctx.measureText(spec.text).width;
    if (spec.tracking) {
      const n = graphemes(spec.text).length;
      if (n > 1) w += spec.tracking * px * (n - 1);
    }
    return w / this.dpr;
  }

  _measure(spec) {
    const dpr = this.dpr;
    const px = Math.max(1, Math.round(spec.size * dpr));
    const weight = spec.weight || 400;
    const font = `${spec.italic ? 'italic ' : ''}${weight} ${px}px ${spec.family}`;
    const ctx = this.scratch;
    ctx.font = font;

    const gs = graphemes(spec.text);
    const n = gs.length;
    const track = (spec.tracking || 0) * px;
    /* Positive tracking is for capitals, where kerning is meaningless at
       +0.2em and hand placement buys exact cut boundaries. Negative tracking is
       for display type, where kerning is the whole point - "Jo", "ph", "Sh" at
       100px - so it is measured and drawn KERNED and the tightening is applied
       afterwards, as a per-slice offset. Rasterise the name tracked and you
       throw away shaping on the one string that most needs it. */
    const tracked = track > 0;
    const post = track < 0 ? track : 0;
    const cuts = new Float64Array(n + 1);

    if (!tracked) {
      /* One draw call, so the browser kerns and ligates. The cut in front of
         glyph i is then found by measuring the SUFFIX, not the prefix:
         W(whole) - W(text from i on). For a kerned pair the prefix width omits
         the kern at the boundary and the cut lands inside the next glyph's
         ink; the suffix form includes it. Same cost, and correct. */
      const total = ctx.measureText(spec.text).width;
      let idx = 0;
      for (let i = 0; i < n; i++) {
        cuts[i] = idx === 0 ? 0 : total - ctx.measureText(spec.text.slice(idx)).width;
        idx += gs[i].length;
      }
      cuts[n] = total;
    } else {
      /* Tracked runs are placed by hand, so the cuts are exact by construction.
         Rounded here so the draw and the slice agree to the pixel. */
      let x = 0;
      for (let i = 0; i < n; i++) {
        cuts[i] = Math.round(x);
        x += ctx.measureText(gs[i]).width + track;
      }
      cuts[n] = Math.round(x - track);
    }

    const m = ctx.measureText(spec.text || 'H');
    const fAsc = m.fontBoundingBoxAscent;
    const fDesc = m.fontBoundingBoxDescent;
    const asc = Math.ceil(Number.isFinite(fAsc) && fAsc > 0 ? fAsc : (m.actualBoundingBoxAscent || px * 0.82));
    const desc = Math.ceil(Number.isFinite(fDesc) && fDesc > 0 ? fDesc : (m.actualBoundingBoxDescent || px * 0.24));

    /* Ink can sit outside the advance box: italic overhang, a swash, a glyph
       with a negative left bearing. Pad enough to keep it, at both edges. */
    const overL = Math.ceil(Math.max(0, m.actualBoundingBoxLeft || 0));
    const overR = Math.ceil(Math.max(0, (m.actualBoundingBoxRight || 0) - cuts[n]));
    const pad = Math.max(2, Math.ceil(px * 0.08), overL, overR);

    /* The atlas rect always holds the untracked bitmap; `post` only moves the
       slices when they are drawn. */
    const advance = Math.round(cuts[n] + post * Math.max(0, n - 1));
    const w = Math.round(cuts[n]) + pad * 2;
    const h = asc + desc + pad * 2;

    /* Slice geometry, in device px relative to the run rect's left edge. The
       first and last slices widen to the rect edges so overhanging ink travels
       with the glyph it belongs to. */
    /* Two x arrays, and the distinction matters: `ax` is where a slice sits in
       the atlas, which is always the untracked position the bitmap was drawn
       at; `dx` is where that slice is placed on screen, which for a
       post-tracked run is shifted. Reusing one for both samples the wrong part
       of the atlas and every glyph comes out as its neighbour's tail. */
    const ax = new Int32Array(n);
    const dx = new Int32Array(n);
    const dw = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const left = i === 0 ? 0 : pad + Math.round(cuts[i]);
      const right = i === n - 1 ? w : pad + Math.round(cuts[i + 1]);
      ax[i] = left - pad;                          // relative to the pen origin
      dx[i] = ax[i] + Math.round(post * i);
      dw[i] = Math.max(0, right - left);
    }

    /* Cap height: the optical top of a capital, used to centre display type by
       its cap rather than by its (invisible) font box. */
    const capM = ctx.measureText('H');
    const cap = capM.actualBoundingBoxAscent || asc * 0.72;

    return {
      spec, font, text: spec.text, gs, n, tracked, post: post !== 0, cuts, pad,
      ax,
      /* device px */
      devW: w, devH: h, devAdvance: advance, devBaseline: pad + asc,
      dx, dw,
      uv: new Float32Array(n * 4),
      uvAll: new Float32Array(4),
      rect: null,
      /* CSS px — what the layout engine reasons in */
      width: advance / dpr,
      ascent: asc / dpr,
      descent: desc / dpr,
      capHeight: cap / dpr,
      lineHeight: (asc + desc) / dpr,
    };
  }

  /* Pack, rasterise and upload everything reserved since reset(). */
  build() {
    const gl = this.gl;
    const runs = this.pending;
    const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 4096);

    let size = 512;
    while (size < maxSize && !this._pack(runs, size)) size *= 2;
    this._pack(runs, size);   // settle on the size we ended with

    this.size = size;
    this.atlas.width = size;
    this.atlas.height = size;

    const c = precise(this.actx);
    c.clearRect(0, 0, size, size);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, WHITE_PX, WHITE_PX);
    this.whiteUv = [(WHITE_PX * 0.5) / size, (WHITE_PX * 0.5) / size];

    this.overflow = 0;
    for (const r of runs) {
      if (!r.rect) { this.overflow++; continue; }
      const bx = r.rect.x;
      const by = r.rect.y;
      c.font = r.font;
      c.fillStyle = '#fff';
      const baseY = by + r.devBaseline;
      if (r.tracked) {
        for (let i = 0; i < r.n; i++) c.fillText(r.gs[i], bx + r.pad + r.cuts[i], baseY);
      } else {
        c.fillText(r.text, bx + r.pad, baseY);
      }
      r.uvAll[0] = bx / size;
      r.uvAll[1] = by / size;
      r.uvAll[2] = (bx + r.devW) / size;
      r.uvAll[3] = (by + r.devH) / size;
      for (let i = 0; i < r.n; i++) {
        const left = bx + r.pad + r.ax[i];
        const right = left + r.dw[i];
        r.uv[i * 4 + 0] = left / size;
        r.uv[i * 4 + 1] = by / size;
        r.uv[i * 4 + 2] = right / size;
        r.uv[i * 4 + 3] = (by + r.devH) / size;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { size, runs: runs.length, overflow: this.overflow };
  }

  /* Shelf packing, tallest first so short labels fill the gaps behind the
     display type. For a page this size that is the difference between a 1024
     and a 2048 atlas. */
  _pack(runs, size) {
    const order = runs.slice().sort((a, b) => b.devH - a.devH);
    let x = WHITE_PX + GUTTER;
    let y = 0;
    let shelf = WHITE_PX;
    let ok = true;
    for (const r of order) {
      r.rect = null;
      if (r.devW > size || r.devH > size) { ok = false; continue; }
      if (x + r.devW > size) { x = 0; y += shelf + GUTTER; shelf = 0; }
      if (y + r.devH > size) { ok = false; continue; }
      r.rect = { x, y };
      x += r.devW + GUTTER;
      if (r.devH > shelf) shelf = r.devH;
    }
    return ok;
  }
}

/* Ask the browser to actually fetch every face we are about to rasterise.
   This is not optional: Google Fonts ships Noto SC as dozens of unicode-range
   subsets, and drawing to a 2D canvas does NOT trigger those downloads the way
   laying out DOM text does. document.fonts.load(shorthand, sampleText) is the
   only thing that pulls the right subset, and the sample text is what selects
   which subset that is. */
export async function loadFonts(specs) {
  if (!document.fonts || !document.fonts.load) return;
  const jobs = specs.map((s) => {
    const font = `${s.italic ? 'italic ' : ''}${s.weight || 400} ${Math.round(s.size || 32)}px ${s.family}`;
    return document.fonts.load(font, s.sample || 'Ag').catch(() => {});
  });
  await Promise.all(jobs);
  if (document.fonts.ready) await document.fonts.ready.catch(() => {});
}
