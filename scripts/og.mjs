/* ===========================================================================
   Regenerate the link-preview image.

     npm run build
     npm i -D playwright && npx playwright install chromium   (once)
     node scripts/og.mjs

   The preview is not a designed graphic: it is a photograph of the card, taken
   by loading the real built site at 1200x630 and screenshotting it. Which means
   it can never drift out of date with the site, and never needs a second set of
   fonts, colours or copy maintained alongside the first.

   Playwright is deliberately NOT a dependency of this project - it pulls a
   browser, and this script runs about once a year. Install it when you need it.

   JPEG, not PNG: the ground is a dithered gradient, which is the worst possible
   input for PNG (1.9MB) and close to the best for JPEG (60kB).
   =========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'public', 'og.jpg');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is empty - run `npm run build` first.');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.error('Playwright is not installed. It is not a dependency of this project - it pulls a browser:\n\n  npm i -D playwright && npx playwright install chromium\n');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = path.join(DIST, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
/* Long enough for the fonts to land, the atlas to build and the ground to
   settle into a frame worth keeping. */
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT, type: 'jpeg', quality: 88 });
await browser.close();
server.close();

console.log(`${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(1)}kB`);
