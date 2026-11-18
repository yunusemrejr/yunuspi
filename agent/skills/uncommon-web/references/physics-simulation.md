# Physics & simulation

Box2D water, rigid bodies, verlet cloth, springs with real mass. Simulation engines that make interfaces behave like stuff.

10 libraries, from Uncommon Web (webdev.teknium.io, field guide vol. 1, October 2026). Versions are the ones shown there: check the current release before installing.

- **LiquidFun**: Google's Box2D particle-fluid fork, compiled to WebAssembly `npm i liquidfun-wasm` · Zlib v7.0.0 · [source](https://github.com/Birch-san/box2d-wasm/tree/liquidfun) · [demo](https://webdev.teknium.io/d/physics2/demos/liquidfun-water-jelly/)
- **Jolt Physics**: The AAA rigid-body engine behind Horizon Forbidden West, in WASM `npm i jolt-physics` · MIT v1.1.0 · [source](https://github.com/jrouwe/JoltPhysics.js) · [demo](https://webdev.teknium.io/d/physics2/demos/jolt-physics-tower-collapse/)
- **planck.js**: Box2D rewritten in TypeScript: rigid bodies, joints, motors `npm i planck` · MIT v1.5.1 · [source](https://github.com/piqnt/planck.js) · [demo](https://webdev.teknium.io/d/physics2/demos/planck-box2d-machines/)
- **cannon-es**: Lightweight 3D rigid-body physics engine in plain JavaScript `npm i cannon-es` · MIT v0.20.0 · [source](https://github.com/pmndrs/cannon-es) · [demo](https://webdev.teknium.io/d/physics2/demos/cannon-es-domino-run/)
- **Party**: WebGPU particle engine with CPU fallback: fluids, boids, joints `npm i @cazala/party` · MIT v1.0.1 · [source](https://github.com/cazala/party) · [demo](https://webdev.teknium.io/d/physics2/demos/party-particle-sandbox/)
- **verlet-js**: Tiny 2D Verlet engine: particles, distance, pin and angle constraints `git clone https://github.com/subprotocol/verlet-js (use js/verlet-1.0.0.js)` · MIT v1.0.0 · [source](https://github.com/subprotocol/verlet-js) · [demo](https://webdev.teknium.io/d/physics2/demos/verlet-js-spider-web/)
- **React Spring**: Spring-physics animation primitives for React, from pmndrs `npm i @react-spring/web @use-gesture/react` · MIT v10.1.2 · [source](https://github.com/pmndrs/react-spring) · [demo](https://webdev.teknium.io/d/physics2/demos/react-spring-tarot-deck/)
- **Rebound**: Facebook's Origami-era spring physics engine for JavaScript `npm i rebound` · BSD-3-Clause v0.1.0 · [source](https://github.com/facebookarchive/rebound-js) · [demo](https://webdev.teknium.io/d/physics2/demos/rebound-origami-grid/)
- **Dynamics.js**: Michael Villar's physics-based animation curves for DOM and SVG `npm i dynamics.js` · MIT v1.1.5 · [source](https://github.com/michaelvillar/dynamics.js) · [demo](https://webdev.teknium.io/d/physics2/demos/dynamics-js-curve-lab/)
- **Smooth Scrollbar**: Momentum scrollbars with iOS bounce and Android glow overscroll `npm i smooth-scrollbar` · MIT v8.8.4 · [source](https://github.com/idiotWu/smooth-scrollbar) · [demo](https://webdev.teknium.io/d/physics2/demos/smooth-scrollbar-overscroll/)
