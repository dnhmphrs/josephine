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

   The ground is light now, which buys back the contrast that lets the
   secondary values be genuinely quiet - #605D51 is a soft warm grey rather
   than a near-black doing an impression of one, and it still measures 4.8:1
   over the deepest point of the wash, which is the constraint that sets it.
   Restraint here is a consequence of the ground, not a compromise with it. */
export const INK = [0.133, 0.129, 0.118];    // #22211e  primary       11.8:1
export const INK_2 = [0.310, 0.298, 0.263];  // #4f4c43  prose          6.3:1
export const INK_3 = [0.376, 0.365, 0.318];  // #605d51  labels, meta   4.8:1
export const RULE = [0.133, 0.129, 0.118];   // primary, drawn at low alpha

/* ---- the two voices -------------------------------------------------------
   Archivo over Newsreader, divided by job rather than by hierarchy: the
   grotesque is the STRUCTURE - the name, the toggle, the section heads, every
   tracked capital - and the serif is the VOICE, the places where a sentence is
   being spoken rather than a page labelled. Nothing is set in both.

   Both are set light and small. A face this neutral does not need weight to be
   certain, and a page that whispers in a large enough room is heard: the
   confidence here is meant to come from the space around the type and the
   exactness of the grid, never from the size of the letters.

   The CJK companions are appended as fallbacks, so a mixed string like
   "English, 中文" resolves per character without needing a second run. Noto
   Sans SC is 黑体 - square frame, near-monolinear - which is the argument
   Archivo makes in Latin; Noto Serif SC is 宋体, which is Newsreader's. */
const SANS = '"Archivo", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
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

   Nothing is set above 54px and nothing is heavier than 500. The whole scale
   spans about five to one, where a display page would span fifteen: hierarchy
   is carried by the space around a thing and by which of the two faces it is
   set in, which is a quieter instrument than size and a more exact one.

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
    name: { family: SANS, size: f(32, 54), lh: 1.06, weight: 500, tracking: f(-0.016, -0.026), zh: { k: 0.94, dw: -100, track: 0.02 } },
    role: { family: SANS, size: f(10.5, 12), lh: 1.2, weight: 500, tracking: f(0.17, 0.15), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    lede: { family: SERIF, size: f(19, 27), lh: 1.44, weight: 400, tracking: 0, zh: { k: 0.90, dw: -50 } },
    label: { family: SANS, size: f(10, 11), lh: 1.2, weight: 500, tracking: f(0.17, 0.15), upper: true, zh: { k: 0.98, floor: 11.5, dw: -100 } },
    value: { family: SERIF, size: f(15.5, 17.5), lh: 1.42, weight: 400, tracking: 0, zh: { k: 0.92, floor: 15 } },
    nav: { family: SANS, size: f(10.5, 11.5), lh: 1.2, weight: 500, tracking: f(0.17, 0.15), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    section: { family: SANS, size: f(10.5, 12), lh: 1.2, weight: 500, tracking: f(0.17, 0.15), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    title: { family: SERIF, size: f(16, 18.5), lh: 1.38, weight: 400, tracking: 0, zh: { k: 0.92, floor: 15 } },
    meta: { family: SANS, size: f(11, 12), lh: 1.35, weight: 400, tracking: 0.01, zh: { k: 0.98, floor: 12 } },
    year: { family: SANS, size: f(11, 12), lh: 1.35, weight: 500, tracking: 0.03, zh: { k: 1, floor: 12 } },
    mail: { family: SERIF, size: f(16, 18), lh: 1.35, weight: 400, tracking: 0, zh: { k: 1 } },
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
   The only control on the page, in the top right, showing both languages at
   once: the one you are not reading is the button. There is no rule under it
   and nothing opposite it - the top left of the page is left empty, because a
   wordmark there would be the name repeated a hundred pixels above itself.
   Returns the y below which content may start. */
function toggle(scene, lang, g) {
  const S = scale(g.vw);
  const y = Math.round(clamp(g.vw * 0.045, 30, 58)) + g.safeTop;
  const on = S.nav;
  /* Active and inactive differ in weight as well as tone. Tone alone is not
     enough: the inactive value still has to clear 4.5:1 like everything else,
     which leaves it close enough to the active one to be ambiguous. */
  const off = { ...S.nav, weight: 400 };

  const zh = scene.text('nav.zh', '中', { ...(lang === 'zh' ? on : off), tracking: 0 }, g.right, y,
    lang === 'zh' ? INK : INK_3, { align: 'right' });
  const zhX = g.right - zh.width;

  /* Wide enough that two 44px targets centred on their marks do not overlap:
     EN sets about 18px and 中 about 12px, so the gap has to carry the rest. */
  const gap = Math.max(32, g.vw * 0.022);
  const en = scene.text('nav.en', 'EN', lang === 'en' ? on : off, zhX - gap, y,
    lang === 'en' ? INK : INK_3, { align: 'right' });
  /* 中 is drawn first because EN is positioned relative to it, but the hits go
     in the order they are read - and the hit order is the tab order. */
  scene.hit('lang:en', en, zhX - gap - en.width, y, { key: 'nav.en', label: 'English', lang: 'en', pressed: lang === 'en' });
  scene.hit('lang:zh', zh, zhX, y, { key: 'nav.zh', label: '中文', lang: 'zh-Hans', pressed: lang === 'zh' });

  return y + en.descent;
}

/* ---- the opening ----------------------------------------------------------
   Name, what she does, one sentence, and the four facts - held to the first
   screen with a great deal of nothing around them.

   The space is the argument. Six short strings on a page this size could be
   set at any size at all; setting them small, and then leaving most of the
   window empty, is the difference between a page that asks to be believed and
   one that assumes it already is. Nothing here is centred, nothing is a card,
   and no line is longer than about sixty characters.
   --------------------------------------------------------------------------- */
function opening(scene, content, lang, g, vh, topY) {
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  /* The name may not wrap on a phone into something ragged, so it is measured
     against the measure and taken down if it would not fit. No floor: nothing
     downstream clips, and a name that overflows simply runs off the page. */
  const nameRole = adapt(S.name, HAN.test(c.name[lang]) ? lang : 'en');
  const natural = scene.engine.measure({ ...nameRole, text: c.name[lang] });
  const name = natural > g.contentW
    ? { ...S.name, size: S.name.size * (g.contentW / natural) }
    : S.name;
  const nameRun = scene.engine.run({ ...adapt(name, HAN.test(c.name[lang]) ? lang : 'en'), text: c.name[lang] });

  /* Placed by INK, not by the font box: a Latin cap height is about 0.73em
     against a box of 1.0, while the Han glyphs falling back into the same run
     reach 0.88 above the baseline. Setting a name by the box leaves the
     English floating; setting it by cap height drops 沈 into the line below. */
  let y = topY + u * 9 + (nameRun.inkAscent || nameRun.capHeight);
  scene.text('index.name', c.name[lang], name, g.left, y, INK);
  y += nameRun.inkDescent;

  const roleRun = scene.engine.run({ ...adapt(S.role, lang), text: c.role[lang].toUpperCase() });
  y += u * 2.4 + roleRun.ascent;
  scene.text('index.role', c.role[lang], S.role, g.left, y, INK_3);
  y += roleRun.descent;

  /* The lede is tied to the grid rather than to an em measure: two tracks of
     four, two of three, everything otherwise - and capped at 26em regardless,
     which is about sixty characters. Half the page width at the widest, which
     is what leaves the right-hand side of the opening empty. */
  const span = g.cols >= 3 ? 2 : g.cols;
  const ledeRole = adapt(S.lede, lang);
  const ledeW = Math.min(g.colX(span - 1) + g.colW - g.left, 26 * ledeRole.size);
  const ledeRun = scene.engine.run({ ...ledeRole, text: 'H' });
  const ledeLead = lead(S.lede);
  const lines = wrap(scene.engine, c.line[lang], ledeRole, ledeW);

  y += u * 5 + ledeRun.ascent;
  lines.forEach((t, i) => {
    scene.text(`index.lede.${i}`, t, S.lede, g.left, y + i * ledeLead, INK_2);
  });
  y += (lines.length - 1) * ledeLead + ledeRun.descent;

  /* Four across where a quarter of the content still holds a value on one or
     two lines; two across below that. Never one: four stacked facts is a list,
     and this is a caption. */
  const perRow = g.contentW >= 1000 ? 4 : 2;
  const fieldW = (g.contentW - g.gutter * (perRow - 1)) / perRow;
  const labelRun = scene.engine.run({ ...adapt(S.label, lang), text: 'H' });
  const valueRun = scene.engine.run({ ...adapt(S.value, lang), text: 'H' });
  const valueLead = lead(S.value);
  const fields = c.fields.map((f) => ({
    f, texts: wrap(scene.engine, f.value[lang], adapt(S.value, lang), fieldW),
  }));

  /* The facts sit at the FOOT of the first screen, not below the sentence -
     which puts the empty page between the two blocks, where it is a decision,
     rather than under them, where it is only what was left over. They fall
     back to flowing when the window is too short to hold both. */
  const rows = Math.ceil(fields.length / perRow);
  const rowLines = [];
  let fieldsH = 0;
  for (let r = 0; r < rows; r++) {
    let mx = 1;
    for (let i = r * perRow; i < Math.min(fields.length, (r + 1) * perRow); i++) {
      mx = Math.max(mx, fields[i].texts.length);
    }
    rowLines.push(mx);
    fieldsH += labelRun.ascent + u * 1.8 + valueRun.ascent + (mx - 1) * valueLead + valueRun.descent;
    if (r < rows - 1) fieldsH += u * 3.2;
  }

  const rowTop = [];
  y = Math.max(y + u * 9, vh - u * 16 - fieldsH);
  for (let r = 0; r < rows; r++) {
    rowTop.push(y);
    y += labelRun.ascent + u * 1.8 + valueRun.ascent + (rowLines[r] - 1) * valueLead + valueRun.descent;
    if (r < rows - 1) y += u * 3.2;
  }

  fields.forEach((entry, i) => {
    const x = g.left + (i % perRow) * (fieldW + g.gutter);
    const top = rowTop[Math.floor(i / perRow)] + labelRun.ascent;
    scene.text(`index.field.${i}.label`, entry.f.label[lang], S.label, x, top, INK_3);
    const v0 = top + u * 1.8 + valueRun.ascent;
    entry.texts.forEach((t, k) => {
      scene.text(`index.field.${i}.value.${k}`, t, S.value, x, v0 + k * valueLead, INK);
    });
  });

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
    const height = u * 2.4
      + (m.hang ? 0 : head.lineHeight + u * 2.6)
      + Math.max(body, m.hang ? head.lineHeight + u * 2 : 0);
    return { sec, head, entries, rowH, height, probe, metaProbe, titleLead, metaLead };
  });
}

function cvBlock(scene, content, lang, g, y0, measured) {
  const S = scale(g.vw);
  const u = g.u;
  const m = cvMetrics(g);
  let y = y0;

  measured.forEach((sec, si) => {
    scene.rect(`cv.${si}.rule`, g.left, Math.round(y), g.contentW, 1, RULE, HAIRLINE);
    let top = y + u * 2.4;

    scene.text(`cv.${si}.head`, sec.sec.section[lang], S.section, g.left, top + sec.head.ascent, INK_3);
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
        ey += u * 1.4 + sec.metaProbe.ascent;
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

  return y;
}

/* ---- the footer -----------------------------------------------------------
   A hairline and one line under it: the address at the left of the measure,
   the one outbound link at the right. Both in the serif, because both are
   things she is saying rather than labels on the page.
   --------------------------------------------------------------------------- */
function footer(scene, content, lang, g, y0) {
  const S = scale(g.vw);
  const c = content.index;
  const u = g.u;

  scene.rect('foot.rule', g.left, Math.round(y0), g.contentW, 1, RULE, HAIRLINE);
  const mailRun = scene.engine.run({ ...adapt(S.mail, lang), text: c.contact.email });
  const y = y0 + u * 3.4 + mailRun.ascent;

  const mail = scene.text('foot.mail', c.contact.email, S.mail, g.left, y, INK);
  scene.hit('mail', mail, g.left, y, { key: 'foot.mail', href: `mailto:${c.contact.email}`, label: c.contact.email });

  const li = scene.text('foot.linkedin', c.contact.linkedin.label, S.mail, g.right, y, INK, { align: 'right' });
  scene.hit('linkedin', li, g.right - li.width, y, { key: 'foot.linkedin', href: c.contact.linkedin.url, label: c.contact.linkedin.label });

  return y + mailRun.descent;
}

/* ---- entry point ----------------------------------------------------------
   Builds the scene against one atlas generation. Call engine.reset() before
   and engine.build() after: everything measured in between is what gets
   rasterised. */
export function buildScene(engine, content, vw, vh, lang = 'en', safeTop = 0, safeSide = 0) {
  const g = grid(vw, safeTop, safeSide);
  const S = scale(vw);
  const scene = new Scene(engine, lang, g);

  const topY = toggle(scene, lang, g);
  const openEnd = opening(scene, content, lang, g, vh, topY);

  /* The CV starts near the fold, and below it when the opening runs long. The
     first screen is therefore the opening and almost nothing else, which is
     the whole point of it; the hairline sitting just above the fold is what
     says there is more without needing to say so. */
  const cvTop = Math.round(Math.max(openEnd + g.u * 10, vh - g.u * 6));
  const measured = measureSections(engine, content, lang, g, S);
  const cvEnd = cvBlock(scene, content, lang, g, cvTop, measured);

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
    ...content.index.fields.map((f) => f.label[lang] + f.value[lang]),
    ...content.cv.map((s) => s.section[lang]
      + s.entries.map((e) => (e.year || '') + e.title[lang] + (e.org ? e.org[lang] : '')).join('')),
    '中',
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
