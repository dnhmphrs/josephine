# Working on this repo

## Standing instruction: always open a PR

Every piece of work ends with a pull request, without being asked. Push to the
working branch and open one against `main` — or, if a PR for that branch is
already open, let the push update it. Do not wait for someone to say "PR".

The one thing to check first is whether the open PR has been **merged** while
you were working, which happens often here. A merged PR cannot carry new
commits. If it has merged, restart the branch from the new `main`, carry any
unmerged work across, and open a *new* PR:

```bash
git fetch origin main
git log --oneline origin/main..HEAD   # what is not in main yet
git rebase origin/main                # carry it across
git push --force-with-lease -u origin <branch>
```

## Before you push

`npm run check` is the gate, and it is not optional. It builds, serves `dist`
and asserts ~50 properties of the built artefact, the most important of which
is that **no readable content string ships** — not in the HTML, not in the
title, not as a literal in the bundle. That guarantee is the reason the site is
built the way it is, and the check is what enforces it. See "Zero text" in the
README.

`npx eslint src/js/` should also be clean.

If Playwright cannot find a browser, the environment has one already:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium npm run check
```

## Judging visual changes

Colour and spacing decisions here get *measured*, not eyeballed. The ground is
a shader, so an ink's contrast is its ratio against the **darkest point that
shader reaches** — evaluated across time, both window axes and the full scroll
length — and not against the nominal paper value. Every ink in `layout.js`
carries its measured ratio in a trailing comment; keep those honest when you
change one.

Render candidates and look at them at **real size** before choosing. Anything
judged only zoomed in will be wrong: the switch fill and the ink ladder were
both settled by rendering a ladder of options at the size they actually occupy.
