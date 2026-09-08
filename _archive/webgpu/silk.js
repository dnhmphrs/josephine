/* ===========================================================================
   Josephine Shen — WebGPU background — SILK FLOW (transparent overlay)
   ---------------------------------------------------------------------------
   Continuous full-page field of flowing, domain-warped silk. Changes from the
   previous build:
     • NO PAPER — the washi ground is removed. The canvas is transparent
       (premultiplied alpha), so the silk reads as translucent lilac/rose
       veils over whatever sits behind it on the page.
     • NO CURSOR EFFECTS — the pointer listener, GATHER and the cursor bloom
       are gone; the flow is fully ambient.
     • OPACITY TOGGLE — one master knob for the whole effect:
         · set OPACITY below (0..1)
         · adjust live with the [ and ] keys
         · or call  window.setSilkOpacity(0.0 .. 1.0)

   Your tuning is kept (FLOW_SPEED, WARP, BAND_FREQ, SHEEN). Single full-screen
   fragment shader. Responsive: DPR capped at 2, aspect-corrected. Respects
   reduced-motion (freezes to a still drape). Drop-in via bg.js.
   =========================================================================== */

   const OPACITY = 0.4;   // master opacity of the silk overlay (0 = invisible, 1 = full)

   const WGSL = /* wgsl */ `
   struct U { time: f32, opacity: f32, aspect: f32, _pad: f32 };
   @group(0) @binding(0) var<uniform> u: U;
   
   const gofun = vec3<f32>(0.980, 0.975, 0.960);
   const lilac = vec3<f32>(0.416, 0.298, 0.769);  // #6a4cc4
   const rose  = vec3<f32>(0.847, 0.498, 0.616);  // dusty rose
   
   // ---- TUNABLES (compile-time) -------------------------------------------
   const FLOW_SPEED: f32 = 0.01;   // how fast the silk moves
   const WARP:       f32 = 1.00;   // fold strength (domain warp)
   const BAND_FREQ:  f32 = 2.0;    // density of the silk bands
   const SHEEN:      f32 = 0.0;    // brightness of the drifting highlight
   
   fn hash21(p: vec2<f32>) -> f32 {
     var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
     p3 += dot(p3, p3.yzx + 33.33);
     return fract((p3.x + p3.y) * p3.z);
   }
   fn noise(p: vec2<f32>) -> f32 {
     let i = floor(p);
     let f = fract(p);
     let w = f * f * (3.0 - 2.0 * f);
     let a = hash21(i);
     let b = hash21(i + vec2<f32>(1.0, 0.0));
     let c = hash21(i + vec2<f32>(0.0, 1.0));
     let d = hash21(i + vec2<f32>(1.0, 1.0));
     return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
   }
   fn fbm(p0: vec2<f32>) -> f32 {
     var p = p0;
     var s = 0.0;
     var amp = 0.5;
     for (var i = 0; i < 5; i = i + 1) {
       s += amp * noise(p);
       p = p * 2.03 + vec2<f32>(11.7, 5.3);
       amp *= 0.5;
     }
     return s;
   }
   
   struct Out { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
   @vertex
   fn vs(@builtin(vertex_index) vi: u32) -> Out {
     var v = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
     var o: Out;
     let q = v[vi];
     o.pos = vec4<f32>(q, 0.0, 1.0);
     o.uv  = q * 0.5 + 0.5;
     return o;
   }
   @fragment
   fn fs(in: Out) -> @location(0) vec4<f32> {
     let t = u.time * FLOW_SPEED;
     let p = vec2<f32>(in.uv.x * u.aspect, in.uv.y);
   
     // two-stage domain warp → flowing, folded silk
     let w1   = fbm(p * 1.6 + vec2<f32>(t, -t * 0.6));
     let w2   = fbm(p * 1.6 + vec2<f32>(4.7, 1.9) + w1 * 1.3 - vec2<f32>(t * 0.8, 0.0));
     let warp = vec2<f32>(w1, w2);
     let q    = p + warp * WARP;
   
     let field = fbm(q * 2.0 + warp * 1.4);
     let bands = 0.5 + 0.5 * sin((q.x + q.y) * BAND_FREQ + field * 6.0 + t * 5.0);
     let sheen = pow(0.5 + 0.5 * sin(field * 9.0 - t * 8.0 + warp.x * 6.0), 6.0);
   
     // colour: lilac silk warming to rose where it folds; optional gofun sheen
     var col = mix(lilac, rose, smoothstep(0.30, 0.80, field));
     col = mix(col, gofun, sheen * SHEEN);
   
     // density follows the bands (veils thin in the gaps), scaled by the master opacity
     let density = mix(0.30, 1.0, smoothstep(0.10, 0.95, bands));
     let a = clamp(density * u.opacity, 0.0, 1.0);
     return vec4<f32>(col * a, a);   // premultiplied alpha → composites over the page
   }
   `;
   
   export async function init() {
     const canvas = document.getElementById('bg');
     if (!canvas || !navigator.gpu) return false;
   
     let adapter, device;
     try {
       adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
       if (!adapter) return false;
       device = await adapter.requestDevice();
     } catch (e) { return false; }
   
     const ctx = canvas.getContext('webgpu');
     if (!ctx) return false;
     const format = navigator.gpu.getPreferredCanvasFormat();
     ctx.configure({ device, format, alphaMode: 'premultiplied' });   // transparent canvas
   
     const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
     const DPR_CAP = 2;
   
     // opacity knob — live-adjustable
     let opacity = Math.min(Math.max(OPACITY, 0), 1);
     window.setSilkOpacity = (v) => { opacity = Math.min(Math.max(+v || 0, 0), 1); };
     addEventListener('keydown', (e) => {
       if (e.key === '[') opacity = Math.max(0, opacity - 0.05);
       else if (e.key === ']') opacity = Math.min(1, opacity + 0.05);
     });
   
     const uniBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
     const uni = new Float32Array(4);
   
     const module = device.createShaderModule({ code: WGSL });
     const bindLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
     const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
     const bindGroup = device.createBindGroup({ layout: bindLayout, entries: [{ binding: 0, resource: { buffer: uniBuf } }] });
   
     const pipe = device.createRenderPipeline({
       layout: pipeLayout,
       vertex: { module, entryPoint: 'vs' },
       fragment: { module, entryPoint: 'fs', targets: [{ format }] },
       primitive: { topology: 'triangle-list' },
     });
   
     let W = 1, H = 1;
     function resize() {
       const dpr = Math.min(devicePixelRatio || 1, DPR_CAP);
       // Measure the actual layout size dictated by CSS (inset: 0)
       // rather than the window's volatile innerHeight
       W = canvas.width  = Math.max(1, Math.round(canvas.clientWidth  * dpr));
       H = canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
       canvas.style.width  = innerWidth  + 'px';
       canvas.style.height = innerHeight + 'px';
     }
     addEventListener('resize', resize, { passive: true });
     resize();
   
     const start = performance.now();
     function frame(now) {
       const t = reduce ? 0 : (now - start) / 1000;
   
       uni[0] = t; uni[1] = opacity; uni[2] = W / H; uni[3] = 0;
       device.queue.writeBuffer(uniBuf, 0, uni);
   
       const encoder = device.createCommandEncoder();
       const pass = encoder.beginRenderPass({
         colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
           clearValue: { r: 0, g: 0, b: 0, a: 0 } }],   // clear to transparent
       });
       pass.setBindGroup(0, bindGroup);
       pass.setPipeline(pipe);
       pass.draw(3);
       pass.end();
       device.queue.submit([encoder.finish()]);
       requestAnimationFrame(frame);
     }
     requestAnimationFrame(frame);
     return true;
   }