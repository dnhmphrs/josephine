/* ===========================================================================
   Fetch and self-host the webfonts.

     node scripts/fetch-fonts.mjs

   Why this exists rather than a <link> to fonts.googleapis.com:

     1. Privacy and law. Loading a font from Google discloses every visitor's
        IP address to a third country. A German court (LG München I, 3 O
        17493/20) has already found that unlawful under the GDPR without
        consent, and this is the site of a Berlin-based policy researcher. Not
        the place to run that risk.
     2. Determinism. Every glyph here is rasterised into a texture atlas at
        load. A font that arrives late, or not at all, does not degrade
        gracefully into a slightly different page - it bakes a different page
        into a texture. Same-origin fonts remove that whole class of problem.
     3. Weight. The CJK faces are subset to exactly the characters
        content.json uses, which turns ~7MB of Noto into ~20KB.

   Run this again after adding Chinese characters to content.json - the CJK
   subsets are generated from that file, so a new character is a missing glyph
   until you do. Latin faces carry full latin + latin-ext, so English edits
   never need it. Output lands in public/fonts/ and is committed to the repo,
   which keeps the production build offline and reproducible.

   All four families are SIL Open Font License 1.1; see public/fonts/OFL.txt.
   =========================================================================== */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'fonts');

/* A current desktop Chrome UA: the CSS endpoint serves woff2 only if it
   believes the client can read it. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/* The Latin faces, one file each.

   Archivo over Newsreader. The brief asked for two faces that feel
   contemporary and classic at the same time, which is a request for revivals
   rather than for period pieces - a face drawn now, out of a form with a long
   history. Archivo is Omnibus-Type's grotesque, cut from the American gothics
   that set nineteenth-century wood type and job printing: the ancestors of
   Helvetica, from before Switzerland sanded the grit off them. Newsreader is
   Production Type's reading serif, a newspaper Times in its bones and nothing
   like one in its drawing.

   Both carry real axes, and neither ships more of one than it uses. ctx.font
   is the CSS font shorthand and carries no font-variation-settings, so an axis
   is unreachable from Canvas2D through a family name alone; asking Google for
   the axis PINNED to one value - `wdth,wght@100,400..800` - returns a partial
   instance with that axis frozen and the weight still variable, and the file
   is a third the size of the two-axis original: 33kB against 87kB. A width cut
   of Archivo was carried here for one line of display type and is gone with
   it; the mechanism is worth keeping documented, because it is also what makes
   the optical size below free.

   Latin subsets are whole, so English copy can be edited without regenerating.
   unicode-range means a visitor only downloads what the page actually sets. */
const LATIN = [
  /* Everything structural: the name, the toggle, labels, section heads, years,
     organisations. Width pinned at 100 - the normal cut, and no second file. */
  { as: 'Archivo', family: 'Archivo', axis: 'wdth,wght@100,400..800', file: 'archivo',
    subsets: ['latin', 'latin-ext'], range: '400 800', ofl: 'archivo' },
  /* The voice: the lede, the CV titles, the contact line. Pinned at optical
     size 20, the middle of the 15-27px band it is set in. One instance rather
     than two - Newsreader is a text face and holds together across that range;
     a Didone would not, which is why the face this replaces needed two. */
  { as: 'Newsreader', family: 'Newsreader', axis: 'opsz,wght@20,300..700', file: 'newsreader',
    subsets: ['latin', 'latin-ext'], range: '300 700', ofl: 'newsreader' },
];

/* CJK: subset to the characters this site actually sets. */
const CJK = [
  { family: 'Noto Sans SC', axis: 'wght@400..700', file: 'noto-sans-sc', range: '100 900', ofl: 'notosanssc' },
  { family: 'Noto Serif SC', axis: 'wght@400..500', file: 'noto-serif-sc', range: '200 900', ofl: 'notoserifsc' },
];

function curl(url, binary) {
  const args = ['-sSL', '--fail', '-A', UA, url];
  return execFileSync('curl', binary ? [...args, '--output', '-'] : args,
    { maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' });
}

/* Every character content.json can ask the CJK faces to draw. Latin and digits
   go in too: a mixed run like "AIxist 研究员" is one Canvas2D draw, and the
   fallback chain only kicks in per missing glyph, so it costs nothing to let
   the CJK face cover the ASCII it may be asked for. */
function charset() {
  /* content.json is where all the site's text lives, but 404.html carries its
     own - it is deliberately plain DOM, since an error page that needs a GPU to
     tell you a URL is wrong has misunderstood its job. */
  const sources = [
    path.join(ROOT, 'src', 'content', 'content.json'),
    path.join(ROOT, 'src', '404.html'),
  ].map((f) => fs.readFileSync(f, 'utf8')).join('');
  const set = new Set();
  for (const ch of sources) if (ch.codePointAt(0) > 0x20) set.add(ch);
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;()[]{}-—–/@&%·、。，；：？！“”‘’（）《》') set.add(ch);
  return [...set].sort().join('');
}

/* Pull one @font-face block's worth of metadata out of the CSS Google returns.
   The blocks are ordered and each is preceded by a /* subset *\/ comment. */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[2];
    const pick = (k) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) || [])[1];
    const url = (body.match(/url\(([^)]+)\)/) || [])[1];
    if (!url) continue;
    faces.push({
      subset: m[1],
      style: (pick('font-style') || 'normal').trim(),
      weight: (pick('font-weight') || '400').trim(),
      range: (pick('unicode-range') || '').trim(),
      url,
    });
  }
  /* The text= endpoint omits the subset comment, so fall back to a plain scan. */
  if (!faces.length) {
    const re2 = /@font-face\s*\{([^}]+)\}/g;
    while ((m = re2.exec(css))) {
      const body = m[1];
      const pick = (k) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) || [])[1];
      const url = (body.match(/url\(([^)]+)\)/) || [])[1];
      if (!url) continue;
      faces.push({
        subset: 'text',
        style: (pick('font-style') || 'normal').trim(),
        weight: (pick('font-weight') || '400').trim(),
        range: '',
        url,
      });
    }
  }
  return faces;
}

fs.mkdirSync(OUT, { recursive: true });
const rules = [];
let total = 0;

/* Google returns ONE variable woff2 per family+subset and lists it once for
   every weight asked for, so dedupe by URL and declare the axis range instead
   of shipping the same 26kB four times. */
const seen = new Set();

for (const f of LATIN) {
  const css = curl(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family)}:${f.axis}&display=block`);
  for (const face of parseFaces(css)) {
    if (!f.subsets.includes(face.subset) || seen.has(face.url)) continue;
    seen.add(face.url);
    const name = `${f.file}-${face.subset}.woff2`;
    const bytes = curl(face.url, true);
    fs.writeFileSync(path.join(OUT, name), bytes);
    total += bytes.length;
    rules.push(`@font-face {
  font-family: '${f.as}';
  font-style: ${face.style};
  font-weight: ${f.range};
  font-display: block;
  src: url('/fonts/${name}') format('woff2');
  unicode-range: ${face.range};
}`);
    console.log(`${name}  ${(bytes.length / 1024).toFixed(1)}kB`);
  }
}

const text = charset();
console.log(`CJK subset: ${[...text].length} characters`);
for (const f of CJK) {
  const css = curl(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family)}:${f.axis}&text=${encodeURIComponent(text)}&display=block`);
  for (const face of parseFaces(css)) {
    if (seen.has(face.url)) continue;
    seen.add(face.url);
    const name = `${f.file}.woff2`;
    const bytes = curl(face.url, true);
    fs.writeFileSync(path.join(OUT, name), bytes);
    total += bytes.length;
    rules.push(`@font-face {
  font-family: '${f.family}';
  font-style: ${face.style};
  font-weight: ${f.range};
  font-display: block;
  src: url('/fonts/${name}') format('woff2');
}`);
    console.log(`${name}  ${(bytes.length / 1024).toFixed(1)}kB`);
  }
}

fs.writeFileSync(path.join(OUT, 'fonts.css'),
  `/* Generated by scripts/fetch-fonts.mjs - do not edit by hand.
   Regenerate after adding Chinese characters to content.json. */\n\n${rules.join('\n\n')}\n`);

/* The licence file is generated from the same tables, for the same reason
   fonts.css is: a hand-maintained one drifts. OFL 1.1 clause 1 requires each
   font's copyright notice to travel with it, so a list that credits a face
   the directory no longer holds - and omits one it does - is not a formality
   that has gone stale, it is the condition of redistribution unmet. */
const notices = [];
const credited = new Set();
let licence = '';
for (const f of [...LATIN, ...CJK]) {
  /* Two entries can be two instances of one family. Credit it once. */
  if (credited.has(f.ofl)) continue;
  credited.add(f.ofl);
  const text = curl(`https://raw.githubusercontent.com/google/fonts/main/ofl/${f.ofl}/OFL.txt`);
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => l.startsWith('This Font Software is licensed'));
  notices.push(`  ${f.family.padEnd(16)}${lines.slice(0, cut).join(' ').trim()}`);
  if (!licence) licence = lines.slice(cut).join('\n');
}

fs.writeFileSync(path.join(OUT, 'OFL.txt'),
  ['Fonts in this directory are redistributed under the SIL Open Font License,',
    'Version 1.1. They are subset and self-hosted by scripts/fetch-fonts.mjs; see',
    'that file for why. This file is generated by it too - the copyright notices',
    'below are the ones that shipped with the faces actually present here.',
    '',
    ...notices,
    '',
    '-'.repeat(79),
    '',
    licence].join('\n'));
console.log(`OFL.txt  ${notices.length} notices`);

console.log(`\n${rules.length} faces, ${(total / 1024).toFixed(1)}kB total -> public/fonts/`);
