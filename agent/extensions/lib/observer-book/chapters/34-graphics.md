---
id: graphics
part: media
title: 3D, graphics and games
summary: Real-time graphics craft: frame budgets, draw calls and instancing, asset pipelines and units, lighting and color management, fixed-timestep simulation, GPU resource lifetimes, and verifying what renders.
terms: 3d three threejs three.js webgl webgpu shader shaders glsl wgsl mesh geometry material texture lighting light shadow camera scene render frame fps game games engine unity unreal godot blender physics collision sprite canvas voxel gltf
files: .glsl .wgsl .gltf .glb .obj .fbx .blend .frag .vert
tools: scene_create scene_render render_see browser_session
skills: threejs threejs-animation-engineering blender-production cinematic-pixel-scene simulation-engineering physics-modeling wasm-animation-pipelines
---

# 3D, graphics and games

Real-time graphics is engineering under a hard deadline: every frame must be finished in about 16 milliseconds (8 at 120 Hz). Beauty is built inside that budget, and correctness means both the image and the frame time.

## Budget the frame {#frame-budget}
<!-- terms: frame budget 16ms 60fps fps frame time gpu cpu bound profile performance stutter -->

**Principle.** Measure frame time on target hardware and determine whether the CPU or GPU is the bottleneck before optimizing.

**Why.** A scene that runs at 60 fps on a development GPU may run at 15 on an integrated laptop chip. CPU-bound frames (too many draw calls, scripts, physics) and GPU-bound frames (fill rate, shader cost, resolution) need different fixes. Frame-time graphs reveal stutters that average fps hides. Device pixel ratio multiplies pixel cost quadratically on high-density screens.

**Signals.** Performance judged by average fps on a powerful machine; full device pixel ratio on 4K screens; no frame-time measurements.

**Ask.** On target hardware, is the frame CPU- or GPU-bound, and where does the time go?

**Traps.** Reducing visual quality before finding the actual bottleneck.

## Fewer draw calls: batch and instance {#draw-calls}
<!-- terms: draw calls batching instancing instanced mesh merge geometry culling lod level of detail -->

**Principle.** Reduce draw calls by instancing repeated objects, merging static geometry, culling what is off-screen and using levels of detail for distant objects.

**Why.** Each draw call has CPU overhead; thousands of individual meshes stall the CPU even when the GPU is idle. Instancing renders many copies in one call; merged static geometry reduces calls; frustum and occlusion culling skip invisible work; LOD swaps detailed meshes for simple ones at distance.

**Signals.** Thousands of separate meshes for repeated objects; no culling; the same high-detail mesh at every distance.

**Ask.** How many draw calls does a frame issue, and which repeated objects could be instanced?

**Traps.** Merging dynamic objects that then cannot move independently.

## Assets need consistent units, scale and orientation {#assets}
<!-- terms: asset pipeline units meters scale orientation up axis normals uv texture compression gltf export blender -->

**Principle.** Agree on units, up-axis and scale across tools, validate normals and UVs on import, and compress textures for the GPU.

**Why.** Assets from different tools arrive at wrong scales, rotated, with flipped normals (invisible faces) or missing UVs. Physics and lighting depend on real-world units. Texture memory is often the largest GPU cost; compressed GPU formats and sensible resolutions keep scenes loadable on modest hardware. glTF is the standard interchange format for the web.

**Signals.** Objects appearing huge, tiny or sideways; black or inside-out surfaces; multi-megabyte uncompressed textures.

**Ask.** Are this asset's units, orientation, normals and texture sizes consistent with the scene's conventions?

**Traps.** Fixing scale in the scene graph instead of at the source.

## Light and color with a managed pipeline {#lighting}
<!-- terms: lighting light pbr tone mapping color space srgb linear exposure hdr environment map shadows -->

**Principle.** Use physically based materials with linear lighting, correct color-space handling for textures, and deliberate tone mapping and exposure.

**Why.** Mixing linear and sRGB spaces produces washed-out or overly dark scenes; color textures are sRGB while normal and roughness maps are linear. Physically based rendering with environment lighting produces consistent results across lighting conditions. Tone mapping compresses high dynamic range into displayable values; the choice strongly affects mood.

**Signals.** Washed-out renders; materials looking plastic; lighting tuned by trial and error per object.

**Ask.** Are texture color spaces, lighting and tone mapping configured consistently?

**Traps.** Real-time shadows everywhere at great cost; baking lighting that must be dynamic.

## Fixed timestep for simulation, variable for rendering {#timestep}
<!-- terms: timestep fixed delta time game loop physics simulation determinism interpolation frame rate independent -->

**Principle.** Run physics and game logic on a fixed timestep with an accumulator, render with interpolation, and never tie simulation speed to frame rate.

**Why.** Using frame delta directly for physics makes behavior depend on frame rate: objects tunnel through walls at low fps and gameplay speeds up on fast monitors. A fixed step makes simulation deterministic and stable; interpolation keeps rendering smooth. Clamping catch-up steps after pauses prevents spirals of death.

**Signals.** Physics updated with raw frame delta; behavior differing at 60 and 144 Hz; huge jumps after tab switches.

**Ask.** Does the simulation behave identically at different frame rates?

**Traps.** Fixed steps too coarse for fast-moving objects.

## GPU resources need owners {#resources}
<!-- terms: dispose dispose() gpu memory leak texture geometry render target context lost cleanup -->

**Principle.** Dispose geometries, textures, materials and render targets when they leave the scene, and handle context loss.

**Why.** JavaScript garbage collection does not free GPU memory; undisposed resources leak until the browser tab crashes, especially in single-page apps that mount and unmount scenes. WebGL contexts can be lost on mobile or driver resets; robust apps rebuild resources on restore.

**Signals.** Scenes created repeatedly without cleanup; GPU memory growing over navigation; no context-loss handling.

**Ask.** When this scene or object is removed, what frees its GPU resources?

**Traps.** Disposing shared resources still used elsewhere.

## Verify renders visually {#verify}
<!-- terms: screenshot render verify visual check camera framing composition artifact z-fighting -->

**Principle.** Confirm 3D output by rendering and inspecting frames from the intended camera, checking for artifacts, framing and composition.

**Why.** Graphics bugs are visual: z-fighting, missing faces, wrong scale, black textures, clipped cameras, invisible objects. Code review cannot see them. Rendering stills from key camera positions—ideally automated—catches them quickly and documents the intended look.

**Signals.** Scene code changed without any rendered frame inspected; camera framing never checked.

**Ask.** Which rendered frames confirm this scene looks as intended from its main camera views?

**Traps.** Checking only the default camera angle.
