# Motion and model preflight

Use the existing owners: encoded video uses `media_info`; 3D models are registered and inspected with `asset_register` and then loaded into a film's three.js scene. A preflight receipt is technical evidence. Appearance, easing and storytelling still require actual pixels and playback.

## Inspect the delivery clock

```json
{"action":"motion","path":"renders/final.mp4","start":0,"duration":10,"expectedFps":30,"loop":true}
```

`media_info` decodes every frame in the window into a 64×64 grayscale proxy without an fps filter. It reports original presentation timestamp cadence, the largest gaps/changes, duplicate frames, low-change stretches of at least 0.5 seconds, and an optional last→first boundary comparison. The default window is 10 seconds; maximum 30 seconds and 1800 frames. A longer/high-fps window fails with a request to shorten it, rather than silently sampling. Temporary proxy files are removed on success, failure and cancellation. The proxy is at most 7,372,800 bytes; the receipt stores summaries, not a per-frame log.

`expectedFps` checks an intended fixed export clock. Cadence differing by more than 50% and a typical interval differing by more than 5% become technical failures. Without a requested clock, variable cadence is advisory. `loop:true` compares the decoded last→first boundary against ordinary adjacent changes; the requested window must span the intended loop. A boundary warning needs playback inspection. Static holds can be intentional and are warnings.

## Reuse and inspect a model

```json
{"action":"inspect","path":"assets/prop/model.gltf"}
```

`asset_register inspect` is read-only. Local `.gltf` and `.glb` preflight checks glTF 2.0 headers/chunks, contained local resource paths, declared buffer/accessor ranges and alignment, primitive index ranges, node parent/cycle invariants and finite decoded positions/time inputs. It returns counts, mesh-local bounds from available position bytes, animation clip durations from decoded time bytes, image header dimensions, required loader extensions and budget warnings. Relative local dependencies must stay inside the model directory; remote, traversal and escaping symlink references are rejected. Base64 buffer/PNG/JPEG/WebP data URIs are bounded.

Limits: JSON 2 MiB, any resource 40 MiB, bundle 96 MiB, 128 resource files, 4096 entries per structural collection, 2048 primitives, two million declared vertices and eight million decoded components. The receipt shows at most 16 resources/mesh bounds/image dimensions/animation clips and twelve warnings, with explicit truncation. Decoder extensions are identified for the existing loader. Compressed and sparse payloads are bounded but remain undecoded; full Khronos conformance, texture decoding, world/skinned bounds and GPU cost are unverified. Layout checks follow the [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).

Registration accepts `sourceUrl`, `creator` and `licenseUrl` alongside existing license/description fields. Model records keep a compact advisory summary. Model deduplication includes local resource hashes so equal JSON referencing changed geometry is not treated as the same content. Search terms `3d`, `model`, `gltf` and `glb` find registered models. Cached registrations are not current-file evidence; run inspect again after edits.

A model that a film loads should keep its relative resource files beside it, in the film's `public/` folder, so the loader can resolve them. The plain three.js `GLTFLoader` does not decode Draco, Meshopt or KTX2 payloads; configure those decoders before rendering such assets. Render representative stills with `video_render` `mode:"stills"`, and preview playback, before delivery.

## Verification

`tests/media-preflight.test.mjs` builds authored glTF/GLB fixtures in temporary directories and has four cases. glTF/GLB inspection reads decoded positions and timing and caches provenance in the asset registry. Malformed chunks, missing or escaping resources, oversized work, invalid indices and node cycles are rejected. Motion checks run on rendered FFmpeg frames and report frame timing, intentional holds, the loop boundary and compact receipts; that case is skipped when FFmpeg is absent. Timestamp and loop evidence are checked so that a bad boundary is told apart from normal adjacent motion. No binary fixtures are downloaded or committed.
