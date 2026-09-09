# Josephine Shen

One page — an opening, a severely compressed CV, a footer — rendered entirely
in WebGL. The ground, the rules and every glyph are drawn by the GPU.

**Nothing readable ships.** Not a title, not a meta description, not an
accessible mirror, not a string literal in the bundle. That is deliberate: the
owner wants the page to exist and not to be searchable. What it costs is set
out in [Zero text](#zero-text), and the cost is not small.

## Stack

Plain HTML, a very small stylesheet, and five vanilla ES modules bundled by
Rollup. No framework, no Three.js, no runtime dependencies at all. Fonts are
self-hosted and subset. All visible text lives in `src/content/content.json`.

```bash
npm install
npm run dev      # live server + reload at http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the built dist/
npm run fonts    # re-fetch and re-subset the webfonts (see below)
npm run lint
npm run check    # drive the built site in a real browser (see below)
```

`check` needs Playwright, which is deliberately not a dependency — it pulls a
browser and this runs rarely (`npm i -D playwright && npx playwright install
chromium`). Set `CHROMIUM_PATH` if the machine has a browser already and cannot
download another.

**`npm run check` is the important one.** Everything visible here is inside a
canvas, so the usual safety nets do not apply: a unit test cannot see a glyph,
and a type error is not the failure mode to worry about. It drives the real
built site in a real browser and asserts on what it does — that the hit layer
is made of real anchors and buttons and carries no readable text, that tab
order is reading order, that the language control is a single element, that the
switch lands on the very next frame and is finished there, that the opening is
shallow and the CV is already on the first screen, that nothing overflows the
measure, that no content word survives into the served HTML or the bundle, that
`noindex` is present and `robots.txt` is not — and that it still fails quietly
with WebGL removed, with
`localStorage` throwing, without `Intl.Segmenter`, under
`prefers-reduced-motion`, at 320x480, and through a resize storm.

Deploys on Vercel as a static build (`outputDirectory: dist`).

## How it works

```
src/
  index.html            the shell: a canvas, a scroll proxy, two hidden layers
  content/content.json  ALL text, EN + ZH - edit here
  js/
    text.js             glyph atlas
    gl.js               the renderer
    layout.js           the box model
    main.js             state, the DOM layers
  styles/main.css       ~190 lines, and none of them style any text
public/fonts/           subset woff2 + the generated @font-face rules
```

**text.js — the glyph atlas.** Nothing here is DOM text, so type has to become
pixels somewhere. Rather than ship a font parser, each text *run* — a whole
string, at its final device-pixel size — is drawn once into a 2D canvas, which
gets real shaping, real kerning, real CJK and real italics for free. The runs
are shelf-packed into a single atlas canvas and uploaded as one texture, then
cut into per-glyph vertical slices so the renderer can move letters
independently. Font sizes are rounded to whole device pixels and run origins
snap to the pixel grid, so at rest every texel lands on exactly one screen
pixel and the type is as sharp as the DOM's.

Only the language on screen is in the atlas. The atlas grows in height before
it grows in width, because a shelf packer is bounded by the widest run it has
to hold: 2048x4096 is the same capacity as a 4096 square for half the memory.

**gl.js — the renderer.** Two passes. A full-screen triangle runs the ground
shader; then one dynamic vertex buffer holds every glyph and every hairline and
goes out in a single draw call. The atlas reserves an opaque white texel, which
is how a rule and a letter can share one texture. WebGL 1 and GLSL ES 1.00
throughout.

**layout.js — the box model.** With no DOM there is no box model, so this file
is it: `content.json` becomes a flat list of positioned runs and rectangles in
CSS pixels, plus the regions that respond to a pointer. One page, in three
parts — an opening held to the first screen, the CV under it, a footer at the
end — and one scene, in one language.

Nothing is set above 54px and nothing is heavier than 500. The whole scale
spans about five to one, where a display page would span fifteen; hierarchy is
carried by the space around a thing and by which of the two faces it is set in,
which is a quieter instrument than size and a more exact one.

**Nothing animates except the ground.** Pressing 中 is a cut: the layout runs
again, the atlas is rebuilt, and the other language is on screen the next
frame — the same work a resize already does, inside the click.

**The ground.** A port of the washi ground from the archived builds
(`_archive/rebuilds/file2.html`), not of the silk shader beside it. The silk is
the interesting one to write and the wrong one for this page. What the archive
actually did was two lines of CSS:

```css
radial-gradient(120% 80% at  50% -10%, rgba(143,95,160,.045), transparent 60%)
radial-gradient(100% 60% at 100% 110%, rgba(143,95,160,.035), transparent 55%)
```

Two enormous, very soft, off-centre pools at four and a half and three and a
half percent, over a warm broadsheet white, with a faint grain on top. So
shallow that on most displays you cannot point at where one begins — the whole
sheet spans about ten percent of luminance. That is a better gesture than the
brushed wash it replaces, which had a defined upper edge and was therefore a
*thing on* the page rather than a property *of* it.

The pools are lilac, from the archive and ultimately from the WebGPU silk, and
they are the only hue anywhere. A neutral pool of the same depth reads as a
smudge; a violet one reads as light, because a warm ground with a cool shadow
is how a surface under a real sky behaves. They are anchored to the page at a
tenth of the scroll rather than to the viewport: a gradient pinned to the
window is a vignette and announces itself the moment you scroll. And the dither
is the most important term in the file — ten percent of luminance is about
eight of the 256 available levels, which bands into visible contours without
it.

## Zero text

The canvas is a picture of text, and a picture of text is not text — which is
the point. A search index reads the DOM; it does not screenshot a page and OCR
it. So drawing every string into a canvas is the one mechanism here that is
*enforced* rather than requested. It is also undone completely by a single
`<title>`, which is where her name lived until this pass.

What was removed, in order of how much each was leaking:

| | was |
|---|---|
| `#a11y` | the entire CV as real HTML, inlined into `index.html` at build |
| `<title>`, description, author | her name and a one-line biography |
| Open Graph + Twitter tags | eleven tags of pure crawler food, and `og.jpg` |
| the bundle | `content.json` inlined verbatim by `@rollup/plugin-json` |
| the hit layer | an off-screen `<span>` per control carrying its label |
| `<noscript>` | thirty-one words explaining the mechanism |
| HTML comments | 36% of the served bytes, all of it readable English |
| `404.html` | a full error page set in both faces |

`content.json` now ships pruned, XOR-ed and base64-ed by a Rollup `load` plugin
— `@rollup/plugin-json` is deleted, and *that deletion* is what makes the
guarantee. Call the encoding what it is: obfuscation. The key sits one line
above the payload. It defeats `grep`, a text-extracting crawler and a
view-source, and it defeats nothing else. The prune also drops `_readme`,
`note` and `placeholder`, which are the owner's private marks recording which
CV facts are still unverified.

The other half is **`noindex`, and deliberately no `robots.txt`.** Those two
are mutually exclusive and the wrong one is the popular one: `Disallow`
controls *crawling*, not indexing, so a crawler told not to fetch the page
never reads the `noindex` — and a URL linked from anywhere can still be listed,
bare, as "No information is available for this page". Blocking the crawl makes
a listing more likely, not less. So the crawl is allowed and the answer is
given: a `robots` meta in the served head, and an `X-Robots-Tag` header on
`/(.*)` in `vercel.json` for everything a meta tag cannot reach — the bundle,
the fonts, the licence file.

**What this costs, plainly.** A screen reader now lands on a document that
announces nothing: the canvas is `aria-hidden` and there is no other text. A
visitor without JavaScript, or with a GPU that refuses WebGL, gets bare ground
and no contact details. Printing produces a blank sheet. Find-in-page,
translation and Reader Mode return nothing. The three controls have no
accessible names. Link previews are bare URL chips, and the browser tab shows
the hostname. None of that is a bug; all of it is the decision, and reverting
the commit that made it puts every piece back.

Two things it does **not** buy, and should not be described as buying.
Unsearchable is not private — the hostname carries her name, and if the GitHub
repository is public then `content.json` is readable there in full. And nothing
here stops a human, a screenshot-and-OCR scraper, or a crawler with a vision
model; only authentication would.

What survives, and why: `#scroll` still carries a transparent `<a>` or
`<button>` over every interactive mark, in content coordinates, so tab order,
Enter, the pointer cursor, touch slop, `mailto:` context menus and cmd-click
are the browser's job rather than ours. Their `href`s are assigned at runtime
from the decoded content, so they are absent from the served bytes. And
**visible text cannot be selected**; it never could.

## Editing content

Open `src/content/content.json`. Every value has an `en` and a `zh` — keep both
filled, because the toggle cuts from one to the other and a missing value
leaves a hole on screen. Plain text only: no HTML, no `<br/>`. The layout engine
decides line breaks.

- `index` — the name, the role, the sentence, `context` (the facts set inline
  beside the role — keep them to two or three words each, they share a line),
  `available` (label and value, which live in the footer), the contact block.
- `labels` — the CV heading and the two words in the language toggle. They live
  here rather than in `layout.js` because anything the encoder cannot see is a
  string that ships in plain sight.
- `cv` — sections, each with entries of `{ year, title, org }`. One line each.
- An entry marked `"placeholder": true` is a real thing with a fact still
  missing; read its `note`, fill the value in, delete both keys.

**After adding a Chinese character that was not already on the site, run
`npm run fonts`.** The CJK faces are subset to exactly the characters this file
uses — 239 of them, which is how several megabytes of Noto becomes 56kB and
74kB — so a new character is a missing glyph until they are regenerated.
English edits never need it; the Latin faces carry full `latin` + `latin-ext`.

`npm run fonts` also regenerates `public/fonts/OFL.txt` from the same tables
that produce `fonts.css`. A hand-maintained licence file drifts, and OFL 1.1
requires each font's copyright notice to travel with the font — so a list that
credits a face the directory no longer holds is not a stale formality, it is
the condition of redistribution unmet.

## Typography

Hanken Grotesk over Newsreader, divided by job rather than by hierarchy: the
grotesque is the structure — the name, the toggle, the section heads, every
tracked capital — and the serif is the voice, the places where a sentence is
being spoken rather than a page labelled. Nothing is set in both.

Hanken Grotesk is the Swiss one without being a Helvetica tracing: horizontal
terminals and a rational frame, but slightly open apertures and a generous
x-height. That is what earns it the job here — a face has to hold a name at
52px *and* a capital tracked to +0.15em at 10px, and the ones that manage the
first usually shut down at the second. Newsreader is a newspaper serif in its
bones and a contemporary drawing on its surface.

Nothing is heavier than 600 and nothing is larger than 54px. A grotesque with
presence at 500 lets the page stay quiet and still sound certain; the face this
replaces needed weight to do the same work, and weight is what made an earlier
pass read as shouting.

Noto Sans SC and Noto Serif SC are the Chinese companions: 黑体 under the
grotesque, 宋体 under the serif. Every string on this site exists twice, so the
Latin is never seen alone.

Neither Latin face ships more of an axis than it uses. `ctx.font` is the CSS
font shorthand and carries no `font-variation-settings`, so an axis is
unreachable from Canvas2D through a family name alone; Google is asked for it
frozen at one value instead — `opsz,wght@20,300..700` — which returns a partial
instance with that axis fixed and the weight still variable, at a third the
size of the two-axis original. An optical size is chosen by naming a family.

All four faces are self-hosted (`scripts/fetch-fonts.mjs`, SIL OFL, see
`public/fonts/OFL.txt`). No request leaves the visitor's browser for a third
party — which for a Berlin-based researcher is a legal position as much as a
technical one, after LG München I 3 O 17493/20.

## Layout

| viewport | columns | margin | track |
|---|---|---|---|
| 390 | 1 | 24 | 332 |
| 744 | 2 | 28 | 333 |
| 1280 | 3 | 49 | 380 |
| 1440 | 3 | 55 | 416 |
| 1920 | 4 | 73 | 402 |
| 2560 | 5 | 96 | 427 |
| 3440 | 6 | 96 | 500 |

Margin is `clamp(vw × 0.038, 24, 96)`; content is the viewport less two of
them, always.

There is no maximum width and nothing is centred in a field of empty gutter.
The previous rule capped the content at 1440 and then centred it, which on a
2560 display left 560px of nothing on each side: neither hugging the edges, so
the page had no frame, nor deliberately centred, because the margins were set
by a cap rather than by proportion. Hugging the edges is a decision; a cap is
an accident.

What a cap was protecting is the LINE MEASURE, and columns protect it better —
so the column count keeps rising with the viewport, six of them past 2700, and
every track stays inside about 27em whatever the display does.

The head is three things and then nothing: the name at the top of the frame
with the language toggle on its baseline; one credential line under it, set as
a dateline — role, city, languages, separated by hairlines rather than
labelled; and one sentence at a 22em measure, break-balanced so it sets as a
block rather than as a long line and a stub. Then the largest interval on the
page, and the CV. That empty band is where the empty page becomes a decision
rather than what was left over.

The facts used to be a four-column spec sheet — BASED, LANGUAGES, CURRENTLY,
AVAILABLE FOR — ruled across the measure. That is the format of an application,
whatever it says; a page by someone who already holds the position does not
list its particulars for assessment. Two of the four were load-bearing and are
now inline beside the role, unlabelled. CURRENTLY was already the first entry
of the CV, with a year attached. AVAILABLE FOR moved to the footer, next to the
address: the head states who she is and the foot states how to reach her.

The CV opens on a threshold rather than on a gap — a hairline with the word
`CV` set on it, the rule starting after the word. It is the only interrupted
rule on the site, which is what makes it read as a division and not as the
first of five identical band rules.

A CV section is a band: a hairline across the measure, its name hanging in the
first column, and its entries filling the columns to the right. The first
column stays empty for the whole height of the section, which is the point — it
is the vertical the eye tracks down. Below three columns there is no column to
hang in, so the name goes above its entries and they take the full measure.

## Notes

- Language choice persists in `localStorage`.
- `prefers-reduced-motion` freezes the ground. Nothing else on the page moves.
- If the atlas will not fit in the GPU's largest texture, the page re-lays out
  at DPR 1 rather than splitting into several draw calls.
- A lost WebGL context is caught, cancelled (so the browser will offer it back)
  and rebuilt; if it does not return within five seconds the page falls through
  and cleared. The first paint waits on the webfonts, but only for 1.5s — a
  canvas has no fallback face to paint in the meantime.
- Text is rasterised at up to 2x device pixels. On a 3x phone the type is
  therefore upscaled by half; raising the cap is a one-line change in
  `main.js`, at the cost of a much larger atlas.
- Printing produces a blank sheet, like every other path that is not the
  canvas. See [Zero text](#zero-text).
- `_archive/webgpu/` holds the previous WebGPU background — the silk shader
  whose vocabulary (washi, gofun white, ink in damp paper) the current ground
  descends from. Nothing there is bundled.
