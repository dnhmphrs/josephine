# Archive — WebGPU background

The previous site ran a WebGPU compute-free fragment shader ("silk flow") behind the
page, with a router that fell back to a WebGL background when `navigator.gpu` was
absent. Both files are kept here for reference:

- `silk.js` — the WebGPU / WGSL shader. Domain-warped flowing veils in lilac (#6a4cc4)
  and dusty rose over a transparent canvas, premultiplied alpha, opacity knob on
  `window.setSilkOpacity()` and the `[` / `]` keys. Its vocabulary — washi, gofun white,
  ink bleeding in damp paper — is the ancestor of the current WebGL ground.
- `background-router.js` — the WebGPU-or-fallback boot shim. (Note: it self-imported,
  so the WebGL fallback branch never actually ran.)

Nothing here is bundled. The live site is WebGL 1 only — see `src/js/`.
