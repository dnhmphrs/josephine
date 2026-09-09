/* ===========================================================================
   Glyph atlas — the only place in this project that knows what a letter is.

   Nothing on this site is DOM text, so type has to become pixels somewhere.
   Rather than ship a font parser, we let the browser do the hard part: each
   text RUN (a whole string, at its final device-pixel size) is drawn once into
   a 2D canvas — which gets us real shaping, real kerning, real CJK, real
   italics for free — and the runs are shelf-packed into a single atlas canvas
   uploaded as one WebGL texture.

   A run is then cut into per-glyph vertical SLICES, so the renderer can place
   every glyph independently - which is what lets a display line be kerned by
   the browser and tightened afterwards - while an untouched run reassembles
   into exactly the bitmap the browser drew, as one quad.

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

  /* Reserve a SPRITE: a box in the atlas that something other than a font
     paints. The packer already takes arbitrary device-pixel boxes - a run is
     only a box with a fillText in it - so this needs no new machinery, just a
     handle with a `paint` callback instead of a font.

     It exists because the page has one non-typographic mark: the rounded
     square of the approach diagram. Drawing that with the white texel gives
     hard corners, and rounding it in the shader would mean a second program
     and an SDF for one shape. Canvas2D already has roundRect, the atlas
     already rasterises with Canvas2D, and every cell is the same size - so one
     sprite is rasterised at its exact device size and drawn many times, which
     is both the simplest answer and the sharpest.

     `key` must vary with anything that changes the pixels, size included. */
  sprite(key, w, h, paint) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const devW = Math.max(1, Math.round(w * this.dpr));
    const devH = Math.max(1, Math.round(h * this.dpr));
    const handle = {
      sprite: true, paint, text: key,
      devW, devH, pad: 0, n: 0, gs: [], cuts: [], ax: [], dw: [],
      width: devW / this.dpr, height: devH / this.dpr,
      uv: new Float32Array(0), uvAll: new Float32Array(4), rect: null,
    };
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
      /* The INK box, as opposed to the font box `ascent` and `descent` report.
         Display type is placed by its ink or it is not placed at all: the font
         box of a Latin face is about 1.0em against a cap height of 0.73, and
         the Han glyphs that fall back into the same run reach 0.88 above the
         baseline and 0.12 below it. Setting a name by cap height drops the
         Chinese into whatever sits under it; setting it by the font box leaves
         the English floating a quarter of an em low. */
      inkAscent: Math.max(0, m.actualBoundingBoxAscent || asc) / dpr,
      inkDescent: Math.max(0, m.actualBoundingBoxDescent || 0) / dpr,
      lineHeight: (asc + desc) / dpr,
    };
  }

  /* Pack, rasterise and upload everything reserved since reset(). */
  build() {
    const gl = this.gl;
    const runs = this.pending;
    const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 4096);

    /* Height doubles before width does. A shelf packer is bounded by the
       widest run it has to hold - here the name, which can be most of the
       measure - so growing width past that buys nothing but memory, while
       growing height buys shelves. It is the difference between a 4096 square
       and a 2048x4096, which is 32MB of texture rather than 64MB, for exactly
       the same capacity. Nothing here needs a power of two either (no mipmaps,
       CLAMP_TO_EDGE, LINEAR), but keeping them makes the allocation friendly
       to every driver. */
    const steps = [[512, 512], [1024, 1024], [1024, 2048], [2048, 2048], [2048, 4096], [4096, 4096]]
      .filter(([w, h]) => w <= maxSize && h <= maxSize);
    let box = steps[steps.length - 1];
    for (const step of steps) {
      if (this._pack(runs, step[0], step[1])) { box = step; break; }
    }
    const [aw, ah] = box;
    this._pack(runs, aw, ah);   // settle on the size we ended with

    this.size = Math.max(aw, ah);
    this.atlas.width = aw;
    this.atlas.height = ah;

    const c = precise(this.actx);
    c.clearRect(0, 0, aw, ah);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, WHITE_PX, WHITE_PX);
    this.whiteUv = [(WHITE_PX * 0.5) / aw, (WHITE_PX * 0.5) / ah];

    this.overflow = 0;
    for (const r of runs) {
      if (!r.rect) { this.overflow++; continue; }
      const bx = r.rect.x;
      const by = r.rect.y;
      c.fillStyle = '#fff';
      /* A sprite paints itself, in white, into its own reserved box. White
         because the marks shader multiplies coverage by the vertex colour -
         the same contract every glyph is drawn under. It falls through to the
         UV assignment below like everything else: a sprite is one quad, so
         uvAll is the whole of its geometry. */
      if (r.sprite) {
        c.save();
        c.translate(bx, by);
        r.paint(c, r.devW, r.devH, this.dpr);
        c.restore();
      } else {
        c.font = r.font;
        const baseY = by + r.devBaseline;
        if (r.tracked) {
          for (let i = 0; i < r.n; i++) c.fillText(r.gs[i], bx + r.pad + r.cuts[i], baseY);
        } else {
          c.fillText(r.text, bx + r.pad, baseY);
        }
      }
      r.uvAll[0] = bx / aw;
      r.uvAll[1] = by / ah;
      r.uvAll[2] = (bx + r.devW) / aw;
      r.uvAll[3] = (by + r.devH) / ah;
      for (let i = 0; i < r.n; i++) {
        const left = bx + r.pad + r.ax[i];
        const right = left + r.dw[i];
        r.uv[i * 4 + 0] = left / aw;
        r.uv[i * 4 + 1] = by / ah;
        r.uv[i * 4 + 2] = right / aw;
        r.uv[i * 4 + 3] = (by + r.devH) / ah;
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

    return { size: this.size, width: aw, height: ah, runs: runs.length, overflow: this.overflow };
  }

  /* Shelf packing, tallest first so short labels fill the gaps behind the
     display type. For a page this size that is the difference between a 1024
     and a 2048 atlas. */
  _pack(runs, aw, ah) {
    const order = runs.slice().sort((a, b) => b.devH - a.devH);
    let x = WHITE_PX + GUTTER;
    let y = 0;
    let shelf = WHITE_PX;
    let ok = true;
    for (const r of order) {
      r.rect = null;
      if (r.devW > aw || r.devH > ah) { ok = false; continue; }
      if (x + r.devW > aw) { x = 0; y += shelf + GUTTER; shelf = 0; }
      if (y + r.devH > ah) { ok = false; continue; }
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
