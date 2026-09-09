/* ===========================================================================
   The layout engine.

   With no DOM there is no box model, so this file is the box model: it turns
   content.json into SCENES - flat lists of positioned runs and rectangles in
   CSS pixels, plus the regions that respond to a pointer.

   Two scenes are built at a time - the two views of ONE language. The previous
   version built all four, because a morph has to know where every glyph lands
   on the other side before it can start; a cut does not, and rasterising both
   languages doubled the atlas for a page that only ever shows one of them.
   Changing language re-runs this file and re-uploads the texture, which is the
   same work a resize already does, and lands on the next frame.

   Every item carries a stable `key`, which is what lets the hover state name a
   mark without knowing where it is.
   =========================================================================== */

/* ---- ink ------------------------------------------------------------------
   Three values of grey against the concrete, and nothing else. No accent
   colour: on a page this bare, one would become the loudest thing on it.

   Cool, like the ground. All three clear 4.5:1 against bare concrete AND
   against the darkest point of the wash - the second half is the constraint
   that actually sets them, since the CV scrolls straight through it. The quiet
   grey a designer reaches for first, around #85878c, measures 2.4:1 and is
   unreadable by any standard; hierarchy is carried by size, weight and
   tracking instead. */
export const INK = [0.078, 0.078, 0.094];    // #141418  primary       10.1:1
export const INK_2 = [0.247, 0.255, 0.278];  // #3f4147  prose          5.6:1
export const INK_3 = [0.286, 0.294, 0.318];  // #494b51  labels, meta   4.8:1
export const RULE = [0.078, 0.078, 0.094];   // primary, drawn at low alpha

/* ---- the two voices -------------------------------------------------------
   Archivo over Newsreader, and the division of labour between them is the
   whole typographic scheme: the grotesque is the STRUCTURE - the name, the
   nav, the section heads, every tracked capital - and the serif is the VOICE,
   the handful of places where a sentence is being spoken rather than a page
   being labelled. Nothing is set in both.

   Archivo is cut from the American gothics of nineteenth-century wood type and
   job printing, which is where this page's ancestry actually lies: brutalism
   in print is the jobbing printer's grid, not the Swiss one. Newsreader is a
   newspaper serif in its bones and a contemporary drawing on its surface.

   The name gets its own family name, which is really its own width: Archivo
   pinned at the top of its wdth axis. ctx.font is the CSS font shorthand and
   carries no font-variation-settings, so naming a family is the only way to
   choose an axis value from Canvas2D. See scripts/fetch-fonts.mjs.

   The CJK companions are appended as fallbacks, so a mixed string like
   "English, 中文" resolves per character without needing a second run. Noto
   Sans SC is 黑体 - square frame, near-monolinear - which is the argument
   Archivo makes in Latin; Noto Serif SC is 宋体, which is Newsreader's. */
const SANS = '"Archivo", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
const WIDE = '"Archivo Wide", "Archivo", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
const SERIF = '"Newsreader", "Noto Serif SC", ui-serif, Georgia, serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---- grid -----------------------------------------------------------------
   1 column on a phone, 2 on a tablet, 3 on a laptop, 4 on a wide display, and
   past 1440px the content stops growing so the gutters take the difference.

   Breakpoints sit between real logical widths rather than on round numbers.
   720 clears every phone portrait (max 430) and falls below every tablet
   portrait (min 744). 1120 clears iPad Pro landscape at 1024. 1600 is chosen
   so three things coincide at one number: the fourth column appears, the
   content reaches its 1440 maximum exactly (1600 - 2x80), and the type scale
   tops out. Above it the page is frozen and only the void grows.

   The gutter is a fraction of the CONTENT, not of the viewport: past the
   maximum width the block must be frozen, and a viewport-relative gutter would
   keep prising the columns apart out to 2560 while the content stood still. */
export function grid(vw, safeTop = 0, safeSide = 0) {
  const cols = vw < 720 ? 1 : vw < 1120 ? 2 : vw < 1600 ? 3 : 4;
  /* The margin also has to clear the landscape sensor housing, which
     viewport-fit=cover puts the page underneath. */
  const margin = Math.max(safeSide, clamp(vw * 0.055, 24, 80));
  const contentW = Math.round(Math.min(vw - margin * 2, 1440));
  const left = Math.round((vw - contentW) / 2);
  const gutter = Math.round(clamp(contentW * 0.030, 20, 44));
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

   Tracking interpolates too, and in the right direction: display type tightens
   as it grows, tracked capitals loosen as they shrink.

   `lh` is a multiple of the FONT SIZE, never of the font's bounding box. That
   distinction is the difference between a page that holds still and one that
   breathes unevenly: Archivo's box is about 1.30em and Noto Sans SC's 1.45em,
   so leading derived from the box gives Chinese ~12% more air at the same
   nominal size. Leading is computed once, from the English size, and both
   languages share it.

   The name carries a nominal 100 rather than a size. It is the one run whose
   size is a RESULT - see nameSetting() - and any number here would only be
   something to overwrite. */
function scale(vw) {
  const t = clamp((vw - 390) / (1600 - 390), 0, 1);
  const f = (a, b) => lerp(a, b, t);
  /* `zh` is the per-role correction for Chinese: a size factor, a floor in CSS
     px, and a weight step. See adapt(). */
  return {
    /* Han fills its em box and Latin does not, so a negative track that merely
       tightens Archivo would weld 菲 to 菲 at 200px. The Chinese name is the
       one run on the site that is LET OUT rather than pulled in. */
    name: { family: WIDE, size: 100, lh: 0.90, weight: 700, tracking: f(-0.005, -0.018), upper: true, zh: { k: 1, dw: -100, track: 0.06 } },
    role: { family: SANS, size: 12, lh: 1.2, weight: 700, tracking: f(0.16, 0.12), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    lede: { family: SERIF, size: f(22, 34), lh: 1.30, weight: 450, tracking: 0, zh: { k: 0.90, dw: -50 } },
    label: { family: SANS, size: f(10.5, 12), lh: 1.2, weight: 700, tracking: f(0.18, 0.15), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    value: { family: SERIF, size: f(17, 21), lh: 1.36, weight: 400, tracking: 0, zh: { k: 0.92, floor: 16 } },
    nav: { family: SANS, size: f(12, 14), lh: 1.2, weight: 700, tracking: f(0.14, 0.11), upper: true, zh: { k: 0.98, floor: 13, dw: -100 } },
    /* A section head has a whole column to itself and should take it. At 24px
       it is the second-largest thing on the site, which is the correct reading
       of a CV: the five words that say what kind of work this is. */
    section: { family: SANS, size: f(15, 24), lh: 1.1, weight: 700, tracking: f(0.12, 0.055), upper: true, zh: { k: 0.94, floor: 15, dw: -100 } },
    title: { family: SERIF, size: f(17, 21), lh: 1.32, weight: 400, tracking: 0, zh: { k: 0.92, floor: 16 } },
    meta: { family: SANS, size: f(11, 12.5), lh: 1.3, weight: 400, tracking: 0.02, zh: { k: 0.98, floor: 12 } },
    year: { family: SANS, size: f(11, 12.5), lh: 1.3, weight: 600, tracking: 0.04, zh: { k: 1, floor: 12 } },
    mail: { family: SERIF, size: f(17, 21), lh: 1.3, weight: 400, tracking: 0, zh: { k: 1 } },
  };
}

const lead = (role) => Math.round(role.size * role.lh);

/* Han glyphs fill their em box; Latin does not. Archivo's cap height is about
   0.73em and Newsreader's 0.70, while 沈 fills roughly 0.90, so at equal
   nominal size the Chinese carries perhaps a quarter more apparent mass.

   The correction tapers, because the error it fixes scales with size while the
   legibility risk scales against it - a factor right under a 34px lede would
   turn a 10px label into a grey block. Hence a band per role, with a floor in
   CSS px underneath it.

   Tracking becomes an absolute cap rather than a multiplier, so two labels that
   should look identical do not drift apart by a hundredth of an em; and it is
   never negative, since Han already touches its box.

   Weight steps down for the Han sans: 菲 packs fourteen strokes into the space
   an Archivo 'o' fills with one, so equal stem weight is far more ink per unit
   area - and this page sets its structure at 700, where that gap is widest. */
function adapt(role, lang) {
  if (lang !== 'zh') return role;
  const z = role.zh || {};
  const k = z.k === undefined ? 0.93 : z.k;
  return {
    ...role,
    size: Math.max(z.floor || 0, role.size * k),
    weight: Math.max(200, (role.weight || 400) + (z.dw || 0)),
    /* Tracking becomes an absolute value rather than a scaled one, and never
       a negative: `track` where a role names one, otherwise the Latin value
       capped, otherwise nothing. */
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
       compositor would do rather than the fault it looks like from a
       bounding box. It is bounded by a comma, which at the largest size on
       this site is about 15px, against a page margin that is never less
       than 24. */
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
    this.height = 0;
    this.blockH = 0;
  }

  /* Rasterise + place a run. Returns the run handle so callers can advance by
     its measured width. */
  text(key, str, role, x, baseline, color, opts = {}) {
    /* The Chinese corrections apply to Chinese. A string with no Han in it -
       an email address, "LinkedIn", "2020—22", "AIxist" - is the same object in
       both languages and is set identically in both, rather than shrinking by
       a tenth because the page around it changed language. */
    const spec = {
      ...adapt(role, HAN.test(str) ? this.lang : 'en'),
      text: role.upper ? str.toUpperCase() : str,
    };
    const run = this.engine.run(spec);
    let px = x;
    if (opts.align === 'right') px = x - run.width;
    else if (opts.align === 'center') px = x - run.width / 2;
    this.items.push({
      kind: 'text', key, run, x: px, y: baseline,
      color: color || INK, alpha: opts.alpha === undefined ? 1 : opts.alpha,
    });
    return run;
  }

  rect(key, x, y, w, h, color, alpha) {
    this.items.push({ kind: 'rect', key, x, y, w, h, color: color || RULE, alpha });
  }

  /* Hit regions are generous: the visual mark may be a 12px word, but the
     target that answers a finger is at least 44px in BOTH directions - which
     is the point of the rule, and which flooring only the height quietly
     misses. "中" sets about 13px wide; the mark is the label, not the button.
     main.js turns each of these into a real focusable DOM element. */
  hit(id, run, x, baseline, meta) {
    const h = Math.max(44, run.lineHeight + 16);
    const w = Math.max(44, run.width + 12);
    this.hits.push({
      id,
      x: Math.round(x + run.width / 2 - w / 2),
      y: Math.round(baseline - run.ascent - (h - run.lineHeight) / 2),
      w: Math.round(w),
      h: Math.round(h),
      ...meta,
    });
  }

  translate(dy) {
    for (const it of this.items) it.y += dy;
    for (const h of this.hits) h.y += dy;
    return this;
  }

  /* Items append (the chrome paints last, over the content); hits PREPEND, so
     tab order is reading order - Index, CV, EN, 中, then whatever the page
     itself offers. Painting order and focus order are different questions and
     want opposite answers here. */
  absorb(other) {
    this.items.push(...other.items);
    this.hits.unshift(...other.hits);
    return this;
  }
}

/* ---- the top band ---------------------------------------------------------
   Two views on the left, two languages on the right, and a rule under both,
   full content width. That rule is the top edge of the frame: everything below
   hangs off the same four verticals, and saying so at the top of the page is
   most of what makes a grid legible rather than merely present.
   Returns the y below which content may start. */
function band(scene, content, view, lang, g) {
  const S = scale(g.vw);
  const y = Math.round(clamp(g.vw * 0.05, 30, 62)) + g.safeTop;
  const dim = INK_3;

  /* Active and inactive differ in weight as well as tone. Tone alone is not
     enough here: the inactive value has to clear 4.5:1 like everything else,
     which leaves it close enough to the active one to be ambiguous. */
  const on = S.nav;
  const off = { ...S.nav, weight: 500 };
  const idx = scene.text('nav.index', content.nav.index[lang], view === 'index' ? on : off, g.left, y,
    view === 'index' ? INK : dim);
  /* The accessible name follows the drawn word, so a screen reader and the
     canvas never disagree about what the button says. */
  scene.hit('view:index', idx, g.left, y, { key: 'nav.index', label: content.nav.index[lang], lang: lang === 'zh' ? 'zh-Hans' : 'en', pressed: view === 'index' });

  const cvX = g.left + idx.width + Math.max(28, g.vw * 0.022);
  const cv = scene.text('nav.cv', content.nav.cv[lang], view === 'cv' ? on : off, cvX, y,
    view === 'cv' ? INK : dim);
  scene.hit('view:cv', cv, cvX, y, { key: 'nav.cv', label: content.nav.cv[lang], lang: lang === 'zh' ? 'zh-Hans' : 'en', pressed: view === 'cv' });

  /* The toggle shows both languages at once: the one you are not reading is
     the button. */
  const zh = scene.text('nav.zh', '中', { ...(lang === 'zh' ? on : off), tracking: 0 }, g.right, y,
    lang === 'zh' ? INK : dim, { align: 'right' });
  const zhX = g.right - zh.width;

  /* Wide enough that two 44px targets centred on their marks do not overlap:
     EN sets about 20px and 中 about 13px, so the gap has to carry the rest. */
  const gap = Math.max(32, g.vw * 0.022);
  const en = scene.text('nav.en', 'EN', lang === 'en' ? on : off, zhX - gap, y, lang === 'en' ? INK : dim, { align: 'right' });
  /* 中 is drawn first because EN is positioned relative to it, but the hits go
     in the order they are read - and the hit order is the tab order. */
  scene.hit('lang:en', en, zhX - gap - en.width, y, { key: 'nav.en', label: 'English', lang: 'en', pressed: lang === 'en' });
  scene.hit('lang:zh', zh, zhX, y, { key: 'nav.zh', label: '中文', lang: 'zh-Hans', pressed: lang === 'zh' });

  const ruleY = Math.round(y + en.descent + g.u * 1.8);
  scene.rect('band.rule', g.left, ruleY, g.contentW, 1, RULE, 0.34);
  return ruleY + 1;
}

/* ---- the name -------------------------------------------------------------
   The one run on the site whose size is a result rather than a setting: it is
   scaled so the longest line lands exactly on the right margin. The type is
   therefore a function of the measure, which is the oldest idea in letterpress
   display work and the reason a wood-type poster looks built rather than
   arranged.

   Three constraints bound it.

     - A ceiling in viewport heights, because 沈菲菲 is three characters and
       filling 1440px with three characters is 480px of glyph, which is a
       different page from this one. Capped, the Chinese name sets at the
       ceiling and leaves the right of the measure open; that asymmetry is the
       composition, not a failure of it.
     - A ceiling in ATLAS pixels. Every glyph here is rasterised into one
       texture, and a run wider than that texture cannot be packed at all - it
       would silently vanish. Setting the name word by word keeps each run
       under half the atlas, and 1800 device px leaves the margin for it.
     - On a PORTRAIT viewport the name breaks to one word a line. A tall
       narrow window fills its measure at a small size and then has half its
       height left over, which is how a name ends up as a caption with a hole
       under it; stacked, the same name is twice as tall and the page has a
       block at the top of it again.

   Words are separate runs positioned by measuring the prefix that precedes
   them, so the letterfit is exactly what the browser would have produced for
   the whole string. */
function nameSetting(engine, str, lang, g, vh) {
  const S = scale(g.vw);
  const role = adapt(S.name, HAN.test(str) ? lang : 'en');
  const text = str.toUpperCase();
  const words = text.includes(' ') ? text.split(/\s+/) : [text];
  const lines = (g.cols === 1 || vh > g.vw * 1.15) && words.length > 1 ? words : [text];

  /* Measured at a nominal 100px and scaled: Canvas2D advances are linear in
     font size to well within the half-pixel this is later rounded to. */
  const at = (t, size) => engine.measure({ ...role, size, text: t });
  const widest = Math.max(...lines.map((l) => at(l, 100)));
  /* Two ceilings, and both are needed. The first is per line, and it is what
     stops three Han characters from setting at 480px simply because three
     characters fit across a wide measure. The second is on the BLOCK, so that
     a stacked name cannot take a third of a short window twice over. */
  const ceiling = Math.min(clamp(vh * 0.22, 46, 210), (vh * 0.36) / (lines.length * role.lh));
  let size = Math.min(ceiling, (100 * g.contentW) / widest);

  /* The atlas bound, applied per word - the unit that is actually packed. */
  const widestWord = Math.max(...lines.map((l) => l.split(' ')).flat().map((w) => at(w, 100)));
  size = Math.min(size, (100 * 1800) / (engine.dpr * widestWord));

  /* One correction pass against the real runs. run() rounds the size to whole
     device pixels and the metrics move with it, so the linear prediction can
     be a pixel or two out - which on a line set flush to the margin is the
     difference between filling the measure and overrunning it. */
  const w = Math.max(...lines.map((l) => engine.measure({ ...role, size, text: l })));
  if (w > g.contentW) size *= g.contentW / w;

  return { role: { ...S.name, size }, lines, size };
}

/* Place one line of the name, word by word. */
function drawName(scene, key, line, role, x, baseline, color) {
  const words = line.split(' ');
  const spec = adapt(role, scene.lang);
  for (let i = 0; i < words.length; i++) {
    const dx = i ? scene.engine.measure({ ...spec, text: `${words.slice(0, i).join(' ')} ` }) : 0;
    scene.text(`${key}.${i}`, words[i], role, x + dx, baseline, color);
  }
}

/* ---- view: the index ------------------------------------------------------
   Who she is at the top, how to reach her at the bottom, and the space between
   them left empty on purpose. The two blocks are pinned to the frame rather
   than centred in it, which is what stops the page reading as a card floating
   in a window - a card has edges of its own, and they compete with the ones
   the browser already has.

   Both blocks are laid out from y = 0 and translated into place afterwards,
   because where the lower one goes depends on how tall both of them are.
   --------------------------------------------------------------------------- */
function indexHead(engine, content, lang, g, vh) {
  const scene = new Scene(engine, lang, g);
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  const name = nameSetting(engine, c.name[lang], lang, g, vh);
  const nameLead = Math.round(name.size * S.name.lh);

  /* Metrics come from the WORD runs, which are the runs that get drawn.
     Measuring the whole line instead would reserve a second copy of the name
     in the atlas at full width - and at this size that one run is wider than
     the texture, which forces the packer up to the next size and quadruples
     the memory for a bitmap nothing ever samples. */
  const nameSpec = adapt(name.role, HAN.test(c.name[lang]) ? lang : 'en');
  const words = name.lines.map((l) => l.split(' ')).flat();
  const runs = words.map((w) => engine.run({ ...nameSpec, text: w }));
  const inkAscent = Math.max(...runs.map((r) => r.inkAscent || r.capHeight));
  const inkDescent = Math.max(...runs.map((r) => r.inkDescent));

  /* Placed by ink, not by box: the first line's ink top lands exactly on the
     block's top edge whichever script is setting it. */
  let y = inkAscent;
  name.lines.forEach((line, i) => {
    drawName(scene, `index.name.${i}`, line, name.role, g.left, y + i * nameLead, INK);
  });
  y += (name.lines.length - 1) * nameLead + inkDescent;

  /* The role is the name's caption, and it is sized against the NAME rather
     than against the viewport - a fixed 15px label under a three-character
     Chinese name set at 200px is not the same object as the same label under a
     fourteen-character English one at 130. A ninth of the display size holds
     the two in the same relation whatever the measure does to them. */
  const roleRole = { ...S.role, size: clamp(name.size * 0.115, 12, 20) };
  const roleRun = engine.run({ ...adapt(roleRole, lang), text: c.role[lang].toUpperCase() });
  y += u * 2.2 + roleRun.ascent;
  scene.text('index.role', c.role[lang], roleRole, g.left, y, INK_3);
  y += roleRun.descent;

  /* The lede is tied to the grid rather than to an em measure: three tracks of
     four, two of three, everything otherwise. That is what keeps its ragged
     right edge landing on a line the rest of the page also uses - and it caps
     at 30em regardless, past which a serif this size stops being readable in
     one pass of the eye. */
  const span = g.cols >= 4 ? 3 : g.cols >= 3 ? 2 : g.cols;
  const ledeRole = adapt(S.lede, lang);
  const ledeW = Math.min(g.colX(span - 1) + g.colW - g.left, 30 * ledeRole.size);
  const ledeRun = engine.run({ ...ledeRole, text: 'H' });
  const ledeLead = lead(S.lede);
  const lines = wrap(engine, c.line[lang], ledeRole, ledeW);

  y += u * 5 + ledeRun.ascent;
  lines.forEach((t, i) => {
    scene.text(`index.lede.${i}`, t, S.lede, g.left, y + i * ledeLead, INK_2);
  });
  y += (lines.length - 1) * ledeLead + ledeRun.descent;

  scene.blockH = y;
  return scene;
}

function indexFoot(engine, content, lang, g) {
  const scene = new Scene(engine, lang, g);
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  /* Four across where a quarter of the content still holds a value on one or
     two lines; two across below that. Never one: four stacked fields is a
     list, and this is a specification. */
  const perRow = g.contentW >= 1000 ? 4 : 2;
  const fieldW = (g.contentW - g.gutter * (perRow - 1)) / perRow;

  const labelRun = engine.run({ ...adapt(S.label, lang), text: 'H' });
  const valueRun = engine.run({ ...adapt(S.value, lang), text: 'H' });
  const mailRun = engine.run({ ...adapt(S.mail, lang), text: c.contact.email });
  const valueLead = lead(S.value);

  const fields = c.fields.map((f) => ({
    f, texts: wrap(engine, f.value[lang], adapt(S.value, lang), fieldW),
  }));
  const rows = Math.ceil(fields.length / perRow);
  const rowLines = [];
  for (let r = 0; r < rows; r++) {
    let mx = 1;
    for (let i = r * perRow; i < Math.min(fields.length, (r + 1) * perRow); i++) {
      mx = Math.max(mx, fields[i].texts.length);
    }
    rowLines.push(mx);
  }

  scene.rect('index.rule', g.left, 0, g.contentW, 1, RULE, 0.34);

  const rowTop = [];
  let y = u * 2.6;
  for (let r = 0; r < rows; r++) {
    rowTop.push(y);
    y += labelRun.ascent + u * 1.7 + valueRun.ascent + (rowLines[r] - 1) * valueLead + valueRun.descent;
    if (r < rows - 1) y += u * 3;
  }

  fields.forEach((entry, i) => {
    const r = Math.floor(i / perRow);
    const x = g.left + (i % perRow) * (fieldW + g.gutter);
    const top = rowTop[r] + labelRun.ascent;
    scene.text(`index.field.${i}.label`, entry.f.label[lang], S.label, x, top, INK_3);
    const v0 = top + u * 1.7 + valueRun.ascent;
    entry.texts.forEach((t, k) => {
      scene.text(`index.field.${i}.value.${k}`, t, S.value, x, v0 + k * valueLead, INK);
    });
  });

  /* The contact line closes the page: the address flush left in the serif, the
     one outbound link flush right in the sans. Two marks on one baseline at
     the two edges of the measure - the same gesture as the nav, at the other
     end of the frame. */
  y += u * 4.5 + mailRun.ascent;
  const mail = scene.text('index.mail', c.contact.email, S.mail, g.left, y, INK);
  scene.hit('mail', mail, g.left, y, { key: 'index.mail', href: `mailto:${c.contact.email}`, label: c.contact.email });

  const li = scene.text('index.linkedin', c.contact.linkedin.label, S.mail, g.right, y, INK, { align: 'right' });
  scene.hit('linkedin', li, g.right - li.width, y, { key: 'index.linkedin', href: c.contact.linkedin.url, label: c.contact.linkedin.label });

  scene.blockH = y + mailRun.descent;
  return scene;
}

/* ---- view: the CV ---------------------------------------------------------
   A section is a full-width band: a rule across the measure, its name hanging
   in the first column, and its entries filling the columns to the right. The
   first column stays empty for the whole height of the section, which is the
   point - it is the vertical the eye tracks down, and it is worth a quarter of
   the page to state it clearly.

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

function measureSections(engine, content, lang, g, S) {
  const u = g.u;
  const m = cvMetrics(g);
  const titleRole = adapt(S.title, lang);
  const metaRole = adapt(S.meta, lang);
  const yearRole = adapt(S.year, lang);
  const titleLead = lead(S.title);
  const metaLead = lead(S.meta);
  const probe = engine.run({ ...titleRole, text: 'H' });
  const metaProbe = engine.run({ ...metaRole, text: 'H' });

  return content.cv.map((sec) => {
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
        ? u * 1.5 + metaProbe.ascent + (Math.max(org.length, 1) - 1) * metaLead + metaProbe.descent
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
    const height = u * 2.2
      + (m.hang ? 0 : head.lineHeight + u * 2.6)
      + Math.max(body, m.hang ? head.lineHeight + u * 2 : 0);
    return { sec, head, entries, rowH, height, probe, metaProbe, titleLead, metaLead };
  });
}

function cvView(engine, content, lang, g, vh, topY, measured) {
  const scene = new Scene(engine, lang, g);
  const S = scale(g.vw);
  const u = g.u;
  const m = cvMetrics(g);
  let y = topY + u * 9;

  measured.forEach((sec, si) => {
    scene.rect(`cv.${si}.rule`, g.left, Math.round(y), g.contentW, 1, RULE, 0.34);
    let top = y + u * 2.2;

    scene.text(`cv.${si}.head`, sec.sec.section[lang], S.section, g.left, top + sec.head.ascent, INK);
    if (!m.hang) top += sec.head.lineHeight + u * 2.6;

    sec.entries.forEach((en, ei) => {
      const col = ei % m.across;
      const row = Math.floor(ei / m.across);
      const x = m.x0 + col * (m.trackW + g.gutter);
      let ey = top;
      for (let r = 0; r < row; r++) ey += sec.rowH[r];

      ey += sec.probe.ascent;
      en.titles.forEach((t, k) => {
        scene.text(`cv.${si}.${ei}.title.${k}`, t, S.title, x, ey + k * sec.titleLead, INK);
      });
      ey += (en.titles.length - 1) * sec.titleLead;

      if (en.org.length || en.year) {
        ey += u * 1.5 + sec.metaProbe.ascent;
        en.org.forEach((t, k) => {
          scene.text(`cv.${si}.${ei}.org.${k}`, t, S.meta, x, ey + k * sec.metaLead, INK_3);
        });
        if (en.year) {
          scene.text(`cv.${si}.${ei}.year`, en.year, S.year, x + m.trackW, ey, INK_3, { align: 'right' });
        }
      }
    });

    y += sec.height + u * 4;
  });

  scene.height = Math.max(vh, y + Math.max(48, g.margin));
  return scene;
}

/* ---- entry point ----------------------------------------------------------
   Builds all four scenes against one atlas generation. Call engine.reset()
   before and engine.build() after: everything measured in between is what
   gets rasterised. */
export function buildScenes(engine, content, vw, vh, lang = 'en', safeTop = 0, safeSide = 0) {
  const g = grid(vw, safeTop, safeSide);
  const S = scale(vw);
  const scenes = {};

  /* The band is drawn into each scene separately, since it carries the
     active-state colours, but its geometry is identical everywhere. */
  const topY = band(new Scene(engine, lang, g), content, 'index', lang, g);
  const measured = measureSections(engine, content, lang, g, S);

  {
    for (const view of ['index', 'cv']) {
      let scene;
      if (view === 'index') {
        const head = indexHead(engine, content, lang, g, vh);
        const foot = indexFoot(engine, content, lang, g);
        /* Head under the band, foot on the floor, and whatever is left over in
           between. When the two cannot both fit, the page stops pinning the
           foot and simply scrolls: a contact line pushed off the bottom of a
           phone is worse than a scrollbar. */
        const floor = Math.max(g.margin, g.u * 4);
        const settled = vh - floor - foot.blockH;
        let headTop = topY + g.u * 7;
        /* The void between the two blocks is the composition and is allowed
           to be the largest thing on the page. It is not allowed to be the
           only thing on it: past the cap - reached on a very tall window, or
           one where the name has set small - the surplus goes back to the top
           margin instead of accumulating in the middle. */
        const void_ = clamp(vh * 0.42, 200, 560);
        const slack = settled - (headTop + head.blockH) - void_;
        if (slack > 0) headTop += slack;
        const footTop = Math.round(Math.max(settled, headTop + head.blockH + g.u * 8));
        scene = head.translate(headTop).absorb(foot.translate(footTop));
        scene.height = Math.max(vh, footTop + foot.blockH + floor);
      } else {
        scene = cvView(engine, content, lang, g, vh, topY, measured);
      }
      /* The band goes on last so its hit regions sit above the content's. */
      const chrome = new Scene(engine, lang, g);
      band(chrome, content, view, lang, g);
      scene.absorb(chrome);
      scenes[`${view}:${lang}`] = scene;
    }
  }

  return { scenes, grid: g, topY };
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
     display family for it leaves the first paint rendering Chinese in whatever
     the system happens to have. */
  const strings = [
    content.index.name[lang], content.index.role[lang], content.index.line[lang],
    ...content.index.fields.map((f) => f.label[lang] + f.value[lang]),
    ...content.cv.map((s) => s.section[lang]
      + s.entries.map((e) => (e.year || '') + e.title[lang] + (e.org ? e.org[lang] : '')).join('')),
    content.nav.index[lang], content.nav.cv[lang], '中',
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
