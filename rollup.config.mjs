import fs from 'node:fs';
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

const encodedContent = () => ({
  name: 'encoded-content',
  load(id) {
    if (!id.replace(/\\/g, '/').endsWith('src/content/content.json')) return null;
    const bytes = Buffer.from(JSON.stringify(prune(JSON.parse(fs.readFileSync(id, 'utf8')))), 'utf8');
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
          transform: (contents) => contents.toString().replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n'),
        },
        { src: 'src/404.html',     dest: 'dist' },   // Vercel serves this for not-found routes
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

