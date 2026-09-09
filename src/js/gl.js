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

/* The concrete. The ground shader's vertical mix averages to exactly this, and
   so does --concrete in styles/main.css, so the CSS ground and the first
   painted frame are the same grey and there is no flash between them. */
export const CONCRETE = [0.8353, 0.8275, 0.8078];   // #d5d3ce

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
   The ground: concrete, and one wash.

   Almost all of this shader is spent on things you are not meant to see - the
   uneven tone of a cast slab, the tooth of its surface, and a dither that stops
   a gradient eight levels deep from banding into contours on an 8-bit display.
   The only deliberate gesture is a single soft wash, low and to one side, with
   an edge that creeps the way ink creeps into damp washi and a faint darker rim
   where such a wash dries. The rest is 留白: negative space as the subject
   rather than the leftovers.

   Three decisions carry it:

     - The wash is COOL where the concrete is WARM (blue above red, against a
       ground with red above blue). That hue rotation, not darkness, is what
       makes a 5% mark read as ink rather than as a dirty smudge, and it lets
       the mark stay pale enough to never compete with the type.
     - The paper does not move, only the ink does. The fibre creep and the
       aggregate are fixed in screen space; the wash drifts through them on two
       incommensurate sines with periods of twenty-odd minutes. Over any span
       of attention it is still, which is the point - and it means the frozen
       frame the reduced-motion path renders loses nothing.
     - The dither is triangular (two decorrelated interleaved-gradient-noise
       taps, differenced) and applied last, in the space the framebuffer
       quantises. It is the most important term in the file.
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
varying vec2  vUv;       // y up
varying vec2  vPix;      // device px, at vertex precision

/* Mean of these two is exactly #d5d3ce. Warm-neutral: red above blue. */
const vec3 CONC_TOP = vec3(0.820, 0.812, 0.792);   // #d1cfca
const vec3 CONC_BOT = vec3(0.851, 0.843, 0.824);   // #d9d7d2
/* The ink is the reverse: blue above red, and never black. */
const vec3 INK      = vec3(0.541, 0.549, 0.565);   // #8a8c90
/* One trace of the lilac the previous WebGPU background was built on, kept at
   under one percent of the final pixel. Not a colour - the reason the deepest
   ink reads as wet. Set WET to 0.0 to remove it; nothing else depends on it. */
const vec3 LILAC    = vec3(0.416, 0.298, 0.769);   // #6a4cc4

const float WASH   = 0.105;        // peak ink density
const float WET    = 0.050;        // lilac in the ink, proportional to density
const float TOOTH  = 0.011;        // aggregate grain
const float DITHER = 2.0 / 255.0;  // 1/255 is pure TPDF; 2 also reads as surface
const float DRIFT  = 0.013;        // one full cycle, about twenty minutes

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

void main() {
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(vUv.x * aspect, vUv.y);      // height-normalised
  float t = uTime * DRIFT;

  /* The slab. One mix, and nothing else: no mottle, no vignette. Both were
     tried and both were removed - the dither and the aggregate below already
     give the surface its material. The mix runs on a diagonal rather than
     straight down, so the light pools away from the wash instead of on top of
     it: a vertical ramp puts its brightest band exactly where the ink sits and
     the two cancel. */
  vec3 col = mix(CONC_BOT, CONC_TOP, clamp(0.5 + 0.62 * (vUv.y - 0.5) - 0.34 * (vUv.x - 0.5), 0.0, 1.0));

  /* The gesture. Centre proportional to width, so it stays right of centre
     from a phone to an ultrawide, drifting on two periods that never coincide. */
  vec2 c = vec2(0.68 * aspect, 0.20);
  c += vec2(sin(t * 0.37), sin(t * 0.23 + 1.7)) * 0.035;
  c.y += clamp(uScroll, 0.0, 1.5) * 0.05;    // the wall lags the page a little

  /* Half-extents, clamped against the aspect so the mass stays a CORNER mass
     on a narrow viewport. Unclamped it grows wider than a phone screen and
     turns into a full-width band sitting under the name, which is a different
     picture from the one this is. */
  vec2 e = vec2(min(0.44 + 0.16 * aspect, 0.62 * aspect), 0.34);
  /* Rotated off the axes. Everything else in this shader - the noise lattice,
     the ground ramp, the viewport itself - is aligned to x and y, and a mass
     that shares that alignment reads as a gradient someone applied rather than
     as a stroke someone made. Twenty degrees is enough. */
  vec2 r0 = (p - c) / e;
  vec2 q = vec2(r0.x * 0.940 - r0.y * -0.342, r0.x * -0.342 + r0.y * 0.940);

  /* Asymmetric falloff - tighter above, bleeding below. This is the difference
     between a brushed form and a radial gradient: the upper edge, the one that
     meets the negative space, is the defined one. */
  q.y *= 1.0 + 0.34 * smoothstep(-0.6, 0.6, q.y);
  float d = length(q);

  /* Lobes: the shape of the stroke, drifting with the ink. */
  float w = vnoise(p * 1.2 + vec2(t * 0.50, -t * 0.31)) - 0.5;
  d += w * 0.62;

  /* Fibre creep. Static in screen space - the paper does not move. The
     smoothstep saturates the core, so this only shows at the edge, which is
     where sumi actually wicks into damp washi. */
  d += (vnoise(p * 12.0 + 31.7) - 0.5) * 0.075;

  float wash = 1.0 - smoothstep(0.16, 1.06, d);
  /* Pooling: densest where the lobe noise pushed the edge outward, which is
     w BELOW zero. Reading the multiplier off w directly puts the minimum
     exactly where the mass is deepest, which is the opposite of how ink
     settles. */
  wash *= mix(0.72, 1.0, 0.5 - w);
  float rim = smoothstep(0.02, 0.16, d) * (1.0 - smoothstep(0.16, 0.34, d));

  vec3 ink = mix(INK, LILAC, WET * wash);
  /* Capped at WASH. The rim peaks exactly where the wash does - both terms hit
     their maximum at d = 0.16 - so uncapped the darkest ground is 6% deeper
     than the number the ink palette's contrast was derived from, and the CV's
     smallest grey drops below 4.5:1 where it scrolls through it. */
  col = mix(col, ink, min(WASH, wash * WASH + rim * wash * 0.06));

  /* Aggregate. Screen-fixed, so it reads as the tooth of the wall rather than
     as film grain sitting on the page. */
  col += (vnoise(vPix * 0.80) - 0.5) * TOOTH;

  /* Dither, last, in the space the framebuffer quantises. Without it the whole
     wash bands into visible contours - the entire ramp is only about eight of
     the 256 available levels deep.

     One tap, not two. The obvious way to build a triangular PDF is to
     difference two offset taps, but IGN is a dot product inside a fract: an
     offset of (37,17) adds dot((37,17), k) = 2.5823 to the argument, and the
     outer fract removes the integer part, so the second tap is very nearly the
     first and the difference collapses towards zero. A single uniform tap
     actually dithers.

     The coordinate comes from vPix rather than gl_FragCoord: see the vertex
     shader. Wrapped to 256 as well, which costs nothing and keeps the argument
     small however large the framebuffer is. */
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
   blendFunc(ONE, ONE_MINUS_SRC_ALPHA): during a morph two glyph populations
   overlap at partial alpha, and straight-alpha blending composites that wrong. */
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

   Eight floats a vertex (position, uv, rgba), six vertices a quad. At rest a
   whole run is ONE quad - the atlas holds the run's bitmap intact, so there is
   no reason to cut it into glyphs until something has to move them. That takes
   the resting page from roughly a thousand quads to about a hundred and thirty.
   --------------------------------------------------------------------------- */
const FLOATS_PER_VERTEX = 8;
const FLOATS_PER_QUAD = FLOATS_PER_VERTEX * 6;
const IDENTITY = () => ({ x: 0, y: 0, s: 1, a: 1 });

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

  /* A hairline between two points. The attention traces are the only
     non-axis-aligned geometry on the page. */
  line(x0, y0, x1, y1, weight, col, alpha) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.01 || alpha <= 0.002) return;
    const nx = (-dy / len) * weight * 0.5;
    const ny = (dx / len) * weight * 0.5;
    const [u, v] = this.engine.whiteUv;
    this._room();
    const d = this.data;
    let o = this.count * FLOATS_PER_QUAD;
    const r = col[0];
    const g = col[1];
    const b = col[2];
    const put = (x, y) => {
      d[o++] = x; d[o++] = y; d[o++] = u; d[o++] = v;
      d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = alpha;
    };
    put(x0 - nx, y0 - ny); put(x1 - nx, y1 - ny); put(x0 + nx, y0 + ny);
    put(x1 - nx, y1 - ny); put(x1 + nx, y1 + ny); put(x0 + nx, y0 + ny);
    this.count++;
  }

  /* Where glyph i of a run sits at rest, in CSS px, given the run's pen origin
     and baseline. Snapping the ORIGIN to a whole device pixel and then adding
     integer slice offsets is what keeps static text sharp - every texel lands
     on exactly one screen pixel, and the sub-pixel letterfit the browser baked
     into the bitmap survives intact. Rounding each slice independently would
     destroy it. */
  glyphRect(run, penX, baselineY, i) {
    const dpr = this.engine.dpr;
    const ox = Math.round(penX * dpr);
    const top = Math.round(baselineY * dpr) - run.devBaseline;
    return {
      x0: (ox + run.dx[i]) / dpr,
      y0: top / dpr,
      x1: (ox + run.dx[i] + run.dw[i]) / dpr,
      y1: (top + run.devH) / dpr,
    };
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
    if (run.post) {
      this.runTransformed(run, penX, baselineY, col, alpha, IDENTITY);
      return;
    }
    const dpr = this.engine.dpr;
    const ox = Math.round(penX * dpr) - run.pad;
    const top = Math.round(baselineY * dpr) - run.devBaseline;
    const u = run.uvAll;
    this.quad(ox / dpr, top / dpr, (ox + run.devW) / dpr, (top + run.devH) / dpr,
      u[0], u[1], u[2], u[3], col, alpha);
  }

  /* A run whose glyphs are individually displaced, scaled and faded - the
     mechanism behind both the attention morph and the decode wipe.
     `xform(i, rect)` returns { x, y, s, a }: an offset in CSS px, a scale about
     the glyph's own centre and baseline, and an alpha multiplier. Returning a
     falsy value skips the glyph. */
  runTransformed(run, penX, baselineY, col, alpha, xform) {
    if (!run.rect) return;
    const u = run.uv;
    for (let i = 0; i < run.n; i++) {
      if (run.dw[i] <= 0) continue;
      const g = this.glyphRect(run, penX, baselineY, i);
      const tf = xform(i, g);
      if (!tf || tf.a <= 0.002) continue;
      const cx = (g.x0 + g.x1) * 0.5;
      const s = tf.s === undefined ? 1 : tf.s;
      this.quad(
        cx + (g.x0 - cx) * s + tf.x,
        baselineY + (g.y0 - baselineY) * s + tf.y,
        cx + (g.x1 - cx) * s + tf.x,
        baselineY + (g.y1 - baselineY) * s + tf.y,
        u[i * 4], u[i * 4 + 1], u[i * 4 + 2], u[i * 4 + 3], col, alpha * tf.a);
    }
  }
}

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

    render(marksList, texture, time, scrollY) {
      gl.clearColor(CONCRETE[0], CONCRETE[1], CONCRETE[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(ground);
      gl.uniform2f(gU.res, canvas.width, canvas.height);
      gl.uniform1f(gU.time, time);
      /* The ground keeps the unsnapped scroll: it is a continuous field and
         wants the smoothness. */
      gl.uniform1f(gU.scroll, scrollY / Math.max(cssH, 1));
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
