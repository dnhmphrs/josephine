import fs from 'node:fs';
import crypto from 'node:crypto';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import postcss from 'rollup-plugin-postcss';
import copy from 'rollup-plugin-copy';
import terser from '@rollup/plugin-terser';
import serve from 'rollup-plugin-serve';
import livereload from 'rollup-plugin-livereload';

/* ---------------------------------------------------------------------------
   Build
   ---------------------------------------------------------------------------
   Entry is src/js/main.js. It imports content.json - ENCODED, see below - and
   the stylesheet (main.css), which rollup-plugin-postcss extracts into
   dist/assets/styles.css. index.html and anything in public/ are copied across,
   index.html with its comments stripped.

   index.html links /js/main.js (the bundle) and /assets/styles.css directly.

   `yarn dev`  → rollup -c -w  : watches, rebuilds into dist/, AND serves it at
                 http://localhost:5173 with live reload (serve + livereload below,
                 active only when ROLLUP_WATCH is set).
   `yarn build`→ rollup -c     : one-off production build (minified, no server).
   --------------------------------------------------------------------------- */

const dev = process.env.ROLLUP_WATCH === 'true';

/* ---------------------------------------------------------------------------
   The content, encoded.

   Every visible string on this site is drawn into a canvas by the GPU so that
   the page carries no readable text. That is undone completely if the same
   sentences ship as a JS object literal three files later, which is exactly
   what @rollup/plugin-json used to do - dist/js/main.js opened with her name,
   her email and both CVs in plain sight.

   So plugin-json is GONE from the plugin list, and this replaces it. The
   deletion is what makes the guarantee; the plugin below is only what fills
   the hole. Rollup takes the first non-null `load` result, so this must also
   come first.

   Prune, stringify, XOR with a rolling key, base64. Call it what it is:
   obfuscation. The key sits one line above the payload in the same bundle, so
   it stops `grep`, a text-extracting crawler and a casual view-source, and it
   stops nothing else. It is chosen for being synchronous, dependency-free and
   free of any browser-support floor - not for being strong.

   The prune matters as much as the encoding: `note` and `placeholder` are the
   owner's private editing marks recording which CV facts are still unverified,
   and they have no business leaving the repository at all. */
const PRIVATE_KEYS = ['_readme', 'note', 'placeholder'];
const XOR_KEY = 0x5a;

const prune = (v) => (Array.isArray(v) ? v.map(prune)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.entries(v)
      .filter(([k]) => !PRIVATE_KEYS.includes(k))
      .map(([k, x]) => [k, prune(x)]))
    : v);

/* ---------------------------------------------------------------------------
   The tab.

   The browser chrome is the one surface this site cannot draw. Everything
   inside the viewport is a WebGL quad, but the tab is the browser's, it is
   made of text, and an empty <title> just hands it the hostname - which is
   how the page read for several versions: nameless, but also characterless,
   and identical to a parked domain.

   So the title is a MARK rather than a name: block glyphs, no word in any
   language for an index to lift. Block Elements are in every system UI font on
   every platform this page will meet, which is what makes them safe here and
   unsafe on the canvas - the page faces are subset to the content, so the same
   characters drawn INSIDE the viewport would be tofu or would cost a font.

   TITLE_MARK is the tab, literally. Write what you want to see.

   It reads "AI Policy Researcher" now, and that is a deliberate loosening of
   the rule this file otherwise enforces absolutely. Everything else here
   exists so that no string from content.json survives into anything a machine
   can read - and this is a string from content.json, index.role, sitting in
   the head in plain text.

   It is allowed because of WHAT it says. The guarantee that matters is that
   she is not findable, and it is her NAME that makes her findable: a job
   category shared with some tens of thousands of people identifies nobody,
   returns nothing useful to anyone searching for her, and cannot be joined
   back to her by an index. What it buys is a tab that a person can find among
   thirty others, which three block squares could not do. noindex is still the
   load-bearing half and is unchanged.

   check.mjs enforces the narrower rule rather than being relaxed: the title
   is now exempted from the content sweep by name, and separately asserted to
   contain nothing that identifies a person. Everything outside the title - the
   rest of the head, the body, the 404 and the bundle - is checked exactly as
   strictly as before.

   It used to be derived: a sixteen-glyph ALPHABET, indexed by hex digit, run
   over the first 32 digits of a SHA-256 of the content, so the tab was the
   hash drawn as a two-row bitmap. That is the `titleFromHash` below, and it is
   worth knowing why it surprises. NIBBLES was never the tab text - it was a
   lookup table, one glyph per hex value 0-f. Putting the same glyph at slots 0
   and 1 does not give you two of it; it gives you one for every 0 or 1 digit
   the hash happens to contain, wherever they fall. And a table shorter than
   sixteen entries returns undefined for the rest, which is why it seemed to
   need padding with spaces: the spaces were index padding, not spacing.

   To get the derived mark back, set TITLE_MARK to '' - the empty string falls
   through to it. Its one real property is that it changes exactly when the CV
   does, which is either an identity or a nuisance depending on the day. */
const TITLE_MARK = 'AI Policy Researcher';   // '' derives the hash mark instead

/* The alphabet must be exactly sixteen glyphs, one per hex value. Anything
   else silently emits "undefined" thirty times, so it is checked here. */
const NIBBLES = [...'\u2591\u2597\u2596\u2584\u259D\u2590\u259E\u259F\u2598\u259A\u258C\u2599\u2580\u259C\u259B\u2588'];
const titleFromHash = () => {
  if (NIBBLES.length !== 16) throw new Error(`NIBBLES needs 16 glyphs, has ${NIBBLES.length}`);
  return crypto.createHash('sha256')
    .update(JSON.stringify(prune(JSON.parse(fs.readFileSync('src/content/content.json', 'utf8')))))
    .digest('hex').slice(0, 32)
    .replace(/./g, (c) => NIBBLES[parseInt(c, 16)]);
};

const titleMark = () => TITLE_MARK || titleFromHash();

const encodedContent = () => ({
  name: 'encoded-content',
  load(id) {
    if (!id.replace(/\\/g, '/').endsWith('src/content/content.json')) return null;
    const doc = prune(JSON.parse(fs.readFileSync(id, 'utf8')));
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= (XOR_KEY + (i & 31)) & 255;
    return `export default ${JSON.stringify(bytes.toString('base64'))};`;
  },
});

export default {
  input: 'src/js/main.js',
  output: {
    dir: 'dist',
    format: 'es',
    // Pin stable, unhashed names so the hand-written HTML can link them
    // directly: JS at /js/main.js, CSS (extracted below) at /assets/styles.css.
    entryFileNames: 'js/[name].js',
    assetFileNames: 'assets/[name][extname]',
    sourcemap: dev,
  },
  plugins: [
    encodedContent(),
    nodeResolve(),
    postcss({
      // Relative to output.dir (dist/), so this writes dist/assets/styles.css —
      // which is exactly what index.html links to.
      extract: 'assets/styles.css',
      minimize: !dev,
      sourceMap: dev,
    }),
    /* Production only. This file is heavily commented on purpose - the comments
       are most of what makes a hand-written WebGL text engine maintainable -
       and they belong in the source, not in the bundle. */
    !dev && terser({ format: { comments: false } }),
    copy({
      targets: [
        {
          src: 'src/index.html',
          dest: 'dist',
          /* The comments in this file are two thirds of its served bytes and
             every one of them is readable English. They are worth keeping in
             src/, where they explain the decisions; they are not worth
             shipping to a page whose entire premise is that it carries no
             text. */
          transform: (contents) => contents.toString()
            .replace('<title></title>', `<title>${titleMark()}</title>`)
            .replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n'),
        },
        {
          src: 'src/404.html',
          dest: 'dist',
          // Same mark, so a wrong URL is visibly the same document.
          transform: (contents) => contents.toString()
            .replace('<title></title>', `<title>${titleMark()}</title>`),
        },
        /* content.json is NOT copied. It ships encoded inside the bundle; a
           second public copy would be the readable original, complete with the
           editing notes the encoder is careful to prune. */
        { src: 'public/*',         dest: 'dist' },   // favicon, square.png
      ],
      copyOnce: false,
    }),
    // dev-only: live server + reload. http://localhost:5173, SPA-style fallback
    // so deep links resolve. Not included in production builds.
    dev && serve({ contentBase: 'dist', port: 5173, historyApiFallback: true }),
    dev && livereload('dist'),
  ].filter(Boolean),
};

