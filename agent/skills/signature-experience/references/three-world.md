# A generated world with Three.js

Use `scripts/world-kit.mjs` when the subject is a place made of destinations: a catalogue, a hub, a map, a collection. For a different world (a shelf, a skyline, a night sky of windows) keep the lifecycle and the data layer and replace the objects.

## Set up

1. Vendor a pinned build: `npm i three@<version>`, then copy `build/three.module.min.js` and `build/three.core.min.js` into `assets/vendor/` (same folder, so the relative import inside works). Do not load an unpinned CDN in production.
2. Copy `world-kit.mjs` next to your scripts. Import map and module:

```html
<div class="stage" style="aspect-ratio: 16 / 10">
  <canvas id="world" aria-hidden="true"></canvas>
  <img class="poster" src="assets/world-poster.webp" alt="" width="1280" height="800">
</div>
<nav aria-label="Places"><ul id="places"><li><a href="/tools/notes/" data-plot="0">Notes</a></li></ul></nav>
<script type="importmap">{"imports":{"three":"/assets/vendor/three.module.min.js"}}</script>
<script type="module">
  import * as THREE from "three";
  import { generateTerrain, createDiorama, makeIsoCamera, bootScene } from "/assets/js/world-kit.mjs";
  const canvas = document.getElementById("world");
  const terrain = generateTerrain({ seed: 7, size: 22, plots: document.querySelectorAll("[data-plot]").length });
  const scene = new THREE.Scene(); scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue("--sky") || "#cfe6f7");
  const world = createDiorama({ THREE, terrain, palette: { /* sky, water, sand, grass, rock, trunk, leaf, cloud, plots: [...] from palette.mjs */ } });
  scene.add(world.group);
  const camera = makeIsoCamera(THREE, terrain.size, canvas.clientWidth / canvas.clientHeight);
  const stage = bootScene({ THREE, canvas, scene, camera,
    onResize: (w, h, cam) => cam.userData.setFrame(w / h, w < h ? 0.62 : 1, w < h ? 0 : 0.28),
    onFrame: (t) => world.update(t) });
  stage.renderOnce();   // the first still frame, also the reduced-motion result
  stage.start();        // ambient loop; does nothing under reduced motion, and pauses itself when hidden or off screen
  document.querySelector(".stage").classList.add("is-ready"); // hide the poster only now
</script>
```

The kit renders one still frame and starts no loop under `prefers-reduced-motion`, pauses off screen and when the tab is hidden, lowers the pixel ratio on sustained slow frames, survives context loss and frees GPU memory in `stage.dispose({ scene: true })` (only for a scene this page built).

## Make it this subject's world

The defaults are an island so the kit renders something sensible. Do not ship them unchanged.

- **Palette:** derive it (`palette.mjs`), pass the roles you need. Sky, water, sand, grass, rock, trunk, leaf, cloud and `plots[]` are the keys.
- **Plots are destinations.** Generate as many as the page links to and bind each to a real `href` and name. The seed makes their positions stable between visits.
- **Decor is the motif.** `trees` are placed and swayed in `placeTrees`; replace the two instanced meshes with whatever the subject's world is made of (stacked shelves, lanterns, towers, reeds). Keep it instanced.
- **Ground:** change the water slab and biome colors to make a desk, a night field, a harbour.
- **Camera:** `setFrame(aspect, zoom, offset)`; offset shifts the world sideways to leave a text column.
- **Light:** one hemisphere plus one directional light and cheap per-column shading. Add shadow maps only if you measured the budget.

## Picking, with a keyboard path

```js
const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  const plot = world.pick(ray); world.highlight(plot?.id ?? null);
  canvas.style.cursor = plot ? "pointer" : ""; if (!stage.running) stage.renderOnce();
});
canvas.addEventListener("click", () => { const plot = world.pick(ray); if (plot) location.href = links[plot.id].href; });
for (const a of document.querySelectorAll("[data-plot]")) { // the keyboard and screen-reader route to the same places
  a.addEventListener("focus", () => { world.highlight(Number(a.dataset.plot)); if (!stage.running) stage.renderOnce(); });
  a.addEventListener("blur", () => { world.highlight(null); if (!stage.running) stage.renderOnce(); });
}
```

The canvas is decoration for assistive tech; the list is the interface. Tap works through `click`; set `touch-action: manipulation` on the canvas.

## The poster

Capture the still with `render_see` (software WebGL) at desktop and phone sizes, convert to AVIF or WebP, and use it as the first paint and as the no-WebGL fallback. Hide it only after the first frame (`.is-ready`). Reserve the box with `aspect-ratio` so nothing shifts.

## A shader-field recipe (when the subject is light, water or sound)

```js
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
const vs = `#version 300 es\nvoid main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0, 1); }`;
const fs = `#version 300 es\nprecision highp float; uniform vec2 uRes, uPointer; uniform float uTime; out vec4 o;
void main(){ vec2 uv = gl_FragCoord.xy / uRes; float f = sin(uv.x*6.+uTime*.4) * sin(uv.y*5.-uTime*.3);
  o = vec4(mix(vec3(.05,.12,.2), vec3(.2,.6,.7), .5+.5*f + .15*smoothstep(.3,0.,distance(uv,uPointer))), 1.); }`;
// compile, link, then: gl.drawArrays(gl.TRIANGLES, 0, 3) once per frame. Cap DPR at 1.5, pause when hidden, draw once under reduced motion.
```

Keep the fragment cheap (no loops over many octaves on phones) and provide the CSS gradient still of the same frame as the fallback.

## What to test

The repo test `tests/signature-experience.test.mjs` renders the kit through the harness capture and checks colors, coverage, draw calls and teardown. For your page: capture at 390, 768 and 1440 wide, check the frame is varied and not blank, hover and focus change the highlighted plot, reduced motion shows one frame, and the console is clean. Software rendering proves the pixels, not the frame rate.
