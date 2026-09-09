/* ===========================================================================
   The accessible mirror, as a pure function.

   The canvas is a picture of text, and a picture of text is not text. This
   renders the same strings as a real document - headings, a definition list,
   links - so that screen readers and search engines have something to work
   with, and so the degraded paths have a page.

   It lives in its own module, touching no DOM, because it is needed in two
   places: main.js writes it into #a11y at runtime, and rollup.config.mjs calls
   it at BUILD time to inline the same markup into index.html. That is what
   makes the no-JavaScript page complete rather than a hand-written summary of
   the real one that quietly drifts out of date.

   `inert` means the canvas is live and the hit layer already carries the real,
   positioned links - so the mirror emits the contact details as plain text
   (announcing an email address twice is worse than not linking it here) and no
   language control (the toggle is on the canvas). Without it the mirror IS the
   page and needs both.
   =========================================================================== */

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/* Wrap Han runs so a screen reader switches voice for them rather than
   spelling 中文 out in an English one, or skipping it. */
const HAN_RUN = /[⺀-⻿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]+/g;

export function bilingual(str) {
  return esc(str).replace(HAN_RUN, (m) => `<span lang="zh-Hans">${m}</span>`);
}

export function renderMirror(content, lang, inert) {
  const t = (n) => (n && n[lang] != null ? n[lang] : '');
  const c = content.index;
  const out = [
    `<h1>${bilingual(t(c.name))}</h1>`,
    `<p>${bilingual(t(c.role))}. ${bilingual(t(c.line))}</p>`,
    '<dl>',
    ...c.fields.map((f) => `<dt>${bilingual(t(f.label))}</dt><dd>${bilingual(t(f.value))}</dd>`),
    '</dl>',
    inert
      ? `<p>${esc(c.contact.email)} ${esc(c.contact.linkedin.label)}</p>`
      : `<p><a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a>`
        + ` <a href="${esc(c.contact.linkedin.url)}" rel="me noopener">${esc(c.contact.linkedin.label)}</a></p>`,
    `<h2>${bilingual(t(content.labels.cv))}</h2>`,
    ...content.cv.flatMap((sec) => [
      `<h3>${bilingual(t(sec.section))}</h3><ul>`,
      ...sec.entries.map((e) => {
        const bits = [e.year, t(e.title), e.org ? t(e.org) : ''].filter(Boolean);
        return `<li>${bilingual(bits.join(' - '))}</li>`;
      }),
      '</ul>',
    ]),
  ];

  if (!inert) {
    out.push('<p>');
    for (const [code, name] of [['en', 'English'], ['zh', '中文']]) {
      out.push(`<button type="button" data-lang="${code}" lang="${code === 'zh' ? 'zh-Hans' : 'en'}"`
        + ` aria-pressed="${code === lang}">${esc(name)}</button>`);
    }
    out.push('</p>');
  }

  return out.join('');
}
