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

/* Latin: whole subsets, so English copy can be edited without regenerating. */
const LATIN = [
  { family: 'Jost', axis: 'wght@400..700', file: 'jost', subsets: ['latin', 'latin-ext'], range: '100 900' },
  { family: 'Bodoni Moda', axis: 'opsz,wght@6..96,400..500', file: 'bodoni-moda', subsets: ['latin', 'latin-ext'], range: '400 500',
    /* Bodoni is a MODERN in the type-historical sense - a Didone - and its
       hairlines only survive small sizes if the optical-size axis is honoured.
       ctx.font is the CSS font shorthand, which carries no
       font-variation-settings, so opsz is unreachable from Canvas2D through the
       family name alone. The axis is pinned here instead, as two separately
       named @font-face families over the same file: layout.js then selects an
       optical size simply by naming a family. 36 rather than 96 for the lede -
       at 96 the hairlines are thinner than one device pixel on a non-retina
       display and the line dissolves. */
    opsz: [['Bodoni Moda Lede', 36], ['Bodoni Moda Text', 11]] },
];

/* CJK: subset to the characters this site actually sets. */
const CJK = [
  { family: 'Noto Sans SC', axis: 'wght@400..700', file: 'noto-sans-sc', range: '100 900' },
  { family: 'Noto Serif SC', axis: 'wght@400..500', file: 'noto-serif-sc', range: '200 900' },
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
    const families = [[f.family, null], ...(f.opsz || [])];
    for (const [family, opsz] of families) {
      rules.push(`@font-face {
  font-family: '${family}';
  font-style: ${face.style};
  font-weight: ${f.range};
  font-display: block;
  src: url('/fonts/${name}') format('woff2');${opsz ? `\n  font-variation-settings: 'opsz' ${opsz};` : ''}
  unicode-range: ${face.range};
}`);
    }
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

console.log(`\n${rules.length} faces, ${(total / 1024).toFixed(1)}kB total -> public/fonts/`);
