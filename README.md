# Josephine Shen

One page — an opening, a severely compressed CV, a footer — rendered entirely
in WebGL. There is no DOM text in the render path: the ground, the rules and
every glyph are drawn by the GPU.

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
npm run og       # regenerate the link-preview image
```

`check` and `og` need Playwright, which is deliberately not a dependency — it
pulls a browser, and both run rarely (`npm i -D playwright && npx playwright
install chromium`).

**`npm run check` is the important one.** Everything visible here is inside a
canvas, so the usual safety nets do not apply: a unit test cannot see a glyph,
and a type error is not the failure mode to worry about. It drives the real
built site in a real browser and asserts on what it does — that the hit layer
is made of real anchors and buttons, that tab order is reading order, that the
language switch lands on the very next frame and is finished there, that the
opening holds the first screen and the CV follows it, that nothing overflows
the measure, that a rapid triple toggle leaves the state, the mirror and the
drawing agreeing, and that it still says who she is with WebGL removed, with
`localStorage` throwing, without `Intl.Segmenter`, under
`prefers-reduced-motion`, at 320x480, and through a resize storm.

`og` regenerates the link preview by photographing the built site at 1200x630,
so it can never drift out of date with the page.

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
    mirror.js           the accessible document, as a pure function
    main.js             state, the DOM layers
  styles/main.css       ~190 lines, and none of them style any text
public/fonts/           subset woff2 + the generated @font-face rules
public/og.jpg           the link preview: a photograph of the page itself
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

**The ground.** A light warm off-white and one wash: a single soft mass, low
and off-axis, with an edge that creeps the way ink creeps into damp paper. It
moves at about one percent of walking pace and is still a painting when frozen.
A mid grey would have been the safe answer and the dull one — it makes every
value on the page a version of itself. The only hue anywhere is a trace of
violet in the deepest part of the wash, which is why the ground reads as a
surface with light falling on it rather than a flat fill. Most of the shader is
spent on things you are not meant to see: the uneven tone of the surface, its
tooth, and a dither without which a gradient eight levels deep bands into
visible contours.

## The two invisible DOM layers

The canvas is a picture of text, and a picture of text is not text. Two hidden
layers keep the page an actual document:

- `#a11y` mirrors every string as real headings, lists and links, for screen
  readers, search engines, and the case where WebGL — or JavaScript — is
  unavailable, where it stops being a mirror and becomes the visible page, set
  in the same two faces. `mirror.js` renders it as a pure function, which
  `main.js` writes in on load and which the Rollup build calls to inline the
  same markup into `index.html`; so the page a crawler sees is the whole
  document, and there is no second copy to drift away from `content.json`.
- `#scroll` carries a transparent `<a>` or `<button>` over every interactive
  mark, in content coordinates. Tab order, Enter, the pointer cursor, touch
  slop, the status-bar URL preview, `mailto:` context menus and cmd-click all
  work because the browser is doing them, not because they were reimplemented.

One consequence of the medium is honest to state: **visible text cannot be
selected, and find-in-page will not highlight it.** Every string that matters
exists as copyable DOM in the mirror, and the email and LinkedIn are real
anchors, but the canvas itself is an image.

## Editing content

Open `src/content/content.json`. Every value has an `en` and a `zh` — keep both
filled, because the toggle cuts from one to the other and a missing value
leaves a hole on screen. Plain text only: no HTML, no `<br/>`. The layout engine
decides line breaks.

- `index` — the name, the role, the sentence, the four facts, the contact block.
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

Archivo over Newsreader, divided by job rather than by hierarchy: the grotesque
is the structure — the name, the toggle, the section heads, every tracked
capital — and the serif is the voice, the places where a sentence is being
spoken rather than a page labelled. Nothing is set in both.

Archivo is cut from the American gothics of nineteenth-century wood type and
job printing; Newsreader is a newspaper serif in its bones and a contemporary
drawing on its surface. Both are set light and small. A face this neutral does
not need weight to be certain, and a page that whispers in a large enough room
is heard.

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

| viewport | columns | content width |
|---|---|---|
| < 720 | 1 | viewport − margins |
| 720 – 1119 | 2 | viewport − margins |
| 1120 – 1599 | 3 | viewport − margins |
| ≥ 1600 | 4 | 1440, gutters take the rest |

1600 is where three things coincide: the fourth column appears, the content
reaches its 1440 maximum exactly, and the type scale tops out. Above it the
page is frozen and only the void grows.

The opening is held to the first screen: name and role at the top, one sentence
under them at half the page width, the four facts at the foot, and the space
between left empty. That is where the empty page becomes a decision rather than
what was left over. The CV's first hairline sits just above the fold, which is
what says there is more without needing to say so.

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
  to the mirror. The first paint waits on the webfonts, but only for 1.5s — a
  canvas has no fallback face to paint in the meantime.
- Text is rasterised at up to 2x device pixels. On a 3x phone the type is
  therefore upscaled by half; raising the cap is a one-line change in
  `main.js`, at the cost of a much larger atlas.
- Printing takes the same path as the no-JavaScript case: the mirror, unclipped,
  as a plain document. A fixed canvas would put one screenful on the first sheet
  and nothing after it, which is not a CV.
- `_archive/webgpu/` holds the previous WebGPU background — the silk shader
  whose vocabulary (washi, gofun white, ink in damp paper) the current ground
  descends from. Nothing there is bundled.
