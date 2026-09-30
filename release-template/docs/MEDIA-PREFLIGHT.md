# Motion and model preflight

Use the existing owners: CSS/WAAPI page motion uses `motion_inspect`; encoded video uses `media_info`; imported 3D models use `video_assets` and the existing `Model3D`/Three.js renderer. A preflight receipt is technical evidence. Appearance, easing and storytelling still require actual pixels and playback.

## Inspect the delivery clock

```json
{"action":"motion","path":"renders/final.mp4","start":0,"duration":10,"expectedFps":30,"loop":true}
```

`media_info` decodes every frame in the window into a 64×64 grayscale proxy without an fps filter. It reports original presentation timestamp cadence, the largest gaps/changes, duplicate frames, low-change stretches of at least 0.5 seconds, and an optional last→first boundary comparison. The default window is 10 seconds; maximum 30 seconds and 1800 frames. A longer/high-fps window fails with a request to shorten it, rather than silently sampling. Temporary proxy files are removed on success, failure and cancellation. The proxy is at most 7,372,800 bytes; the receipt stores summaries, not a per-frame log.

`expectedFps` checks an intended fixed export clock. Cadence differing by more than 50% and a typical interval differing by more than 5% become technical failures. Without a requested clock, variable cadence is advisory. `loop:true` compares the decoded last→first boundary against ordinary adjacent changes; the requested window must span the intended loop. A boundary warning needs playback inspection. Static holds can be intentional and are warnings.

`motion_inspect` samples each discoverable CSS/WAAPI animation at its own local time. Same animation count under reduced-motion never establishes a failure. A blocking finding requires equivalent running infinite transform timing and actual changing reduced-state pixels. Paused alternatives do not fail when forced seek samples move. Reduced capture failure is reported as unknown; a disabled pass is recorded as disabled. Matching known loop periods receive 0/period endpoint comparison, not an arbitrary first/last “seam” claim. Neither endpoint parity nor sparse frames establish velocity continuity or smoothness. JS/rAF, scroll timelines and frames remain outside this clock.

## Reuse and inspect a model

```json
{"action":"inspect","path":"assets/prop/model.gltf"}
```

`asset_register inspect` is read-only. Local `.gltf` and `.glb` preflight checks glTF 2.0 headers/chunks, contained local resource paths, declared buffer/accessor ranges and alignment, primitive index ranges, node parent/cycle invariants and finite decoded positions/time inputs. It returns counts, mesh-local bounds from available position bytes, animation clip durations from decoded time bytes, image header dimensions, required loader extensions and budget warnings. Relative local dependencies must stay inside the model directory; remote, traversal and escaping symlink references are rejected. Base64 buffer/PNG/JPEG/WebP data URIs are bounded.

Limits: JSON 2 MiB, any resource 40 MiB, bundle 96 MiB, 128 resource files, 4096 entries per structural collection, 2048 primitives, two million declared vertices and eight million decoded components. The receipt shows at most 16 resources/mesh bounds/image dimensions/animation clips and twelve warnings, with explicit truncation. Decoder extensions are identified for the existing loader. Compressed and sparse payloads are bounded but remain undecoded; full Khronos conformance, texture decoding, world/skinned bounds and GPU cost are unverified. Layout checks follow the [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).

Registration accepts `sourceUrl`, `creator` and `licenseUrl` alongside existing license/description fields. Model records keep a compact advisory summary. Model deduplication includes local resource hashes so equal JSON referencing changed geometry is not treated as the same content. Search terms `3d`, `model`, `gltf` and `glb` find registered models. Cached registrations are not current-file evidence; run inspect again after edits.

`video_assets import` copies a validated local model together with its relative dependencies into a fresh `public/assets/models/<name>/` folder, preserves the existing provenance manifest and adds the model to the same workspace asset registry. Existing files are preserved; supply another name to make a separate import. Fetched Poly Haven models receive the same structural inspection, provenance and registry summary. The `Model3D` primitive uses the existing plain `GLTFLoader`; required Draco, Meshopt or KTX2 decoding must be configured before rendering such assets. `scene_create` continues to accept procedural scene JSON. Render representative stills and preview playback through the existing video project before delivery.

## Verification

`tests/media-preflight.test.mjs` builds authored glTF/GLB fixtures in temporary directories, validates decoded bounds/times and provenance, rejects malformed/resource-escaping inputs, checks dependency-preserving import, and renders actual FFmpeg video, browser CSS motion and a GLB through the existing Three.js GLTFLoader to actual WebGL framebuffer pixels. It covers VFR timing, the frame work bound, cancellation, static holds, loop boundary evidence, reduced-motion pixels and compact receipt sizes. No binary fixtures are downloaded or committed. `PI_REQUIRE_MEDIA_TEST=1` makes missing browser prerequisites fail rather than skip.
