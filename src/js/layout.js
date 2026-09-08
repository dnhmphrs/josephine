/* ===========================================================================
   The layout engine.

   With no DOM there is no box model, so this file is the box model: it turns
   content.json into SCENES - flat lists of positioned runs and rectangles in
   CSS pixels, plus the regions that respond to a pointer.

   Four scenes are built at once (card/cv x en/zh) because both halves of every
   transition have to exist simultaneously: the language morph interpolates a
   scene into its translation glyph by glyph, and it can only do that if it has
   already been told where every glyph lands on the other side.

   Every item carries a stable `key`. That key is the whole trick - it is what
   lets "the third CV entry's title" in English find "the third CV entry's
   title" in Chinese without either scene knowing the other exists.
   =========================================================================== */

/* ---- ink ------------------------------------------------------------------
   Three values of grey against the concrete, and nothing else. No accent
   colour: on a page this bare, one would become the loudest thing on it.

   All three clear 4.5:1 against the concrete AND against the darkest point of
   the wash - the second half is the constraint that actually sets them, since
   the CV's lower columns scroll straight through the wash. The quiet grey a
   designer reaches for first, around #85878c, measures 2.4:1 on bare concrete
   and 2.2:1 over the wash, which is unreadable by any standard. The hierarchy is
   carried by size, weight and tracking instead: an 11px capital tracked to
   +0.2em reads as an annotation whatever its value. */
export const INK = [0.086, 0.086, 0.102];    // #16161a  primary       12.1:1
export const INK_2 = [0.290, 0.298, 0.322];  // #4a4c52  prose          5.7:1
export const INK_3 = [0.333, 0.337, 0.361];  // #55565c  labels, meta   4.9:1
export const RULE = [0.086, 0.086, 0.102];   // primary, drawn at low alpha

/* Two voices, and the pairing is the brief resolved rather than split.
   "A modern, bold swiss serif, like a bauhaus font, paired with a slightly
   thinner modern serif" names one object and then a second: "Swiss" is the
   discipline (flush left, tight, capitals reserved for machinery), "Bauhaus"
   the formal instruction (geometric, monolinear, circular), and "modern serif"
   its type-historical sense - a Didone. So: a geometric sans of Futura lineage
   set with Swiss discipline, over a Bodoni. Futura-over-Bodoni is the canonical
   New Typography pairing; Tschichold threw out nearly every serif and kept the
   Didone.

   It also survives the constraint that actually decides this page: every string
   exists twice, so the Latin is never seen alone. Noto Sans SC is 黑体 -
   near-monolinear, open counters, square frame - and Jost is monolinear and
   circular. The two scripts agree in stroke and differ in form, which is what
   lets the morph read as a mapping rather than a dissolve.

   Bodoni's hairlines only survive small sizes if its optical-size axis is
   honoured, and ctx.font cannot express one, so the axis is pinned in
   @font-face under two family names: naming the family is how a size is
   chosen. See scripts/fetch-fonts.mjs.

   The CJK companions are appended as fallbacks, so a mixed string like
   "English, 中文" resolves per character without needing a second run. */
const DISPLAY = '"Jost", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
const SERIF_D = '"Bodoni Moda Lede", "Bodoni Moda", "Noto Serif SC", ui-serif, Georgia, serif';
const SERIF_T = '"Bodoni Moda Text", "Bodoni Moda", "Noto Serif SC", ui-serif, Georgia, serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---- grid -----------------------------------------------------------------
   1 column on a phone, 2 on a tablet, 3 on a laptop, 4 on a wide display, and
   past 1440px the content stops growing so the gutters take the difference.

   Breakpoints sit between real logical widths rather than on round numbers.
   720 clears every phone portrait (max 430) and falls below every tablet
   portrait (min 744), while catching phone landscape, where the viewport is
   ~380px tall and a second column buys back the height it costs. 1120 clears
   iPad Pro landscape at 1024 - three columns there would give a 284px measure,
   below the floor. 1600 is chosen so three things coincide at one number: the
   fourth column appears, the content reaches its 1440 maximum exactly
   (1600 - 2x80), and the type scale tops out. Above it the page is frozen and
   only the void grows, which is the 留白 argument made structural.

   The gutter is a fraction of the CONTENT, not of the viewport: past the
   maximum width the block must be frozen, and a viewport-relative gutter would
   keep prising the columns apart out to 2560 while the content stood still. */
export function grid(vw, safeTop = 0) {
  const cols = vw < 720 ? 1 : vw < 1120 ? 2 : vw < 1600 ? 3 : 4;
  const margin = clamp(vw * 0.055, 24, 80);
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
   are no synthetic small caps here, just capitals with the tracking they need
   to stay readable.

   Tracking interpolates too, and in the right direction: display type tightens
   as it grows, tracked capitals loosen as they shrink. Holding it constant
   leaves the name loose at 104px and the labels tight at 10px.

   `lh` is a multiple of the FONT SIZE, never of the font's bounding box. That
   distinction is the difference between a page that holds still through a
   language change and one that breathes: Jost's box is about 1.30em, Instrument
   Serif's 1.28em, Noto Sans SC's 1.45em, so leading derived from the box gives
   Chinese ~12% more air at the same nominal size and the whole page shifts
   under the morph. Leading is therefore computed once, from the English size,
   and both languages share it. */
function scale(vw) {
  const t = clamp((vw - 390) / (1600 - 390), 0, 1);
  const f = (a, b) => lerp(a, b, t);
  /* `zh` is the per-role correction for Chinese: a size factor, a floor in CSS
     px, and a weight step. See adapt(). */
  return {
    name: { family: DISPLAY, size: f(44, 104), lh: 0.98, weight: 600, tracking: f(-0.018, -0.032), zh: { k: 0.86, dw: -100 } },
    role: { family: DISPLAY, size: f(11, 13), lh: 1.2, weight: 500, tracking: f(0.24, 0.20), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    line: { family: SERIF_D, size: f(20, 30), lh: 1.42, weight: 400, tracking: 0, zh: { k: 0.90, dw: -50 } },
    label: { family: DISPLAY, size: f(10.5, 11.5), lh: 1.2, weight: 500, tracking: f(0.20, 0.16), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    value: { family: SERIF_T, size: f(15.5, 18.5), lh: 1.45, weight: 400, tracking: 0, zh: { k: 0.93, floor: 15 } },
    nav: { family: DISPLAY, size: f(11, 12.5), lh: 1.2, weight: 500, tracking: f(0.18, 0.14), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    section: { family: DISPLAY, size: f(10.5, 11.5), lh: 1.2, weight: 500, tracking: f(0.22, 0.18), upper: true, zh: { k: 0.98, floor: 12, dw: -100 } },
    title: { family: SERIF_T, size: f(16, 19), lh: 1.34, weight: 400, tracking: 0, zh: { k: 0.93, floor: 15 } },
    meta: { family: DISPLAY, size: f(10.5, 12), lh: 1.3, weight: 400, tracking: 0.05, zh: { k: 0.98, floor: 12 } },
    mail: { family: SERIF_T, size: f(15, 18), lh: 1.4, weight: 400, tracking: 0, zh: { k: 0.93, floor: 15 } },
  };
}

const lead = (role) => Math.round(role.size * role.lh);

/* Han glyphs fill their em box; Latin does not. Jost's cap height is about
   0.72em and Bodoni's about 0.70, while 沈 fills roughly 0.90, so at equal
   nominal size the Chinese carries perhaps a quarter more apparent mass.

   The correction has to taper, though, because the error it fixes scales with
   size while the legibility risk scales against it: 0.86 is right under the
   name and would turn a 10px label into a grey block. Hence a band per role
   rather than one factor, with a floor in CSS px underneath it - a tracked
   Latin small-cap and a Han label are simply not the same size, and pretending
   otherwise is what looks wrong.

   Tracking becomes an absolute cap rather than a multiplier, so two labels that
   should look identical do not drift apart by a hundredth of an em; and it is
   never negative, since Han already touches its box.

   Weight steps down for the Han sans: 菲 packs fourteen strokes into the space
   a Jost 'o' fills with one, so equal stem weight is far more ink per unit
   area. */
function adapt(role, lang) {
  if (lang !== 'zh') return role;
  const z = role.zh || {};
  const k = z.k === undefined ? 0.93 : z.k;
  return {
    ...role,
    size: Math.max(z.floor || 0, role.size * k),
    weight: Math.max(200, (role.weight || 400) + (z.dw || 0)),
    tracking: role.tracking > 0 ? Math.min(0.08, role.tracking) : 0,
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
    if (cur && engine.measure({ ...role, text: cur + ch }) > maxW) {
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
     its measured width. `mode` decides how the run behaves under a language
     change: 'attn' for the per-glyph attention morph, anything else for the
     decode wipe. See morph.js. */
  text(key, str, role, x, baseline, color, opts = {}) {
    /* The Chinese corrections apply to Chinese. A string with no Han in it -
       an email address, "LinkedIn", "2020—22", "AIxist" - is the same object in
       both languages and must be set identically, or the two scenes hold two
       nearly-identical runs, the morph treats them as a translation pair, and
       an email address dissolves into a 10%-smaller copy of itself. */
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
      mode: opts.mode || 'wipe', tier: opts.tier || 2, trace: !!opts.trace,
    });
    return run;
  }

  rect(key, x, y, w, h, color, alpha) {
    this.items.push({ kind: 'rect', key, x, y, w, h, color: color || RULE, alpha });
  }

  /* Hit regions are generous: the visual mark may be a 12px word, but the
     target that answers a finger is at least 44px in BOTH directions - which
     is the point of the rule, and which flooring only the height quietly
     misses. "中" sets about 11px wide; the mark is the label, not the button.
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
     tab order is reading order - Card, CV, EN, 中, then whatever the page
     itself offers. Painting order and focus order are different questions and
     want opposite answers here. */
  absorb(other) {
    this.items.push(...other.items);
    this.hits.unshift(...other.hits);
    return this;
  }
}

/* ---- the top band ---------------------------------------------------------
   Two views on the left, two languages on the right, and no rule under either.
   It is the only chrome on the site, and a rule would give the card a third
   horizontal line to argue with. Returns the y below which content may start. */
function band(scene, content, view, lang, g) {
  const S = scale(g.vw);
  const y = Math.round(clamp(g.vw * 0.05, 30, 62)) + g.safeTop;
  const dim = INK_3;

  const card = scene.text('nav.card', content.nav.card[lang], S.nav, g.left, y,
    view === 'card' ? INK : dim, { mode: 'attn' });
  /* The accessible name follows the drawn word, so a screen reader and the
     canvas never disagree about what the button says. */
  scene.hit('view:card', card, g.left, y, { key: 'nav.card', label: content.nav.card[lang], lang: lang === 'zh' ? 'zh-Hans' : 'en', pressed: view === 'card' });

  const cvX = g.left + card.width + Math.max(28, g.vw * 0.022);
  const cv = scene.text('nav.cv', content.nav.cv[lang], S.nav, cvX, y,
    view === 'cv' ? INK : dim, { mode: 'attn' });
  scene.hit('view:cv', cv, cvX, y, { key: 'nav.cv', label: content.nav.cv[lang], lang: lang === 'zh' ? 'zh-Hans' : 'en', pressed: view === 'cv' });

  /* The toggle shows both languages at once: the one you are not reading is
     the button. Nothing here morphs - it is a switch, and a switch that
     dissolves while you look at it is not a switch. */
  const zh = scene.text('nav.zh', '中', { ...S.nav, tracking: 0 }, g.right, y,
    lang === 'zh' ? INK : dim, { align: 'right' });
  const zhX = g.right - zh.width;

  /* Wide enough that two 44px targets centred on their marks do not overlap:
     EN sets about 18px and 中 about 11px, so the gap has to carry the rest. */
  const gap = Math.max(32, g.vw * 0.022);
  const en = scene.text('nav.en', 'EN', S.nav, zhX - gap, y, lang === 'en' ? INK : dim, { align: 'right' });
  /* 中 is drawn first because EN is positioned relative to it, but the hits go
     in the order they are read - and the hit order is the tab order. */
  scene.hit('lang:en', en, zhX - gap - en.width, y, { key: 'nav.en', label: 'English', lang: 'en', pressed: lang === 'en' });
  scene.hit('lang:zh', zh, zhX, y, { key: 'nav.zh', label: '中文', lang: 'zh-Hans', pressed: lang === 'zh' });

  return y + Math.max(20, g.vw * 0.018);
}

/* ---- view: the card -------------------------------------------------------
   An identity card, drawn as one bounded composition floating in the concrete:
   a hairline above, a hairline below, and between them the six facts that
   answer "who is this and how do I reach her". The email signs it, underneath.

   Laid out from y = 0 and translated into place afterwards, because the block
   is optically centred and its height depends on how many lines the prose and
   the field values take - which is not knowable until they are set.
   --------------------------------------------------------------------------- */
/* How many lines each slot of the card needs, in one language. The card is
   laid out to the LARGER of the two, so the two languages share one grid: the
   bottom rule, the email and every field sit at the same y whichever language
   you are reading. Without this the Chinese card - which is consistently more
   compact - pulls everything below the lede upward, and a morph turns into a
   reflow with two languages visible in two different places at once. */
function cardShape(engine, content, lang, g) {
  const S = scale(g.vw);
  const c = content.card;
  const perRow = g.cols <= 2 ? 2 : 4;
  const fieldW = (g.contentW - g.gutter * (perRow - 1)) / perRow;
  const proseW = Math.min(g.contentW, 30 * S.line.size);
  const lines = wrap(engine, c.line[lang], adapt(S.line, lang), proseW).length;
  const counts = c.fields.map((f) => wrap(engine, f.value[lang], adapt(S.value, lang), fieldW - 10).length);
  const rows = Math.ceil(c.fields.length / perRow);
  const rowLines = [];
  for (let r = 0; r < rows; r++) {
    let mx = 1;
    for (let i = r * perRow; i < Math.min(counts.length, (r + 1) * perRow); i++) mx = Math.max(mx, counts[i]);
    rowLines.push(mx);
  }
  return { lines, rowLines };
}

function cardBlock(engine, content, lang, g, shape) {
  const scene = new Scene(engine, lang, g);
  const S = scale(g.vw);
  const c = content.card;
  const u = g.u;

  /* Two fields across on a phone rather than four stacked: stacking costs
     ~100px, which is the difference between the card fitting on an iPhone SE
     and the card needing to scroll. */
  const perRow = g.cols <= 2 ? 2 : 4;
  const fieldW = (g.contentW - g.gutter * (perRow - 1)) / perRow;
  /* No prose run gets the full content width. 30em is about 60 characters,
     mid-band of the 45-75 that reads comfortably. */
  const proseW = Math.min(g.contentW, 30 * S.line.size);

  /* The name is the one run that may never wrap or overflow, so it is measured
     against the content width and taken down if it would not fit. */
  const nameRole = adapt(S.name, lang);
  const nameW = engine.measure({ ...nameRole, text: c.name[lang] });
  /* No floor. A floor would mean the "never wraps, never overflows" guarantee
     only holds up to some multiple of the content width, and nothing downstream
     clips - the name would simply run off the right of the page. */
  const fit = nameW > g.contentW ? g.contentW / nameW : 1;
  const name = { ...S.name, size: S.name.size * fit };

  const nameRun = engine.run({ ...adapt(name, lang), text: c.name[lang] });
  const roleRun = engine.run({ ...adapt(S.role, lang), text: c.role[lang].toUpperCase() });
  const labelRun = engine.run({ ...adapt(S.label, lang), text: 'H' });
  const valueRun = engine.run({ ...adapt(S.value, lang), text: 'H' });
  const lineRun = engine.run({ ...adapt(S.line, lang), text: 'H' });
  const mailRun = engine.run({ ...adapt(S.mail, lang), text: c.contact.email });

  const lines = wrap(engine, c.line[lang], adapt(S.line, lang), proseW);
  const fields = c.fields.map((f) => ({
    f, texts: wrap(engine, f.value[lang], adapt(S.value, lang), fieldW - 10),
  }));
  const rows = Math.ceil(fields.length / perRow);
  const rowLines = shape.rowLines;

  const LEAD = { line: lead(S.line), value: lead(S.value) };

  let y = 0;
  scene.rect('card.rule.top', g.left, 0, g.contentW, 1, RULE, 0.26);

  y += u * 2 + roleRun.ascent;
  scene.text('card.role', c.role[lang], S.role, g.left, y, INK_3, { mode: 'attn', tier: 1 });

  y += u * 2.6 + (nameRun.capHeight || nameRun.ascent * 0.72);
  scene.text('card.name', c.name[lang], name, g.left, y, INK, { mode: 'attn', tier: 1, trace: true });

  /* The lede's slot is as tall as the language that needs the most lines, so
     that everything below it holds still through a morph. The language that
     needs fewer sits centred in the slot rather than at the top of it, which
     halves the hole and keeps the card looking composed rather than short. */
  y += u * 2.4 + lineRun.ascent;
  const slack = Math.max(0, shape.lines - lines.length) * LEAD.line * 0.5;
  lines.forEach((t, i) => {
    scene.text(`card.line.${i}`, t, S.line, g.left, y + slack + i * LEAD.line, INK_2, { mode: 'attn' });
  });
  y += (shape.lines - 1) * LEAD.line;

  y += u * 3.6 + labelRun.ascent;
  const fieldTop = y;
  fields.forEach((entry, i) => {
    const row = Math.floor(i / perRow);
    let rowY = fieldTop;
    for (let r = 0; r < row; r++) {
      rowY += u * 1.7 + valueRun.ascent + (rowLines[r] - 1) * LEAD.value + u * 2.6 + labelRun.ascent;
    }
    const x = g.left + (i % perRow) * (fieldW + g.gutter);
    scene.text(`card.field.${i}.label`, entry.f.label[lang], S.label, x, rowY, INK_3, { mode: 'attn' });
    const v0 = rowY + u * 1.7 + valueRun.ascent;
    entry.texts.forEach((t, k) => {
      scene.text(`card.field.${i}.value.${k}`, t, S.value, x, v0 + k * LEAD.value, INK, { mode: 'attn' });
    });
  });
  for (let r = 0; r < rows; r++) {
    y += u * 1.7 + valueRun.ascent + (rowLines[r] - 1) * LEAD.value;
    if (r < rows - 1) y += u * 2.6 + labelRun.ascent;
  }

  y += u * 3 + valueRun.descent;
  scene.rect('card.rule.bottom', g.left, Math.round(y), g.contentW, 1, RULE, 0.26);

  y += u * 2.4 + mailRun.ascent;
  const mail = scene.text('card.mail', c.contact.email, S.mail, g.left, y, INK);   /* same run in both languages: it persists */
  scene.hit('mail', mail, g.left, y, { key: 'card.mail', href: `mailto:${c.contact.email}`, label: c.contact.email });
  scene.rect('card.mail.rule', g.left, Math.round(y + mailRun.descent * 0.5), mail.width, 1, INK, 0.3);

  const li = scene.text('card.linkedin', c.contact.linkedin.label, S.nav, g.right, y, INK_3, { align: 'right' });
  scene.hit('linkedin', li, g.right - li.width, y, { key: 'card.linkedin', href: c.contact.linkedin.url, label: c.contact.linkedin.label });

  scene.blockH = y + mailRun.descent;
  return scene;
}

/* ---- view: the CV ---------------------------------------------------------
   Sections are packed into columns whole and in order: the columns are
   contiguous slices of the list, chosen to minimise the tallest column. That
   keeps reading order intact - a CV read top-to-bottom, left-to-right, exactly
   like a printed one - which greedy shortest-column packing does not, and it
   can never split a section, so no entry is ever orphaned from its heading.

   The split is computed once from the taller of the two languages, so
   switching language reflows the type without ever moving a section sideways.

   There is no date rail. Seven of thirteen entries carry no year, so a rail
   renders as a half-empty column and reads as missing data; the year goes on
   the meta line instead, where its absence is simply silence.
   --------------------------------------------------------------------------- */
function measureSections(engine, content, lang, g, S) {
  const u = g.u;
  const LEAD = { title: lead(S.title), meta: lead(S.meta) };
  const head = (sec) => engine.run({ ...adapt(S.section, lang), text: sec[lang].toUpperCase() });
  const probe = engine.run({ ...adapt(S.title, lang), text: 'H' });
  const metaProbe = engine.run({ ...adapt(S.meta, lang), text: 'H' });

  return content.cv.map((sec) => {
    const h = head(sec.section);
    const entries = sec.entries.map((e) => {
      const titles = wrap(engine, e.title[lang], adapt(S.title, lang), g.colW);
      const bits = [e.year, e.org && e.org[lang] ? e.org[lang] : ''].filter(Boolean);
      /* The meta line wraps like the title does. It is usually one line, but
         "2023—  ·  Civil society, industry, institutions" in a 328px column is
         not, and nothing downstream clips: an unwrapped meta line would draw
         straight over its neighbour and off the page. */
      const meta = bits.length ? wrap(engine, bits.join('  ·  '), adapt(S.meta, lang), g.colW) : [];
      return {
        e, titles, meta,
        height: probe.ascent + (titles.length - 1) * LEAD.title
          + (meta.length ? u * 1.5 + metaProbe.ascent + (meta.length - 1) * LEAD.meta : 0) + u * 2.1,
      };
    });
    const height = u * 1.6 + h.lineHeight + u * 2 + entries.reduce((a, x) => a + x.height, 0) + u * 2.2;
    return { sec, head: h, entries, height, probe, metaProbe, LEAD };
  });
}

/* Minimise the tallest column over contiguous slices. Classic linear
   partition; with a handful of sections the O(k n^2) DP is instant. */
function partition(heights, k) {
  const n = heights.length;
  const assign = new Array(n).fill(0);
  if (k <= 1 || n <= 1) return assign;
  const pre = [0];
  heights.forEach((h, i) => pre.push(pre[i] + h));
  const sum = (a, b) => pre[b] - pre[a];
  const dp = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[1][i] = sum(0, i);
  for (let c = 2; c <= k; c++) {
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= i; j++) {
        const v = Math.max(dp[c - 1][j], sum(j, i));
        /* <= not <, so that among equally optimal cuts the LAST one wins.
           With a strict comparison the smallest j survives, which means that
           whenever the objective is indifferent - fewer sections than columns,
           say - the reconstruction starves the leftmost columns and the CV
           opens with a blank column. */
        if (v <= dp[c][i]) { dp[c][i] = v; cut[c][i] = j; }
      }
    }
  }
  const bounds = new Array(k + 1);
  bounds[k] = n;
  for (let c = k; c >= 1; c--) bounds[c - 1] = cut[c][bounds[c]];
  for (let c = 1; c <= k; c++) for (let i = bounds[c - 1]; i < bounds[c]; i++) assign[i] = c - 1;
  return assign;
}

function cvView(engine, content, lang, g, vh, topY, assignment, measured) {
  const scene = new Scene(engine, lang, g);
  const S = scale(g.vw);
  const u = g.u;
  const colTop = topY + u * 3;
  const colY = new Array(g.cols).fill(colTop);

  measured.forEach((m, si) => {
    const col = assignment[si];
    const x = g.colX(col);
    let y = colY[col];

    scene.rect(`cv.${si}.rule`, x, Math.round(y), Math.round(g.colW), 1, RULE, 0.22);
    y += u * 1.6 + m.head.ascent;
    scene.text(`cv.${si}.head`, m.sec.section[lang], S.section, x, y, INK_3, { mode: 'attn' });
    y += m.head.descent + u * 2;

    m.entries.forEach((en, ei) => {
      y += m.probe.ascent;
      en.titles.forEach((t, k) => {
        scene.text(`cv.${si}.${ei}.title.${k}`, t, S.title, x, y + k * m.LEAD.title, INK);
      });
      y += (en.titles.length - 1) * m.LEAD.title;
      if (en.meta.length) {
        y += u * 1.5 + m.metaProbe.ascent;
        en.meta.forEach((t, k) => {
          scene.text(`cv.${si}.${ei}.meta.${k}`, t, S.meta, x, y + k * m.LEAD.meta, INK_3);
        });
        y += (en.meta.length - 1) * m.LEAD.meta;
      }
      y += u * 2.1;
    });

    colY[col] = y + u * 2.2;
  });

  scene.height = Math.max(vh, Math.max(...colY) + Math.max(48, g.margin));
  return scene;
}

/* ---- entry point ----------------------------------------------------------
   Builds all four scenes against one atlas generation. Call engine.reset()
   before and engine.build() after: everything measured in between is what
   gets rasterised. */
export function buildScenes(engine, content, vw, vh, safeTop = 0) {
  const g = grid(vw, safeTop);
  const S = scale(vw);
  const scenes = {};

  /* The band is drawn into each scene separately, since it carries the
     active-state colours, but its geometry is identical everywhere. */
  const topY = band(new Scene(engine, 'en', g), content, 'card', 'en', g);

  const measured = {
    en: measureSections(engine, content, 'en', g, S),
    zh: measureSections(engine, content, 'zh', g, S),
  };
  const assignment = partition(measured.en.map((m, i) => Math.max(m.height, measured.zh[i].height)), g.cols);

  /* The card is centred using the taller of its two languages, so its top edge
     does not jump when the morph starts. When it is taller than the space it
     has, it anchors to the top instead: centring content that overflows hides
     the top of it, which on this page is the name. */
  const shapes = { en: cardShape(engine, content, 'en', g), zh: cardShape(engine, content, 'zh', g) };
  const shape = {
    lines: Math.max(shapes.en.lines, shapes.zh.lines),
    rowLines: shapes.en.rowLines.map((n, i) => Math.max(n, shapes.zh.rowLines[i])),
  };
  const cards = {
    en: cardBlock(engine, content, 'en', g, shape),
    zh: cardBlock(engine, content, 'zh', g, shape),
  };
  const blockH = Math.max(cards.en.blockH, cards.zh.blockH);
  const free = vh - topY;
  const cardTop = Math.round(topY + Math.max(g.u * 3, (free - blockH) * 0.42));

  for (const lang of ['en', 'zh']) {
    for (const view of ['card', 'cv']) {
      let scene;
      if (view === 'card') {
        scene = cards[lang].translate(cardTop);
        scene.height = Math.max(vh, cardTop + scene.blockH + Math.max(g.u * 3, g.margin));
      } else {
        scene = cvView(engine, content, lang, g, vh, topY, assignment, measured[lang]);
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
   nothing on an English card sets - would be 70kB of nothing. main.js awaits
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
     the English card sets "English, 中文" in the serif, and asking only the
     display family for it leaves the first paint of an English page rendering
     Chinese in whatever the system happens to have. */
  const strings = [
    content.card.name[lang], content.card.role[lang], content.card.line[lang],
    ...content.card.fields.map((f) => f.label[lang] + f.value[lang]),
    ...content.cv.map((s) => s.section[lang]
      + s.entries.map((e) => (e.year || '') + e.title[lang] + (e.org ? e.org[lang] : '')).join('')),
    content.nav.card[lang], content.nav.cv[lang], '中',
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
