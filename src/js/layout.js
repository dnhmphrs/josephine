/* ===========================================================================
   The layout engine.

   With no DOM there is no box model, so this file is the box model: it turns
   content.json into a SCENE - a flat list of positioned runs and rectangles in
   CSS pixels, plus the regions that respond to a pointer.

   One page, read top to bottom: an opening, the CV under it, a footer at the
   end. One scene, in one language; changing language re-runs this file and
   re-uploads the texture, which is the same work a resize already does and
   lands on the next frame.

   Every item carries a stable `key`, which is what lets the hover state name a
   mark without knowing where it is.
   =========================================================================== */

/* ---- ink ------------------------------------------------------------------
   Three greys against the ground, warm like it, and nothing else.

   The ground is light, which buys back the contrast that lets the secondary
   values be genuinely quiet - #5B584C is a soft warm grey rather than a
   near-black doing an impression of one, and it still measures 4.77:1 over the
   deepest point of the wash, which is the constraint that actually sets it.
   Restraint here is a consequence of the ground, not a compromise with it.

   The ratios below are measured, not nominal: the shader is evaluated on a
   grid across time, both axes of the window and the whole length of the
   document, and each ink is checked against the darkest result. That is the
   number that has to clear 4.5:1, and it is what caps the wash - a deeper one
   would take the meta line under. */
export const INK = [0.133, 0.129, 0.118];    // #22211e  primary       10.8:1
export const INK_2 = [0.310, 0.298, 0.263];  // #4f4c43  prose          5.7:1
export const INK_3 = [0.357, 0.345, 0.298];  // #5b584c  labels, meta   4.77:1
export const RULE = [0.133, 0.129, 0.118];   // primary, drawn at low alpha
/* The ground itself, for the one place type is knocked OUT of ink rather than
   laid on it: the selected half of the language switch. Kept in step with
   CONCRETE in gl.js by hand - the shader paints a gradient around this mean,
   and a few thousandths either way is invisible under 11px capitals. */
export const PAPER = [0.894, 0.882, 0.859];  // #e4e1db

/* ---- the two voices -------------------------------------------------------
   Hanken Grotesk over Newsreader, divided by job rather than by hierarchy: the
   grotesque is the STRUCTURE - the name, the toggle, the section heads, every
   tracked capital - and the serif is the VOICE, the places where a sentence is
   being spoken rather than a page labelled. Nothing is set in both.

   Hanken Grotesk is the Swiss one without being a Helvetica tracing:
   horizontal terminals and a rational frame, but slightly open apertures and a
   generous x-height. That last part is what earns it the job here. A face has
   to hold a name at 52px AND a capital tracked to +0.15em at 10px, and the
   ones that manage the first usually shut down at the second. A grotesque with
   presence at 500 also lets the page stay quiet and still sound certain; the
   face this replaces needed weight to do the same work, and weight is what
   made the previous pass read as shouting.

   The CJK companions are appended as fallbacks, so a mixed string like
   "English, 中文" resolves per character without needing a second run. Noto
   Sans SC is 黑体 - square frame, near-monolinear - which is the argument the
   grotesque makes in Latin; Noto Serif SC is 宋体, which is Newsreader's. */
const SANS = '"Hanken Grotesk", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
const SERIF = '"Newsreader", "Noto Serif SC", ui-serif, Georgia, serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---- grid -----------------------------------------------------------------
   EDGE-BASED. The content spans the viewport less a margin, and that is all -
   there is no maximum width and nothing is centred in a field of empty gutter.

   The previous rule capped the content at 1440 and then centred it, which on a
   2560 display left 560px of nothing on each side. That is the worst of both
   conventions: it does not hug the edges, so the page has no frame; and it is
   not deliberately centred either, because the margins are set by a cap rather
   than by proportion. A reader reads it as a page that failed to fill its
   window. Hugging the edges is a decision; a cap is an accident.

   What a cap was protecting is the LINE MEASURE, and columns protect that
   better. So the column count keeps rising with the viewport - six of them
   past 2700 - and every track stays inside about 27em whatever the display
   does. The margin is proportional with a ceiling, so the frame reads as a
   frame rather than growing without limit.

   Breakpoints sit between real logical widths rather than on round numbers.
   720 clears every phone portrait (max 430) and falls below every tablet
   portrait (min 744). 1120 clears iPad Pro landscape at 1024. 1600, 2100 and
   2700 are where a track would otherwise pass 30em and stop being one glance. */
export function grid(vw, safeTop = 0, safeSide = 0) {
  const cols = vw < 720 ? 1 : vw < 1120 ? 2 : vw < 1600 ? 3 : vw < 2100 ? 4 : vw < 2700 ? 5 : 6;
  /* The margin also has to clear the landscape sensor housing, which
     viewport-fit=cover puts the page underneath. */
  const margin = Math.max(safeSide, clamp(vw * 0.038, 24, 96));
  const contentW = Math.round(vw - margin * 2);
  const left = Math.round(margin);
  const gutter = Math.round(clamp(contentW * 0.028, 20, 56));
  const track = (contentW - gutter * (cols - 1)) / cols;
  return {
    vw, safeTop, cols, margin, contentW, left, gutter,
    colW: track,
    right: left + contentW,
    colX: (i) => left + Math.round(i * (track + gutter)),
    /* One baseline unit for the whole site. Every vertical gap is a multiple. */
    u: Math.round(8 + 4 * clamp((vw - 390) / (1600 - 390), 0, 1)),
  };
}

/* ---- type scale -----------------------------------------------------------
   Every size interpolates across the same viewport range, so proportion
   changes smoothly instead of stepping at each breakpoint, and freezes where
   the content freezes. `upper` is a layout instruction, not a font one: there
   are no synthetic small caps here, just capitals with the tracking they need.

   Nothing is set above 54px and nothing is heavier than 600. The whole scale
   spans about five to one, where a display page would span fifteen: hierarchy
   is carried by the space around a thing and by which of the two faces it is
   set in, which is a quieter instrument than size and a more exact one. The
   tracked capitals sit at 600 rather than 500 because at 10-12px a grotesque
   loses more to the rasteriser than it does at 52, and a label that has been
   spaced to +0.15em needs the stem back. Their Chinese counterparts step back
   only one notch rather than two: 现在 has no capitals to be tracked and no
   case to distinguish it, so weight is the only thing left holding it apart
   from the entry titles under it.

   `lh` is a multiple of the FONT SIZE, never of the font's bounding box. That
   distinction is the difference between a page that holds still and one that
   breathes unevenly: Archivo's box is about 1.30em and Noto Sans SC's 1.45em,
   so leading derived from the box gives Chinese ~12% more air at the same
   nominal size. Leading is computed once, from the English size, and both
   languages share it. */
function scale(vw) {
  const t = clamp((vw - 390) / (1600 - 390), 0, 1);
  const f = (a, b) => lerp(a, b, t);
  /* `zh` is the per-role correction for Chinese: a size factor, a floor in CSS
     px, and a weight step. See adapt(). */
  return {
    name: { family: SANS, size: f(32, 54), lh: 1.05, weight: 500, tracking: f(-0.018, -0.028), zh: { k: 0.94, dw: -100, track: 0.02 } },
    /* The dateline, and the availability line opposite it. Smaller and tighter
       than the rest of the tracked capitals: at 12px on +0.15em these read as
       a caption stretched to fill a width, and a caption that has been let out
       reads as hesitant. Pulled in, they read as a masthead - which is what
       they are. The tracking still has to be positive, because capitals set
       solid are a wall, but only just. */
    role: { family: SANS, size: f(9.5, 10.8), lh: 1.2, weight: 600, tracking: f(0.13, 0.11), upper: true, zh: { k: 1, floor: 11, dw: -100 } },
    lede: { family: SERIF, size: f(19, 27), lh: 1.44, weight: 400, tracking: 0, zh: { k: 0.90, dw: -50 } },
    nav: { family: SANS, size: f(10.5, 11.5), lh: 1.2, weight: 600, tracking: f(0.17, 0.15), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    section: { family: SANS, size: f(10.5, 12), lh: 1.2, weight: 600, tracking: f(0.17, 0.15), upper: true, zh: { k: 1, floor: 13, dw: -100 } },
    title: { family: SERIF, size: f(16, 18.5), lh: 1.38, weight: 400, tracking: 0, zh: { k: 0.92, floor: 15 } },
    meta: { family: SANS, size: f(11, 12), lh: 1.35, weight: 400, tracking: 0.01, zh: { k: 0.98, floor: 12 } },
    year: { family: SANS, size: f(11, 12), lh: 1.35, weight: 600, tracking: 0.03, zh: { k: 1, floor: 12 } },
    /* The footer. Set BELOW the CV's entry titles rather than level with them:
       an address is not a heading, and at the serif's body size it was reading
       as one. Small enough to be a footnote, large enough to be a target. */
    link: { family: SERIF, size: f(14, 15.5), lh: 1.35, weight: 400, tracking: 0, zh: { k: 1 } },
  };
}

const lead = (role) => Math.round(role.size * role.lh);

/* Han glyphs fill their em box; Latin does not. Archivo's cap height is about
   0.73em and Newsreader's 0.70, while 沈 fills roughly 0.90, so at equal
   nominal size the Chinese carries perhaps a quarter more apparent mass.

   The correction tapers, because the error it fixes scales with size while the
   legibility risk scales against it - a factor right under a 27px lede would
   turn a 10px label into a grey block. Hence a band per role, with a floor in
   CSS px underneath it.

   Tracking becomes an absolute value rather than a scaled one, and never a
   negative: `track` where a role names one, otherwise the Latin value capped,
   otherwise nothing. Han already touches its box, so tightening it welds one
   character to the next.

   Weight steps down for the Han sans: 菲 packs fourteen strokes into the space
   an Archivo 'o' fills with one, so equal stem weight is far more ink per unit
   area. */
function adapt(role, lang) {
  if (lang !== 'zh') return role;
  const z = role.zh || {};
  const k = z.k === undefined ? 0.93 : z.k;
  return {
    ...role,
    size: Math.max(z.floor || 0, role.size * k),
    weight: Math.max(200, (role.weight || 400) + (z.dw || 0)),
    tracking: z.track !== undefined ? z.track : (role.tracking > 0 ? Math.min(0.08, role.tracking) : 0),
  };
}

/* ---- line breaking --------------------------------------------------------
   Break opportunities differ by script: English breaks at spaces, Chinese
   breaks between almost any two characters. Splitting into pieces where every
   Han character is its own piece handles both, and a mixed sentence, in one
   greedy pass. */
const HAN = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
const NO_LINE_START = '、。，．：；？！」』）”’,.:;?!)]}';

function pieces(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    if (HAN.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else if (ch === ' ') {
      out.push(buf + ' ');
      buf = '';
    } else if (ch === '-' || ch === '/') {
      /* A hyphenated compound breaks at its joint before it breaks anywhere
         worse. The break character stays on the first line, as it should. */
      out.push(buf + ch);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/* A token with no break opportunity in it and no room to sit - a URL, a very
   long compound - has to be cut somewhere, because nothing downstream clips and
   it would otherwise run off the page. Cut it by character. */
function hardBreak(engine, role, token, maxW, out) {
  let cur = '';
  for (const ch of token) {
    /* A cut that would open the next line with 、 or 。 is not a cut. Refusing
       it here matters because this runs AFTER the line breaker's own 禁则
       guard: without it, the guard declines a break, hands the overlong line
       down, and this re-cuts it blindly at exactly the place the guard was
       protecting.

       The consequence, in both places, is that a line ending in Chinese
       punctuation overhangs its measure by the width of that punctuation.
       That is ぶら下げ組 - hanging punctuation - and it is what a careful
       compositor would do rather than the fault it looks like from a bounding
       box. It is bounded by a comma, which at the largest size on this site is
       about 12px, against a page margin that is never less than 24. */
    if (cur && !NO_LINE_START.includes(ch) && engine.measure({ ...role, text: cur + ch }) > maxW) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  return cur;
}

function wrap(engine, text, role, maxW) {
  const parts = pieces(text);
  const lines = [];
  let cur = '';
  for (const p of parts) {
    const next = cur + p;
    if (engine.measure({ ...role, text: next.trimEnd() }) > maxW && cur.trim() && !NO_LINE_START.includes(p)) {
      lines.push(cur.trimEnd());
      cur = p.trimStart();
    } else {
      cur = next;
    }
    if (cur.trim() && engine.measure({ ...role, text: cur.trimEnd() }) > maxW) {
      cur = hardBreak(engine, role, cur.trimEnd(), maxW, lines);
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [text];
}

/* A greedy break fills every line to the measure and leaves whatever is left
   on the last one, which is how the sentence in the opening came to be set as
   seventy-five characters and then twenty-two. At display size that stub is
   the loudest thing in the block.

   So: break greedily to find how many lines the text needs, then find the
   NARROWEST measure that still needs exactly that many, and set it there.
   The paragraph occupies the same number of lines and distributes itself
   across them - no line is longer than the measure, so nothing downstream
   changes, and the ragged edge becomes a shape rather than an accident. Binary
   search, on a measurement that reserves no atlas space; eleven probes.

   It matters more in Chinese than in English: 二十四 characters at a measure
   that holds twenty-two is a line of twenty-two and a line of two. */
function balance(engine, text, role, maxW) {
  const lines = wrap(engine, text, role, maxW);
  if (lines.length < 2) return lines;

  /* The narrowest measure that still sets in this many lines. */
  let lo = 1;
  let hi = maxW;
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    if (wrap(engine, text, role, mid).length <= lines.length) hi = mid; else lo = mid;
  }

  /* Then the least ragged setting between there and the measure. Narrowest is
     not always best: it minimises the LONGEST line, which can leave the first
     one a word short while the others are full. Ragged-right is a shape, and
     the shape wanted is the one where the lines differ least. */
  const rag = (ls) => {
    const ws = ls.map((t) => engine.measure({ ...role, text: t }));
    return Math.max(...ws) - Math.min(...ws);
  };
  let best = lines;
  let bestRag = Infinity;
  for (let i = 0; i <= 12; i++) {
    const w = hi + ((maxW - hi) * i) / 12;
    const cand = wrap(engine, text, role, w);
    if (cand.length !== lines.length) continue;
    const r = rag(cand);
    if (r < bestRag - 0.5) { bestRag = r; best = cand; }
  }
  return best;
}

/* ---- scene builder --------------------------------------------------------
   A scene is assembled through this small recorder rather than by pushing
   objects around by hand, mostly so that every item is forced to declare a key.
   --------------------------------------------------------------------------- */
class Scene {
  constructor(engine, lang, g) {
    this.engine = engine;
    this.lang = lang;
    this.g = g;
    this.items = [];
    this.hits = [];
    /* Redaction seals - see seal(). */
    this.seals = [];
    /* Where the document has to have faded out by, under the fixed toggle.
       head() measures it; gl.js reads it. Null until then, and drawScene
       treats null as "no edge", which is what a scene without a toggle wants. */
    this.edge = null;
    this.height = 0;
  }

  /* The Chinese corrections apply to Chinese. A string with no Han in it - an
     email address, "LinkedIn", "2020—22", "AIxist" - is the same object in both
     languages and is set identically in both, rather than shrinking by a tenth
     because the page around it changed language. */
  spec(str, role) {
    return {
      ...adapt(role, HAN.test(str) ? this.lang : 'en'),
      text: role.upper ? str.toUpperCase() : str,
    };
  }

  /* Rasterise a run WITHOUT placing it. Two things on this page have to be
     measured before anything can be positioned - the name, which shares a
     baseline with a toggle it must not run into, and the credential line,
     whose separators sit between measured words - and a layout that places
     first and measures afterwards cannot do either. Runs are cached by spec,
     so preparing and then placing costs one rasterisation, not two. */
  prepare(str, role) {
    return this.engine.run(this.spec(str, role));
  }

  place(key, run, x, baseline, color, opts = {}) {
    let px = x;
    if (opts.align === 'right') px = x - run.width;
    else if (opts.align === 'center') px = x - run.width / 2;
    this.items.push({
      kind: 'text', key, run, x: px, y: baseline,
      color: color || INK, alpha: opts.alpha === undefined ? 1 : opts.alpha,
      seal: opts.seal || null,
      fixed: !!opts.fixed,
      /* Forces a mark into the toggle column's fade even though its own box
         does not reach x0. For the half of a two-run line whose other half
         does: they are one statement and must go out together. */
      edge: !!opts.edge,
    });
    return run;
  }

  /* Prepare and place in one move, which is what most of the page needs. */
  text(key, str, role, x, baseline, color, opts) {
    return this.place(key, this.prepare(str, role), x, baseline, color, opts);
  }

  rect(key, x, y, w, h, color, alpha, opts = {}) {
    /* opts.stroke draws the OUTLINE at that weight instead of filling. One
       caller: the language toggle's box. It stays a rect rather than becoming
       its own kind because everything about it - the colour, the alpha, the
       snapping, the exemption from the edge fade - is a rect's. */
    this.items.push({
      kind: 'rect', key, x, y, w, h,
      color: color || RULE, alpha, stroke: opts.stroke || 0, fixed: !!opts.fixed,
    });
  }

  /* Declare a seal: a group of runs that arrive under a bar of ink and are
     released together when the seal crosses the reveal line. The unit is the
     GROUP rather than the run, because a two-line title whose second line
     resolved out of step with its first would read as a fault. `top` is where
     the group sits in the document; `delay` staggers a row across its columns
     so a band opens left to right rather than all at once.

     Only the body is sealed. The opening never is - a name coming out from
     behind a censor bar is a joke about classified documents, and this is a
     page for someone who works on non-proliferation. */
  seal(key, top, delay = 0) {
    this.seals.push({ key, top: Math.round(top), delay });
    return key;
  }

  /* Hit regions are generous: the visual mark may be an 11px word, but the
     target that answers a finger is at least 44px in BOTH directions - which
     is the point of the rule, and which flooring only the height quietly
     misses. "中" sets about 12px wide; the mark is the label, not the button.
     main.js turns each of these into a real focusable DOM element. */
  hit(id, run, x, baseline, meta) {
    const h = Math.max(44, run.lineHeight + 16);
    const w = Math.max(44, run.width + 12);
    this.hits.push({
      id,
      fixed: !!(meta && meta.fixed),
      x: Math.round(x + run.width / 2 - w / 2),
      y: Math.round(baseline - run.ascent - (h - run.lineHeight) / 2),
      w: Math.round(w),
      h: Math.round(h),
      ...meta,
    });
  }
}

/* Rules are drawn at a fraction of the primary ink rather than as a grey of
   their own. One value, everywhere: a page whose hairlines vary in weight is a
   page with two grids on it. */
const HAIRLINE = 0.16;

/* ---- the toggle -----------------------------------------------------------
   The only control on the page, in the top right. ONE element: both scripts
   inside a single target, separated by a hairline, the language you are
   reading lit and the other one dim. Clicking anywhere on it switches.

   Two marks with two hit regions was the wrong object. It asked the reader to
   aim - to notice which half of a small pair of words is the one they want -
   and a control with two targets and two states is a pair of radio buttons
   pretending to be a switch. A switch shows you both positions and takes the
   press wherever it lands. Showing both also answers the harder case: a
   Chinese reader arriving on the English page can see that 中 exists without
   reading a word of English, and the reverse.

   Opposite it is the NAME, on the same baseline. It used to sit a hundred
   pixels lower with nothing beside the toggle, and the page opened on a strip
   of empty paper with one small control floating in it - which is the least
   confident thing a page can do. The two now share a line: the largest thing
   here and the smallest, on one baseline, at the two edges of the measure.

   Sharing a BASELINE and not a box is the whole point. Boxes of 54px and 11px
   have nothing in common; baselines are the line a compositor actually sets
   to, so the toggle reads as set on the name's line rather than as centred
   against its bounding rectangle.

   Two phases, because the name has to be measured against the space this
   leaves and drawn before it: plan() reserves the runs and reports the width,
   draw() puts them on a baseline it is given. */
/* The toggle is the one mark on the page that does not belong to the
   document: it belongs to the window. It is drawn FIXED - the renderer adds
   the scroll back for it - so it holds the position it takes at the top of the
   page for the whole scroll, which is both what a control should do and the
   only way it stays reachable on a document this long. Its hit region is
   fixed too, in its own layer outside the scroll proxy; see main.js. */
function planToggle(scene, content, lang, g) {
  const S = scale(g.vw);
  const on = S.nav;
  /* Lit and dim differ in weight as well as tone. Tone alone is not enough:
     the dim value still has to clear 4.5:1 like everything else, which leaves
     it close enough to the lit one to be ambiguous. */
  const off = { ...S.nav, weight: 400 };

  /* Both marks come from content.json rather than sitting here as literals:
     everything the encoder cannot see is a string that ships in plain sight. */
  const zh = scene.prepare(content.labels.zh, { ...(lang === 'zh' ? on : off), tracking: 0 });
  const en = scene.prepare(content.labels.en, lang === 'en' ? on : off);

  /* The box. Padding is asymmetric because the ink inside it is: the marks are
     capitals and 中, which have a cap height and no descender to speak of, so
     an equal inset would leave the box looking bottom-heavy. */
  /* Two halves, and the selected one is FILLED - ink block, ground-coloured
     type knocked out of it. It is the one place on the site where type is not
     laid on the paper but cut from it, and it is the right place: a switch has
     to say which way it is thrown, and nothing else here has state.

     No divider is drawn between the halves. The block's own edge is the
     division, and a rule beside it would be a second line saying the same
     thing. Each half carries the same padding, so the split sits where the
     geometry puts it rather than where the two words happen to end. */
  const ink = Math.round(Math.max(en.inkAscent || en.capHeight || 0, zh.inkAscent || zh.capHeight || 0));
  const padX = Math.round(Math.max(9, g.u * 0.78));
  const padY = Math.round(Math.max(7, g.u * 0.62));
  const enW = Math.round(en.width + padX * 2);
  const zhW = Math.round(zh.width + padX * 2);
  const boxW = enW + zhW;
  const boxH = ink + padY * 2;

  return {
    /* The box is what the page has to make room for now, not the marks. */
    width: boxW,
    ascent: padY + ink,
    descent: padY,
    draw(y) {
      const x0 = Math.round(g.right - boxW);
      const boxTop = Math.round(y - ink - padY);
      const on = lang === 'en' ? 0 : 1;

      /* Fill first, border over it, type last. */
      /* INK_2, not INK. A SOLID AREA of a value reads far heavier than strokes
         of it - the same black that is quiet as a 15px serif is a slab at
         30x11px - so the block is set one step back to weigh what the type
         around it weighs. At INK it was the darkest thing on the page by some
         way, which is too much authority for a language switch. */
      scene.rect('nav.fill', on ? x0 + enW : x0, boxTop, on ? zhW : enW, boxH, INK_2, 1, { fixed: true });
      /* The outline is what makes the unselected half read as the other half of
         one control rather than as a word standing next to a block. */
      scene.rect('nav.box', x0, boxTop, boxW, boxH, RULE, HAIRLINE * 1.6,
        { fixed: true, stroke: 1 });

      scene.place('nav.en', en, Math.round(x0 + (enW - en.width) / 2), y,
        on ? INK_2 : PAPER, { fixed: true });
      scene.place('nav.zh', zh, Math.round(x0 + enW + (zhW - zh.width) / 2), y,
        on ? PAPER : INK_2, { fixed: true });

      /* ONE hit, and it is the box: both halves do the same thing, and a
         border that is not itself pressable is a lie about where the edge of
         the control is. */
      const span = { width: boxW, lineHeight: boxH, ascent: ink + padY };
      scene.hit('lang:toggle', span, x0, y, {
        fixed: true,
        key: 'nav.box',
        other: lang === 'en' ? 'zh' : 'en',
        lang: lang === 'zh' ? 'zh-Hans' : 'en',
      });
    },
  };
}

/* ---- the head -------------------------------------------------------------
   Name, one credential line, one sentence. Three things, at the top of the
   page, and then a great deal of nothing.

   What was here before was a SPEC SHEET: four labelled fields - BASED,
   LANGUAGES, CURRENTLY, AVAILABLE FOR - ruled across the measure under the
   sentence. That is the format of an application, not of a page by someone who
   already holds the position, and no amount of spacing fixes it, because the
   form itself is what speaks. A grid of labelled cells says: here are my
   particulars, assess them.

   So the four facts are reduced to the two that are load-bearing and folded
   into ONE line under the name, without labels, next to the role:

       AI POLICY RESEARCHER | BERLIN | ENGLISH, 中文

   Nobody needs to be told that Berlin is where she is BASED; the word in that
   position is the label. Set inline, it is a dateline - the line under a
   masthead that says who is writing and from where - which is exactly the
   register wanted, because a dateline is context and a field is a claim.

   The other two facts leave the head entirely. CURRENTLY was already on the
   page: "Fellow, AIxist" is the first entry of the CV, with the year attached,
   forty lines further down and better said there. And AVAILABLE FOR goes to
   the footer, next to the address - the head now states who she is and the
   foot states how to reach her, which is the whole difference between a
   settled researcher and an application.

   The line's first segment is set in the primary ink and the rest in the
   quiet grey: the role is what she is, the two facts after it are the
   circumstances. Hierarchy inside one line, at one size.
   --------------------------------------------------------------------------- */
function head(scene, content, lang, g) {
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  const nav = planToggle(scene, content, lang, g);

  /* The name may not run into the toggle and may not wrap on a phone into
     something ragged, so it is measured against the space actually left beside
     the toggle and taken down if it would not fit. No floor: nothing
     downstream clips, and a name that overflows simply runs off the page. */
  const clear = Math.max(g.gutter, u * 4);
  const avail = g.contentW - nav.width - clear;
  const natural = scene.engine.measure(scene.spec(c.name[lang], S.name));
  const name = natural > avail ? { ...S.name, size: S.name.size * (avail / natural) } : S.name;
  const nameRun = scene.prepare(c.name[lang], name);

  /* Placed by INK, not by the font box: a Latin cap height is about 0.73em
     against a box of 1.0, while the Han glyphs falling back into the same run
     reach 0.88 above the baseline. Setting a name by the box leaves the
     English floating; setting it by cap height drops 沈 into the line below.

     The top of that INK - not the top of the font box, which would leave a
     quarter of an em of nothing above it - sits exactly one side margin down,
     so the page has one frame and the name touches it on two edges. This is
     the whole of note (a): the head is now as high as the frame allows, and
     the toggle came down to meet it. */
  const top = Math.max(26, Math.round(g.margin)) + g.safeTop;
  const y0 = Math.round(top + (nameRun.inkAscent || nameRun.capHeight));
  scene.place('index.name', nameRun, g.left, y0, INK);
  /* The toggle hangs from the TOP of the name, not from its baseline.

     Sharing a baseline is the obvious alignment and the wrong one: an 11px
     tracked capital and a 54px name have nothing like the same ink, so setting
     their feet level leaves the toggle at the bottom of the name's visual
     block, reading as something that has slipped. Matching their centres is
     better and still not right - it leaves the toggle floating in the middle
     of a space with no edge to hold it to.

     Now that it is a bordered box the alignment is the BOX's, not the ink's,
     and what the box is hung on is the frame: its optical centre sits on the
     name's cap-top line, which is the top margin, which is how the head is
     placed to begin with. So the line that starts the page passes through the
     middle of the control - the only alignment in the head that refers to
     something other than itself. The box stands a little proud of that line,
     which is what a control should do and a word should not. */
  const navY = Math.round(top + (nav.ascent - nav.descent) / 2);
  nav.draw(navY);


  /* The credential line. Segments are measured first, then packed into as many
     lines as they need - one at every width this site sees, two on a narrow
     phone in Chinese - and separated by the same hairline the toggle uses,
     drawn to the ink height of the capitals rather than to the leading. One
     device, used twice, is a page with a vocabulary; two devices are a page
     with a habit. */
  const creds = [{ key: 'index.role', text: c.role[lang], color: INK }]
    .concat(c.context.map((v, i) => ({ key: `index.context.${i}`, text: v[lang], color: INK_2 })));
  const sep = Math.round(Math.max(10, u * 1.1));

  /* The dateline is set to the NAME'S WIDTH. Not near it - to it.

     Two things stacked at the top left of a page either share an edge or they
     do not, and a dateline that stops a little short of the name above it
     reads as a measurement nobody took. Made exactly as wide, it reads as one
     object: the name, and the line that underwrites it.

     Solvable in closed form because width is linear in size - tracking is an
     em fraction, so every segment scales - and the only fixed term is the
     separators, which are struck from the layout unit rather than the type.
     So: measure once, subtract what does not scale, and divide.

     It applies only when the answer is close to the size the scale already
     wanted. Below 0.85 or above 1.45 the fit is refused and the base size
     stands, which is what happens on a phone and in Chinese - 沈菲菲 is three
     characters and its dateline is sixteen, so matching them would set the
     dateline at half its legible size. The rule is "share the edge where the
     edge can be shared", not "share it at any cost". */
  const roleFit = (() => {
    const fixed = (sep * 2 + 1) * (creds.length - 1);
    const total = (role) => creds.reduce((a, x) => a + scene.engine.measure(scene.spec(x.text, role)), 0);
    /* Solved by correction rather than in one step. Width is linear in size in
       principle, but a run is rasterised at whole DEVICE pixels, so the real
       function is a staircase and one division lands up to a dozen pixels out.
       Four passes take it inside one. measure() reserves no atlas space, so
       the extra passes cost nothing but arithmetic. */
    let size = S.role.size;
    for (let i = 0; i < 4; i++) {
      const w = total({ ...S.role, size });
      if (Math.abs(w + fixed - nameRun.width) < 0.5) break;
      size *= (nameRun.width - fixed) / Math.max(1, w);
    }
    const k = size / S.role.size;
    return k >= 0.85 && k <= 1.45 ? { ...S.role, size } : S.role;
  })();

  const runs = creds.map((x) => scene.prepare(x.text, roleFit));
  const barH = Math.round(Math.max(...runs.map((r) => r.inkAscent || r.capHeight)));

  /* The last few pixels go into the SEPARATORS, not the type. Rasterising at
     whole device pixels leaves the fitted row a handful of pixels out, and
     the honest place to spend that is the gap between segments - a hairline
     moved a pixel is invisible, where a type size chased to the pixel is a
     size nobody chose. Only when the fit was taken, and never tighter than a
     gap that still reads as one. */
  const gaps = creds.length - 1;
  const sepFit = roleFit !== S.role && gaps > 0
    ? Math.max(sep * 0.7, (nameRun.width - runs.reduce((a, r) => a + r.width, 0) - gaps) / (2 * gaps))
    : sep;

  const rows = [[]];
  let used = 0;
  runs.forEach((r, i) => {
    const first = rows[rows.length - 1].length === 0;
    const add = r.width + (first ? 0 : sepFit * 2 + 1);
    if (!first && used + add > g.contentW) { rows.push([]); used = r.width; } else { used += add; }
    rows[rows.length - 1].push(i);
  });

  /* Closer to the name than it was. The dateline belongs to the name - it is
     the line under a masthead, not the first line of the body - and a gap wide
     enough to be read as a paragraph break was saying otherwise. */
  let y = y0 + nameRun.inkDescent + u * 1.1 + runs[0].ascent;

  /* The fingerprint, on the credential line's baseline at the other end of the
     measure. It is the first 32 hex digits of a hash of the content (see
     rollup.config.mjs), and it is here because a page that has removed its own
     title, its description and every other way of being identified still has
     to be able to say WHICH document it is. A name would undo the whole
     exercise; a checksum says the same thing to a machine and nothing at all
     to an index. It also does the compositional work the head was missing -
     the right side of the page was empty from the toggle down, and this closes
     it with a mark that is deliberately unreadable. */
  /* Three seals across the head, not one per line. The redaction is a device
     for the page arriving, and a device that fires twenty times at once is a
     flicker; three bands opening a beat apart is a document being cleared. */
  const credSeal = scene.seal('head.cred', y, 0);


  rows.forEach((row, ri) => {
    let x = g.left;
    row.forEach((i, k) => {
      if (k) {
        scene.rect(`index.cred.${ri}.${k}`, Math.round(x + sepFit), Math.round(y - barH), 1, barH, RULE, 0.3);
        x += sepFit * 2 + 1;
      }
      scene.place(creds[i].key, runs[i], x, y, creds[i].color, { seal: credSeal });
      x += runs[i].width;
    });
    if (ri < rows.length - 1) y += lead(roleFit);
  });

  /* Availability, at the other end of the dateline's last baseline.

     Two things were wrong with it beside the sentence. It was ORPHANED - the
     only thing on the page aligned to nothing, floating in the white to the
     right of the lede with no baseline under it and no edge but the margin.
     And it was set in the same tracked capitals as the dateline, at the same
     weight, so it read as a second dateline that had come adrift, which is
     the one thing it must not be.

     Both are fixed by giving it a baseline that already exists and a form of
     its own. The rail is the right margin, which the toggle already occupies
     directly above, so the top of the page closes as a band: what she is on
     the left, what she is open to on the right, the control above them both.

     The form is a caption, not a banner. AVAILABLE FOR stays in the small
     tracked capitals - it is a label and should look like one - and the value goes
     into the SERIF, in sentence case, which is the register of something said
     rather than something declared. A list of three in tracked capitals is a
     banner however quietly it is set; the same three words in a roman are a
     note in the margin. That is the whole difference between "looking for
     work" and "settled, and available". */
  /* ONE REGISTER. The label and the value are both set in the dateline's own
     tracked capitals, at its size, in its quiet grey - so the top of the page
     is one band with a matching weight at each end, rather than a line of
     capitals facing a line of roman.

     Three earlier versions failed on the same fault in different ways. Beside
     the sentence in micro capitals it was orphaned - the only thing on the
     page aligned to nothing. On this baseline with the value in the serif, the
     two halves of one statement were set in two voices at two sizes, so the
     label read as a small prefix hanging off the front of a serif phrase
     rather than as its label. What was wrong was never the position. It was
     that the line kept being made of two different things. */
  const av = c.available;
  const avLabel = scene.prepare(av.label[lang], roleFit);
  const avValue = scene.prepare(av.value[lang], roleFit);
  const avGap = Math.round(Math.max(8, u * 0.7));
  const avW = avLabel.width + avGap + avValue.width;
  const avSeal = scene.seal('head.avail', y, 90);
  /* Only if it clears the dateline it shares the line with, by a full gutter.
     Otherwise it drops to its own baseline underneath, still on the right. */
  const avInline = avW + g.gutter <= g.contentW - used;
  let avY = y;
  if (!avInline) avY = y + lead(roleFit) + Math.round(u * 0.5);
  scene.place('index.available.value', avValue, g.right - avValue.width, avY, INK_2, { seal: avSeal });
  scene.place('index.available', avLabel, g.right - avW, avY, INK_3, { seal: avSeal, edge: true });

  /* The toggle's column, in viewport coordinates, handed to the renderer.

     The toggle is fixed, so the document slides under it, and a control
     sitting on a half-read line is what would give the whole page away. The
     answer is not to fade the top of the page - that was the first attempt and
     it was wrong in the most obvious way, because the name is AT the toggle's
     height, so the head went out the instant the page moved a pixel. Nothing
     is faded except what actually passes beneath the control: a mark is in
     scope only if its right edge reaches into x0, which is the toggle's own
     left edge less half a gutter. The name, the dateline, the sentence and
     every left-hand column are never touched at all.

     Inside that column a mark loses its ink as it rises: whole at FULL, gone
     at CLEAR. FULL is the availability line's own ink, because that is the
     topmost thing in this column when the page is at rest - so at rest
     everything here is at full strength and there is no step the moment
     scrolling starts. CLEAR is the frame: the same margin the name's ink
     touches. What passes directly under the toggle lands around a quarter
     alpha - a ghost the control reads cleanly over, rather than a hole cut in
     the page. */
  scene.edge = {
    x0: Math.round(g.right - nav.width - g.gutter * 0.5),
    clear: Math.round(navY - nav.ascent),
    full: Math.round(avY + avValue.inkDescent + 2),
  };

  y = avY + runs[0].descent;

  /* The sentence. Tied to the grid, but capped at 22em - about fifty
     characters, and short enough that the block reads as a statement rather
     than as a paragraph. It was 34em, which is eighty characters and most of
     the window: one very long line and then a stub. Twenty-two sets it as two
     balanced lines in both languages, with a shape of its own on the right.
     That is note (b), and it is also most of the answer to (f): the head is
     sharper because the sentence stops. */
  const span = g.cols >= 5 ? 3 : g.cols >= 3 ? 2 : g.cols;
  const ledeRole = adapt(S.lede, lang);
  const ledeW = Math.min(g.colX(span - 1) + g.colW - g.left, 22 * ledeRole.size);
  const ledeRun = scene.engine.run({ ...ledeRole, text: 'H' });
  const ledeLead = lead(S.lede);
  const lines = balance(scene.engine, c.line[lang], ledeRole, ledeW);

  /* Closer, now that the dateline has been pulled up and tightened. The gap
     was struck against a looser, larger line sitting further down; against
     this one it read as a hole. */
  y += u * 3.1 + ledeRun.ascent;
  const ledeSeal = scene.seal('head.lede', y, 90);
  lines.forEach((t, i) => {
    scene.text(`index.lede.${i}`, t, S.lede, g.left, y + i * ledeLead, INK_2, { seal: ledeSeal });
  });

  y += (lines.length - 1) * ledeLead + ledeRun.descent;
  return y;
}

/* ---- the CV ---------------------------------------------------------------
   A section is a band: a hairline across the measure, its name hanging in the
   first column, and its entries filling the columns to the right. The first
   column stays empty for the whole height of the section, which is the point -
   it is the vertical the eye tracks down, and it is worth a quarter of the
   page to state it once and keep it.

   Below three columns there is no column to hang in, so the name goes above
   its entries and they take the full measure. That is the same structure seen
   through a narrower window, not a second design.

   Entries read left to right within a section, top to bottom between them. No
   date rail: seven of thirteen entries carry no year, and a rail half full of
   blanks reads as missing data. The year goes to the right edge of its own
   entry, on the line with the organisation, where its absence is silence.
   --------------------------------------------------------------------------- */
function cvMetrics(g) {
  /* The hanging arrangement and the track it produces, in one place, so that
     measuring and drawing cannot disagree about it. */
  const hang = g.cols >= 3;
  const x0 = hang ? g.colX(1) : g.left;
  const across = hang ? g.cols - 1 : g.cols;
  const width = g.right - x0;
  const trackW = (width - g.gutter * (across - 1)) / across;
  return { hang, x0, across, trackW };
}

function measureSections(engine, sections, lang, g, S) {
  const u = g.u;
  const m = cvMetrics(g);
  const titleRole = adapt(S.title, lang);
  const metaRole = adapt(S.meta, lang);
  const yearRole = adapt(S.year, lang);
  const titleLead = lead(S.title);
  const metaLead = lead(S.meta);
  const probe = engine.run({ ...titleRole, text: 'H' });
  const metaProbe = engine.run({ ...metaRole, text: 'H' });

  return sections.map((sec, si) => {
    /* The first band opens under the threshold word, so it is given more air
       above its entries than the others: without it, CV and NOW stack a
       centimetre apart in the same column and read as one two-line label
       rather than as a heading and the first thing under it. */
    const topPad = u * 2.4 + (si === 0 ? u * 2.6 : 0);
    const head = engine.run({ ...adapt(S.section, lang), text: sec.section[lang].toUpperCase() });
    const entries = sec.entries.map((e) => {
      const year = e.year || '';
      const yearW = year ? engine.measure({ ...yearRole, text: year }) : 0;
      /* The organisation gives up the width the year needs, on every line and
         not only the first: nothing downstream clips, and a second line
         running under the year would collide with it. */
      const orgW = m.trackW - (yearW ? yearW + u * 2 : 0);
      const org = e.org && e.org[lang] ? wrap(engine, e.org[lang], metaRole, orgW) : [];
      const titles = wrap(engine, e.title[lang], titleRole, m.trackW);
      const metaH = (org.length || year)
        ? u * 1.4 + metaProbe.ascent + (Math.max(org.length, 1) - 1) * metaLead + metaProbe.descent
        : 0;
      return {
        e, titles, org, year,
        height: probe.ascent + (titles.length - 1) * titleLead + probe.descent + metaH + u * 3.4,
      };
    });

    /* Rows of `across` entries; a row is as tall as its tallest entry. */
    const rowH = [];
    for (let i = 0; i < entries.length; i += m.across) {
      rowH.push(Math.max(...entries.slice(i, i + m.across).map((x) => x.height)));
    }
    const body = rowH.reduce((a, b) => a + b, 0);
    const height = topPad
      + (m.hang ? 0 : head.lineHeight + u * 2.6)
      + Math.max(body, m.hang ? head.lineHeight + u * 2 : 0);
    return { sec, head, entries, rowH, height, topPad, probe, metaProbe, titleLead, metaLead };
  });
}

/* The threshold: one hairline across the measure, interrupted at the left by
   the word that names what is under it.

   It was the CV's alone and is now every block's, which is the point - the
   page is a sequence of named bodies of material, and the reader is told
   which one they have arrived in by the same device every time. One rule with
   a shoulder, no new weight, no new colour, no second grid. Returns the x the
   rule starts at, so a section rule further down the block can be drawn flush
   left and read as a lesser division of the same kind. */
function threshold(scene, blk, lang, g, y, S, u) {
  const label = scene.prepare(blk.label[lang], S.section);
  const lift = Math.round((label.inkAscent || label.capHeight) / 2);
  scene.place(`${blk.key}.label`, label, g.left, Math.round(y) + lift, INK);
  const ruleX = g.left + Math.round(label.width + Math.max(12, u * 1.4));
  scene.rect(`${blk.key}.rule`, ruleX, Math.round(y), g.right - ruleX, 1, RULE, HAIRLINE);
  return ruleX;
}

function block(scene, blk, lang, g, y0, measured) {
  const S = scale(g.vw);
  const u = g.u;
  const m = cvMetrics(g);
  const k = blk.key;
  let y = y0;

  /* A block with no sections is still a block: its threshold is drawn and a
     band of paper is reserved under it. That is what a placeholder IS here -
     the page shows where the material will go, at the size it will take, so
     the interval either side is being judged against the real thing. */
  if (!measured.length) {
    threshold(scene, blk, lang, g, y, S, u);
    return y + u * 9;
  }

  measured.forEach((sec, si) => {
    /* The threshold. The CV used to begin with nothing but a gap and then the
       first of five identical hairlines, so the reader crossed from the head
       into the record without being told - the rule that opens the CV looked
       exactly like the rule between CONVENING and BACKGROUND.

       So the first rule carries the word. "CV" is set on the rule, straddling
       it, and the rule starts after it: one hairline given a shoulder. It is
       the only rule on the page that is interrupted, which is what makes it a
       threshold and not a fourth kind of divider, and it costs no new weight,
       no new colour and no second grid. The word already existed in
       content.json waiting for it. */
    const ruleX = si === 0 ? threshold(scene, blk, lang, g, y, S, u) : g.left;
    if (si > 0) scene.rect(`${k}.${si}.rule`, ruleX, Math.round(y), g.right - ruleX, 1, RULE, HAIRLINE);
    let top = y + sec.topPad;

    const headSeal = scene.seal(`${k}.${si}.head`, top, 0);
    scene.text(`${k}.${si}.head`, sec.sec.section[lang], S.section, g.left, top + sec.head.ascent, INK_3,
      { seal: headSeal });
    if (!m.hang) top += sec.head.lineHeight + u * 2.6;

    sec.entries.forEach((en, ei) => {
      const col = ei % m.across;
      const row = Math.floor(ei / m.across);
      const x = m.x0 + col * (m.trackW + g.gutter);
      let ey = top;
      for (let r = 0; r < row; r++) ey += sec.rowH[r];

      /* One seal an ENTRY, not a run: a two-line title whose second line
         resolved out of step with its first reads as a fault rather than as a
         mask. The stagger is by COLUMN, so a band opens left to right. */
      const seal = scene.seal(`${k}.${si}.${ei}`, ey, col * 55);

      ey += sec.probe.ascent;
      en.titles.forEach((t, j) => {
        scene.text(`${k}.${si}.${ei}.title.${j}`, t, S.title, x, ey + j * sec.titleLead, INK, { seal });
      });
      ey += (en.titles.length - 1) * sec.titleLead;

      if (en.org.length || en.year) {
        ey += u * 1.4 + sec.metaProbe.ascent;
        en.org.forEach((t, j) => {
          scene.text(`${k}.${si}.${ei}.org.${j}`, t, S.meta, x, ey + j * sec.metaLead, INK_3, { seal });
        });
        if (en.year) {
          scene.text(`${k}.${si}.${ei}.year`, en.year, S.year, x + m.trackW, ey, INK_3, { align: 'right', seal });
        }
      }
    });

    y += sec.height + u * 4;
  });

  return y;
}

/* ---- the footer -----------------------------------------------------------
   A hairline, and under it one line: how to reach her, at the two edges of the
   measure - the same span the name and the toggle open on.

   AVAILABLE FOR passed through here on its way to the head, and the reason it
   did not stay is worth keeping: under the last rule, beside the way to answer
   it, it read as a note about what she takes on. That was true, and it was
   still forty lines below the only place a reader forms an impression. It is
   in the dateline now, on the same baseline as the role, which says the same
   thing at the top of the page instead of the bottom.

   The address and the link are taken down from the serif's body size to a
   footnote's. They were level with the CV's entry titles, which made the two
   quietest words on the page compete with its content.
   --------------------------------------------------------------------------- */
function footer(scene, content, lang, g, y0) {
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  /* The rules are NEVER sealed. The frame of the document is always drawn,
     whatever is or is not legible inside it. */
  scene.rect('foot.rule', g.left, Math.round(y0), g.contentW, 1, RULE, HAIRLINE);

  /* The foot sits on the CV's own grid rather than on the two edges of the
     measure. The address holds the left margin, the link starts where every
     entry above it starts, and the corner takes the mark - so the last line
     of the page is ruled by the same three positions as the forty above it,
     and nothing here is placed by eye.

     Below three columns there is no middle to sit in, so it stacks: the
     address, then the link with the mark opposite it. */
  const m = cvMetrics(g);
  const mailRun = scene.prepare(c.contact.email, S.link);
  const liRun = scene.prepare(c.contact.linkedin.label, S.link);
  const y = y0 + u * 3.2 + mailRun.ascent;
  const liY = m.hang ? y : Math.round(y + lead(S.link) * 1.15);
  const liX = m.hang ? m.x0 : g.left;
  const seal = scene.seal('foot.links', y - mailRun.ascent, 0);

  const mail = scene.place('foot.mail', mailRun, g.left, y, INK, { seal });
  scene.hit('mail', mail, g.left, y, { key: 'foot.mail', href: `mailto:${c.contact.email}`, label: c.contact.email });

  scene.place('foot.linkedin', liRun, liX, liY, INK, { seal });
  scene.hit('linkedin', liRun, liX, liY, { key: 'foot.linkedin', href: c.contact.linkedin.url, label: c.contact.linkedin.label });

  /* The end mark, and it is the GLYPH rather than a rectangle shaped like it.

     Drawn as a rect it had to be given a size, a colour and a corner by hand,
     and all three were wrong: too dark, too square, and a value nobody else on
     the page uses. The years already end in this character - it is what an
     open-ended one is closed with - so the mark is simply set, in the year's
     own role, at the year's own ink. Nothing to keep in step, because there is
     nothing to keep: it is the same run the CV sets forty lines above.

     Here it does what a printer's mark actually does - closes a document, at
     the end of it, with nothing after. That is the whole difference between
     this one and the one tried in the void and taken out; there, nothing was
     ending. */
  const end = scene.prepare(content.labels.end, S.year);
  scene.place('foot.end', end, g.right - end.width, liY, INK_3, { seal });

  return Math.max(y, liY) + mailRun.descent;
}

/* ---- entry point ----------------------------------------------------------
   Builds the scene against one atlas generation. Call engine.reset() before
   and engine.build() after: everything measured in between is what gets
   rasterised. */
export function buildScene(engine, content, vw, vh, lang = 'en', safeTop = 0, safeSide = 0) {
  const g = grid(vw, safeTop, safeSide);
  const S = scale(vw);
  const scene = new Scene(engine, lang, g);

  const headEnd = head(scene, content, lang, g);

  /* The head, a void, and then the blocks - each one a threshold rule with its
     name on it and its sections under it.

     The void is the largest interval on the page and the only one not doing
     any work, which is what makes it legible AS a division rather than as
     leftover paper: the reader has to cross it. It is deliberately deeper than
     it needs to be. The head is short - a name, a dateline, two lines of
     sentence - and the first threshold arriving close under it read as a
     caption to the sentence rather than as the start of a different kind of
     material.

     Between blocks the gap is a little over half that: enough that a threshold
     is never mistaken for the section rules inside the block above it, not so
     much that the page comes apart into three separate documents. */
  let y = Math.round(headEnd + g.u * 17);

  /* Nothing goes in the void, and that is the decision rather than the
     absence of one. A mark was tried here and taken out: the square already
     MEANS something on this page - it is what an open-ended year ends with,
     "still running" - and a second one floating with nothing to refer to makes
     it an ornament, which retroactively makes the year marks look like
     ornaments too. The gap is bounded by the tagline above and a ruled
     threshold below; it reads as deliberate because of what is on either side
     of it, not because something is in it. */

  content.blocks.forEach((blk, bi) => {
    if (bi) y = Math.round(y + g.u * 10);
    y = block(scene, blk, lang, g, y, measureSections(engine, blk.sections, lang, g, S));
  });
  const cvEnd = y;

  const footEnd = footer(scene, content, lang, g, cvEnd + g.u * 2);
  scene.height = Math.round(footEnd + Math.max(g.margin, g.u * 5));
  return { scene, grid: g };
}

/* Every face and sample the atlas will be asked for, so they can be fetched
   before the first rasterisation instead of after it.

   Split by language: making the first paint wait on the Chinese serif - which
   nothing on an English page sets - would be 74kB of nothing. main.js awaits
   the current language and lets the other arrive in its own time. The Chinese
   sans is critical in either language, because the toggle always shows 中. */
export function fontSpecs(content, vw, lang) {
  const S = scale(vw);
  const out = [];
  const seen = new Set();
  const add = (family, weight, size, sample) => {
    const key = `${family}|${weight}|${sample.length}|${sample.slice(0, 8)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ family, weight, size, sample });
  };

  /* Every string this language sets, so the request can be made per ROLE
     rather than per script. It is not enough to ask the display face for Han:
     the English page sets "English, 中文" in the serif, and asking only the
     sans for it leaves the first paint rendering Chinese in whatever the
     system happens to have. */
  const strings = [
    content.index.name[lang], content.index.role[lang], content.index.line[lang],
    ...content.index.context.map((v) => v[lang]),
    content.index.available.label[lang], content.index.available.value[lang],
    ...content.blocks.map((b) => b.label[lang]
      + b.sections.map((s) => s.section[lang]
        + s.entries.map((e) => (e.year || '') + e.title[lang] + (e.org ? e.org[lang] : '')).join('')).join('')),
    content.labels.zh, content.labels.end,
  ].join('');
  const exotic = [...new Set([...strings])].filter((c) => c.codePointAt(0) > 0x7f).join('');

  for (const key of Object.keys(S)) {
    const r = adapt(S[key], lang);
    add(r.family, r.weight, r.size, 'AaGgQq0123');
    for (let i = 0; i < exotic.length; i += 200) add(r.family, r.weight, r.size, exotic.slice(i, i + 200));
  }
  return out;
}

/* The other language's faces, for the deferred second pass. */
export function deferredFontSpecs(content, vw, lang) {
  return fontSpecs(content, vw, lang === 'en' ? 'zh' : 'en');
}
