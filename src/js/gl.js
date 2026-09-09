/* ===========================================================================
   The renderer. Two passes, and that is the whole graphics stack.

     1. GROUND  - one full-screen triangle running the concrete shader.
     2. MARKS   - one dynamic vertex buffer, one texture, one draw call, holding
                  every glyph, every hairline rule and every attention trace on
                  the page.

   WebGL 1 / GLSL ES 1.00 throughout: it is the only 3D context that is simply
   everywhere, and nothing here needs more than it offers.

   Coordinates: the scene is authored in CSS pixels with the origin at the top
   left, which is what the layout engine and the DOM both think in. The vertex
   shader converts to clip space in DEVICE-pixel terms - not by dividing by a
   CSS-pixel viewport, which silently rescales by up to half a device pixel
   whenever cssWidth x dpr is not an integer, and defeats every other rule
   about snapping in text.js.
   =========================================================================== */

/* The ground. The shader's vertical mix averages to exactly this, and so does
   --concrete in styles/main.css, so the CSS ground and the first painted frame
   are the same value and there is no flash between them. */
export const CONCRETE = [0.8941, 0.8824, 0.8588];   // #e4e1db

/* Coverage exponent - see the mark fragment shader. 1.0 is raw coverage and
   renders visibly heavy; the theoretical correction for ink this dark on a
   ground this light is around 1.7, but Skia rasterises white-on-transparent
   slightly thin, which cancels part of it. This is the midpoint, tuned by eye
   against DOM-rendered type. */
const COVERAGE_GAMMA = 1.35;

/* vPix carries the screen position at the vertex shader's precision. It exists
   because gl_FragCoord is specified as mediump in GLSL ES 1.00 whatever the
   fragment default says - so on a device without highp support the dither and
   the aggregate would be derived from a coordinate that has already lost its
   mantissa near the bottom of a tall page, and would band on their own. */
const GROUND_VS = `
attribute vec2 aPos;
uniform vec2 uRes;
varying vec2 vUv;
varying vec2 vPix;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vPix = vUv * uRes;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* ---------------------------------------------------------------------------
   The ground: paper, and two pools.

   This is a port of the washi ground from the archived builds - _archive/
   rebuilds/file2.html and initial-builds/rebuild1.html - and not of the silk
   shader beside them. The silk is the interesting one to write and the wrong
   one for this page: a domain-warped, folding, chromatic field, at the top of
   a document whose entire argument is that it does not raise its voice.

   What the archive actually did, in CSS, was two lines:

     radial-gradient(120% 80% at  50% -10%, rgba(143,95,160,.045), transparent 60%)
     radial-gradient(100% 60% at 100% 110%, rgba(143,95,160,.035), transparent 55%)

   over a warm broadsheet white, with a faint grain on top. Two enormous, very
   soft, off-centre pools at four and a half and three and a half percent - so
   shallow that on most displays you cannot point at where one begins. That is
   the whole gesture, and it is a better one than the wash it replaces, which
   was a brushed mass with a defined upper edge and therefore a THING on the
   page rather than a property of it.

   Three decisions carry it:

     - The pools are LILAC, from the archive and ultimately from the WebGPU
       silk. It is the only hue anywhere on this page. A neutral grey pool of
       the same depth reads as a smudge or a dirty screen; a violet one reads
       as light, because a warm ground with a cool shadow is how a surface
       under a real sky behaves. Four percent of a hue does more than eight
       percent of a value.
     - They are anchored to the PAGE, at a tenth of the scroll, not to the
       viewport. A gradient pinned to the window is a vignette and announces
       itself the moment you scroll; one that lags slightly reads as something
       the page is printed on.
     - The dither is the most important term in the file. The whole ramp is
       about eight of the 256 available levels deep, and without a dither it
       bands into visible contours on any 8-bit display.
   --------------------------------------------------------------------------- */
const GROUND_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;      // device px
uniform float uTime;     // seconds
uniform float uScroll;   // page scroll, in viewport heights
uniform vec3  uPointer;  // xy in viewport uv (y up), z = presence
varying vec2  vUv;       // y up
varying vec2  vPix;      // device px, at vertex precision

/* Mean of these two is exactly #e4e1db: a warm broadsheet off-white, six
   points of red over blue. The archive set its paper at #f3f1ea, which is
   brighter than this page wants - the ink here is quiet, and a quiet ink on a
   bright ground is a page that looks unfinished rather than restrained. */
const vec3 PAPER_TOP = vec3(0.878, 0.867, 0.839);   // #e0ddd6
const vec3 PAPER_BOT = vec3(0.910, 0.898, 0.878);   // #e8e5e0
/* rgba(143,95,160) - the archive's pool colour, and the same lilac the WebGPU
   silk was built on. Never seen as a colour; only ever as the reason the
   ground reads as a surface with light on it. */
const vec3 LILAC     = vec3(0.561, 0.373, 0.627);   // #8f5fa0

const float POOL_A = 0.048;        // upper pool, from 120% 80% at 50% -10%
const float POOL_B = 0.038;        // lower pool, from 100% 60% at 100% 110%
/* A third pool, and the only thing on this page that answers the reader. It
   follows the pointer at about a twelfth of the distance per frame, which is
   slow enough that it never feels attached to the cursor and never draws the
   eye - what you notice is that the sheet is very slightly cooler where you
   are looking, the way paper is under a hand. Seven percent sounds like a
   lot and is about four levels out of 255 at the very centre; squared
   falloff spreads the rest so thin that the pool has no edge anywhere.

   Seven is a ceiling, not a taste: the darkest point this shader can reach is
   the two static pools at their deepest with this one at full strength on top,
   and #5B584C - the quietest ink on the page - measures 4.65:1 against exactly
   that. Nine percent takes it to 4.56 and ten takes it under 4.5. Raising this
   means lowering INK_3, and it is the ink that should win.

   On a touch screen it does not exist. */
const float POOL_P = 0.070;
const float TOOTH  = 0.007;        // paper grain
const float DITHER = 2.0 / 255.0;  // 1/255 is pure TPDF; 2 also reads as surface
const float DRIFT  = 0.011;        // one full cycle, about twenty minutes
const float LAG    = 0.10;         // how much of the scroll the pools take

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/* Interleaved gradient noise. One dot product and two fracts, and it
   distributes better than anything else this cheap. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/* One CSS radial-gradient, as a number. Centre in viewport units with y UP
   (so a CSS "at 50% -10%" is 0.5, 1.10 here), half-extents as fractions of the
   viewport, and the stop where CSS said transparent. Linear in, smoothstepped out - a CSS gradient interpolates
   linearly and looks slightly harder at the stop than this does, which on a
   pool four percent deep is an improvement rather than an infidelity. */
float pool(vec2 uv, vec2 c, vec2 r, float stop) {
  return 1.0 - smoothstep(0.0, stop, length((uv - c) / r));
}

void main() {
  float t = uTime * DRIFT;
  /* The pools lag the page. Not parallax for its own sake: a background
     pinned to the viewport is a vignette, and the eye finds the seam the
     moment the document moves under it. */
  vec2 uv = vec2(vUv.x, vUv.y + clamp(uScroll, 0.0, 6.0) * LAG);

  /* The sheet. One mix on a shallow diagonal, and nothing else - no mottle, no
     vignette. The grain and the dither below are what give it a surface. */
  vec3 col = mix(PAPER_BOT, PAPER_TOP,
    clamp(0.5 + 0.58 * (vUv.y - 0.5) - 0.30 * (vUv.x - 0.5), 0.0, 1.0));

  /* Two pools, drifting on periods that never coincide. The displacement is
     about one percent of the viewport over twenty minutes: still, at any span
     of attention, which is what lets the reduced-motion path freeze a frame
     and lose nothing. */
  float a = pool(uv, vec2(0.50 + sin(t * 0.37) * 0.012, 1.10 + sin(t * 0.23 + 1.7) * 0.010),
    vec2(1.20, 0.80), 0.60);
  float b = pool(uv, vec2(1.00 + sin(t * 0.29 + 2.4) * 0.010, -0.10 - sin(t * 0.19) * 0.012),
    vec2(1.00, 0.60), 0.55);

  /* Fibre. Static in screen space - the paper does not move, only the light
     does - and small enough that it only shows where a pool edge crosses it,
     which is where washi actually wicks. */
  float fibre = (vnoise(vUv * vec2(9.0, 6.0) + 31.7) - 0.5) * 0.06;
  a = clamp(a + fibre, 0.0, 1.0);
  b = clamp(b + fibre, 0.0, 1.0);

  col = mix(col, LILAC, a * POOL_A);
  col = mix(col, LILAC, b * POOL_B);

  /* Aspect-corrected, so it is a disc rather than an ellipse - the two washes
     above are ellipses because CSS gradients are, but a pool that tracks a
     pointer has to be round or it reads as a smear. Squared, so the falloff
     has no shoulder at all. */
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 pp = vec2((vUv.x - uPointer.x) * aspect, vUv.y - uPointer.y);
  float g = 1.0 - smoothstep(0.0, 0.62 * max(1.0, aspect * 0.62), length(pp));
  col = mix(col, LILAC, g * g * POOL_P * uPointer.z);

  /* Grain. Screen-fixed, so it reads as the tooth of the sheet rather than as
     film grain sitting on the page. */
  col += (vnoise(vPix * 0.80) - 0.5) * TOOTH;

  /* Dither, last, in the space the framebuffer quantises. Without it the whole
     ramp bands into visible contours - it is only about eight of the 256
     available levels deep.

     One tap, not two. The obvious way to build a triangular PDF is to
     difference two offset taps, but IGN is a dot product inside a fract: an
     offset of (37,17) adds dot((37,17), k) = 2.5823 to the argument, and the
     outer fract removes the integer part, so the second tap is very nearly the
     first and the difference collapses towards zero. A single uniform tap
     actually dithers.

     The coordinate comes from vPix rather than gl_FragCoord: gl_FragCoord is
     specified as mediump in GLSL ES 1.00 whatever the fragment default says,
     so on a device without highp it would have lost its mantissa near the
     bottom of a tall page and banded on its own. Wrapped to 256 as well, which
     costs nothing and keeps the argument small however large the buffer is. */
  col += (ign(mod(vPix, 256.0)) - 0.5) * DITHER;

  gl_FragColor = vec4(col, 1.0);
}`;

/* uScale carries dpr, so a CSS-pixel position lands on an exact device pixel. */
const MARK_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aCol;
uniform vec2 uScale;    // (2*dpr/fbW, -2*dpr/fbH)
uniform vec2 uOffset;   // scroll, CSS px, pre-snapped to device pixels
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec2 p = (aPos + uOffset) * uScale + vec2(-1.0, 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = aUv;
  vCol = aCol;
}`;

/* highp on the UV varying is not optional. mediump is fp16 on most mobile
   GPUs - about 2^-11 relative precision, which across a 2048px atlas is a
   whole texel of error, so glyphs sample their neighbours' ink. It is the
   classic WebGL 1 text-atlas bug.

   The atlas holds coverage in alpha and white in rgb, so a mark is its vertex
   colour masked by that coverage. Output is premultiplied, to pair with
   blendFunc(ONE, ONE_MINUS_SRC_ALPHA): during a view cross-fade two whole
   scenes overlap at partial alpha, and straight-alpha blending composites that
   wrong. */
const MARK_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform float uGamma;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  /* Compositing happens in gamma-encoded space, where dark ink over a light
     ground at 50% coverage lands nearer 74% apparent coverage than 50%. Every
     antialiased edge therefore comes out too dark and the whole page reads
     about half a weight heavier than the same type would in the DOM. Bending
     the coverage curve before the blend is a one-instruction approximation of
     compositing linearly, and it is what lets the weights in layout.js be the
     weights a typographer would actually choose. */
  float a = pow(texture2D(uTex, vUv).a, uGamma) * vCol.a;
  gl_FragColor = vec4(vCol.rgb * a, a);
}`;

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`${label} shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl, vs, fs, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, `${label} vertex`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label} link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/* ---------------------------------------------------------------------------
   Marks: the CPU-side vertex list.

   Eight floats a vertex (position, uv, rgba), six vertices a quad. A whole run
   is ONE quad wherever it can be - the atlas holds the run's bitmap intact, so
   there is no reason to cut it into glyphs unless the glyphs have moved. That
   takes the page from roughly a thousand quads to a few dozen.
   --------------------------------------------------------------------------- */
const FLOATS_PER_VERTEX = 8;
const FLOATS_PER_QUAD = FLOATS_PER_VERTEX * 6;

export class Marks {
  constructor(engine) {
    this.engine = engine;
    this.data = new Float32Array(FLOATS_PER_QUAD * 512);
    this.count = 0;   // quads
  }

  clear() { this.count = 0; }

  _room() {
    if ((this.count + 1) * FLOATS_PER_QUAD <= this.data.length) return;
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  /* One axis-aligned quad in CSS px with explicit UVs. Everything funnels here. */
  quad(x0, y0, x1, y1, u0, v0, u1, v1, col, alpha) {
    if (alpha <= 0.002 || x1 - x0 <= 0) return;
    this._room();
    const d = this.data;
    let o = this.count * FLOATS_PER_QUAD;
    const r = col[0];
    const g = col[1];
    const b = col[2];
    const put = (x, y, u, v) => {
      d[o++] = x; d[o++] = y; d[o++] = u; d[o++] = v;
      d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = alpha;
    };
    put(x0, y0, u0, v0);
    put(x1, y0, u1, v0);
    put(x0, y1, u0, v1);
    put(x1, y0, u1, v0);
    put(x1, y1, u1, v1);
    put(x0, y1, u0, v1);
    this.count++;
  }

  /* A solid rectangle: the same quad, pointed at the atlas's white texel.
     Rules, underlines, the focus ring and the traces are all this. */
  /* Snapped to whole device pixels, and never thinner than one. A solid mark
     has no coverage term - the white texel is alpha 1 across the whole quad and
     the context is created with antialias:false - so an unsnapped hairline is
     resolved by the rasteriser's binary pixel-centre test and comes out one
     device row here and two there. Which is exactly the thing a hairline rule
     must never do. */
  rect(x, y, w, h, col, alpha) {
    const d = this.engine.dpr;
    const [u, v] = this.engine.whiteUv;
    const x0 = Math.round(x * d) / d;
    const y0 = Math.round(y * d) / d;
    const x1 = Math.max(x0 + 1 / d, Math.round((x + w) * d) / d);
    const y1 = Math.max(y0 + 1 / d, Math.round((y + h) * d) / d);
    this.quad(x0, y0, x1, y1, u, v, u, v, col, alpha);
  }

  strokeRect(x, y, w, h, weight, col, alpha) {
    this.rect(x, y, w, weight, col, alpha);
    this.rect(x, y + h - weight, w, weight, col, alpha);
    this.rect(x, y + weight, weight, h - weight * 2, col, alpha);
    this.rect(x + w - weight, y + weight, weight, h - weight * 2, col, alpha);
  }

  /* A run at rest: one quad for the whole bitmap. */
  run(run, penX, baselineY, col, alpha) {
    /* A run that failed to pack has no atlas rect and its UVs are still zero -
       which points at the reserved white texel, so drawing it would paint a
       solid block of ink where the text should be. Missing text is a better
       failure than a censored bar. */
    if (!run.rect) return;
    /* A post-tracked run's glyphs are not where the bitmap put them, so it has
       to go out a glyph at a time. Only the name is post-tracked. */
    if (run.post) { this.runGlyphs(run, penX, baselineY, col, alpha); return; }
    const dpr = this.engine.dpr;
    const ox = Math.round(penX * dpr) - run.pad;
    const top = Math.round(baselineY * dpr) - run.devBaseline;
    const u = run.uvAll;
    this.quad(ox / dpr, top / dpr, (ox + run.devW) / dpr, (top + run.devH) / dpr,
      u[0], u[1], u[2], u[3], col, alpha);
  }

  /* ---- redaction -----------------------------------------------------------
     A run that has not resolved yet, drawn as the type it will be plus the bar
     it still is. `p` is how much of the run has been released, left to right.

     Everything here happens on ONE plane, which is the reason this page can do
     it and a page of DOM text cannot: the bar and the letters are the same
     kind of object in the same buffer, so a bar can end exactly where a letter
     starts rather than being a div stacked on top of a paragraph.

       - The revealed part is the run's own quad with its right edge and its
         right UV cut at the same fraction. The atlas holds the bitmap whole,
         so a partial run is a partial sample of it - no second rasterisation,
         no per-glyph loop, and the letter at the cut is sliced mid-stroke,
         which is what a retracting mask does and what a fade does not.
       - The bar is the remainder, at the hairline's value. Not black: a black
         censor bar over a name is a joke about classified documents. This is
         the same ink and very nearly the same alpha as every rule on the page,
         so the bar reads as the document's own line, thickened, temporarily
         standing where a line of type will be.
       - One device pixel at the retracting edge, darker, so the movement has a
         leading edge and reads as a mask being drawn back rather than as type
         fading up. It only exists while the seal is opening.

     The split is computed in DEVICE pixels and used for both the type and the
     bar, so the two always meet exactly and never leave a seam or an overlap
     of a fraction of a pixel. */
  redacted(run, penX, baselineY, col, alpha, p) {
    if (!run.rect) return;
    const dpr = this.engine.dpr;
    const pen = Math.round(penX * dpr);
    const ox = pen - run.pad;
    const top = Math.round(baselineY * dpr) - run.devBaseline;
    const adv = Math.max(1, Math.round(run.width * dpr));
    const split = pen + Math.round(adv * p);

    if (split > ox) {
      const f = Math.min(1, (split - ox) / run.devW);
      const u = run.uvAll;
      this.quad(ox / dpr, top / dpr, split / dpr, (top + run.devH) / dpr,
        u[0], u[1], u[0] + (u[2] - u[0]) * f, u[3], col, alpha);
    }

    const x0 = split / dpr;
    const w = (pen + adv) / dpr - x0;
    if (w <= 0) return;
    /* The bar is a shade taller than the capitals and sits a shade below the
       baseline, which is where a mask laid over a line of type would fall. */
    const a = run.ascent * 0.80;
    const d = run.descent * 0.55;
    this.rect(x0, baselineY - a, w, a + d, BAR_INK, BAR_ALPHA * alpha);
    if (p > 0.001) this.rect(x0, baselineY - a, 1 / dpr, a + d, BAR_INK, BAR_EDGE * alpha);
  }

  /* The same run, one quad a glyph, at the positions its tracking asks for.

     Snapping the ORIGIN to a whole device pixel and then adding integer slice
     offsets is what keeps this as sharp as the single-quad path: every texel
     still lands on exactly one screen pixel, and the sub-pixel letterfit the
     browser baked into the bitmap survives intact. Rounding each slice
     independently would destroy it. */
  runGlyphs(run, penX, baselineY, col, alpha) {
    if (!run.rect) return;
    const dpr = this.engine.dpr;
    const u = run.uv;
    const ox = Math.round(penX * dpr);
    const top = Math.round(baselineY * dpr) - run.devBaseline;
    for (let i = 0; i < run.n; i++) {
      if (run.dw[i] <= 0) continue;
      this.quad(
        (ox + run.dx[i]) / dpr, top / dpr,
        (ox + run.dx[i] + run.dw[i]) / dpr, (top + run.devH) / dpr,
        u[i * 4], u[i * 4 + 1], u[i * 4 + 2], u[i * 4 + 3], col, alpha);
    }
  }
}

/* A whole scene, as it stands. There is nothing else to draw: the language
   toggle is a cut and the view change is a cross-fade, so no path here has to
   interpolate one scene into another. `alpha` is the cross-fade; `hoverKey`
   names the one mark under the pointer, which darkens rather than moving. */
/* The top edge. The toggle is fixed now, so the document slides underneath it,
   and a control floating over a half-read line is the thing that would give
   the whole page away. Rather than mask the type - a rectangle of ground
   punched out of the page cuts glyphs in half, which looks like a bug - each
   mark simply loses its ink as it approaches the top: gone by `clear`, whole
   by `full`, smoothly between. A LINE fades, never part of one, so nothing is
   ever cut in half and nothing has an edge.

   Both bounds come from the scene, measured off the toggle's own ink in
   layout.js. */
export function drawScene(marks, scene, alpha = 1, hoverKey = null, reveal = null, fixedY = 0) {
  for (const it of scene.items) {
    /* A fixed mark belongs to the window rather than to the document, so the
       scroll the renderer is about to subtract is added back here. One number,
       and the toggle stays where it was put. */
    const y = it.fixed ? it.y + fixedY : it.y;
    let a = it.alpha * alpha;
    if (!it.fixed && scene.edge && fixedY > 0) {
      const vy = it.y - fixedY;
      if (vy <= scene.edge.clear) continue;
      if (vy < scene.edge.full) a *= (vy - scene.edge.clear) / (scene.edge.full - scene.edge.clear);
    }
    if (it.kind === 'rect') {
      marks.rect(it.x, y, it.w, it.h, it.color, a);
      continue;
    }
    const col = it.key === hoverKey ? HOVER_INK : it.color;
    const p = it.seal && reveal ? reveal(it.seal) : 1;
    if (p >= 0.999) marks.run(it.run, it.x, y, col, a);
    else marks.redacted(it.run, it.x, y, col, a, p);
  }
}

/* Hover resolves to the primary ink whatever the mark's resting value: the one
   thing a pointer has to say is "this one is live". */
const HOVER_INK = [0.133, 0.129, 0.118];

/* The redaction bar. One ink and one value for every bar on the page, whatever
   grey the type under it is set in: a bar that took its mark's colour would
   read as three different kinds of withholding, where a document has only one.
   0.17 is a hair over the hairline's 0.16 - the bar IS the page's rule, given
   a height. */
const BAR_INK = [0.133, 0.129, 0.118];
const BAR_ALPHA = 0.17;
const BAR_EDGE = 0.34;


/* ---------------------------------------------------------------------------
   The stage.
   --------------------------------------------------------------------------- */
export function createStage(canvas) {
  const opts = {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: true, powerPreference: 'low-power',
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  } catch (e) { gl = null; }
  if (!gl) return null;

  let ground;
  let marks;
  let gU;
  let gA;
  let mU;
  let mA;
  let groundBuf;
  let markBuf;
  let markCapacity = 0;
  let dpr = 1;
  let cssH = 1;

  /* Everything the GPU holds, in one function. A lost context takes all of it
     with it - programs, buffers, the texture - and the only way back is to
     make it all again, so it is worth being able to say that in one call. */
  function setup() {
    ground = program(gl, GROUND_VS, GROUND_FS, 'ground');
    marks = program(gl, MARK_VS, MARK_FS, 'marks');

    gU = {
      res: gl.getUniformLocation(ground, 'uRes'),
      time: gl.getUniformLocation(ground, 'uTime'),
      scroll: gl.getUniformLocation(ground, 'uScroll'),
      pointer: gl.getUniformLocation(ground, 'uPointer'),
    };
    gA = gl.getAttribLocation(ground, 'aPos');

    mU = {
      gamma: gl.getUniformLocation(marks, 'uGamma'),
      scale: gl.getUniformLocation(marks, 'uScale'),
      offset: gl.getUniformLocation(marks, 'uOffset'),
      tex: gl.getUniformLocation(marks, 'uTex'),
    };
    mA = {
      pos: gl.getAttribLocation(marks, 'aPos'),
      uv: gl.getAttribLocation(marks, 'aUv'),
      col: gl.getAttribLocation(marks, 'aCol'),
    };

    /* One oversized triangle beats a quad: no diagonal seam, three vertices. */
    groundBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, groundBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    markBuf = gl.createBuffer();
    markCapacity = 0;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  try {
    setup();
  } catch (e) {
    return null;
  }

  return {
    gl,

    /* Called after a webglcontextrestored event: every GL object created before
       the loss is dead, so they are all made again. The caller then has to
       re-upload the atlas, which relayout() does. */
    restore() {
      setup();
    },

    /* Returns the CSS width the layout should use: canvas.width / dpr, not
       innerWidth, so CSS-pixel space and device-pixel space stay exactly
       self-consistent even when innerWidth x dpr is fractional. */
    resize(w, h, ratio) {
      dpr = ratio;
      cssH = h;
      const pw = Math.max(1, Math.round(w * ratio));
      const ph = Math.max(1, Math.round(h * ratio));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      gl.viewport(0, 0, pw, ph);
      return { cssW: pw / ratio, cssH: ph / ratio };
    },

    render(marksList, texture, time, scrollY, pointer) {
      gl.clearColor(CONCRETE[0], CONCRETE[1], CONCRETE[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(ground);
      gl.uniform2f(gU.res, canvas.width, canvas.height);
      gl.uniform1f(gU.time, time);
      /* The ground keeps the unsnapped scroll: it is a continuous field and
         wants the smoothness. */
      gl.uniform1f(gU.scroll, scrollY / Math.max(cssH, 1));
      gl.uniform3f(gU.pointer, pointer ? pointer[0] : 0.5, pointer ? pointer[1] : 0.5, pointer ? pointer[2] : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, groundBuf);
      gl.enableVertexAttribArray(gA);
      gl.vertexAttribPointer(gA, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(gA);

      if (!marksList.count) return;

      gl.useProgram(marks);
      gl.uniform1f(mU.gamma, COVERAGE_GAMMA);
      gl.uniform2f(mU.scale, 2 * dpr / canvas.width, -2 * dpr / canvas.height);
      /* Type, unlike the ground, is snapped: the moment the page moves by half
         a device pixel every glyph in the document goes fractional and the
         whole page turns soft and stays soft. */
      gl.uniform2f(mU.offset, 0, -Math.round(scrollY * dpr) / dpr);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(mU.tex, 0);

      const used = marksList.count * FLOATS_PER_QUAD;
      gl.bindBuffer(gl.ARRAY_BUFFER, markBuf);
      if (marksList.data.length > markCapacity) {
        gl.bufferData(gl.ARRAY_BUFFER, marksList.data, gl.DYNAMIC_DRAW);
        markCapacity = marksList.data.length;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, marksList.data.subarray(0, used));
      }

      const stride = FLOATS_PER_VERTEX * 4;
      gl.enableVertexAttribArray(mA.pos);
      gl.vertexAttribPointer(mA.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(mA.uv);
      gl.vertexAttribPointer(mA.uv, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(mA.col);
      gl.vertexAttribPointer(mA.col, 4, gl.FLOAT, false, stride, 16);

      gl.drawArrays(gl.TRIANGLES, 0, marksList.count * 6);

      gl.disableVertexAttribArray(mA.pos);
      gl.disableVertexAttribArray(mA.uv);
      gl.disableVertexAttribArray(mA.col);
    },
  };
}
