# Image, SVG and narrated motion workflows

These tools produce editable sources, decoded artifacts and bounded receipts. Review the delivered pixels, playback and audio before claiming that the creative result meets the brief. Tools are discovered from image, SVG, video, audio and Blender task intent; `tool_search` also exposes them explicitly.

## Image generation and reference editing

`/models` now has Images, Video and Audio tabs with independent media routes, session-only until saved with Ctrl+S. `image_generate` uses the exact configured model; explicitly choosing automatic enables capability and conservative fixed-price planning. See [media choices and bounded generation](VIDEO-STUDIO.md#media-choices-and-bounded-generation). An explicit `model` overrides `PI_IMAGE_MODEL` for that call and leaves the session model alone. `action:"status"` reports configuration without exposing keys. For OpenRouter, `refresh:true` queries the live Images API catalog, including supported parameters; use the returned exact ID with `transport:"images"`. The existing chat image transport remains available. Native OpenRouter calls also expose aspectRatio (such as 16:9) and resolution (512/1K/2K/4K); choose only settings advertised by that model. Exact size and aspectRatio cannot be combined. Native OpenRouter images use POST `/api/v1/images`; OpenAI-compatible backends retain `/images/generations`. `action:"plan"` checks compatible capabilities and price before a paid request, while `maxCostUsd` requires a known fixed image price. No paid fallback or retry chooses another model.

```json
{"action":"generate","model":"gpt-image-1.5","prompt":"A photograph of the product in the supplied art direction, with space for the headline","role":"hero-focal","quality":"high","format":"webp","compression":85}
```

Configure `PI_IMAGE_BACKEND=openai-compatible` with the appropriate URL and credentials for that example. OpenRouter accepts its own exact model IDs. Models and supported settings change: query the catalog and provider documentation rather than assuming that an ID or parameter works everywhere.

```json
{"action":"edit","references":["product.png","lighting-reference.jpg"],"model":"gpt-image-1.5","prompt":"Preserve the product identity and proportions; use the second image only for lighting","inputFidelity":"high","format":"png"}
```

Edits accept one `path` or up to five `references`. The compatible backend also accepts a PNG `mask` matching the first reference's dimensions, with alpha zero in editable pixels. The tool rejects opaque masks and dimension mismatches before uploading. Reference files and masks together are bounded to 40 MiB. OpenRouter reference edits have no defined mask semantics and reject masks.

GPT Image requests omit the unsupported `response_format` field and reject `seed`. `inputFidelity` is exposed only where accepted by the selected GPT Image family; unsupported fidelity is rejected. PNG and WebP can preserve transparency; JPEG cannot. Compression requires JPEG or WebP. Receipts preserve hashes, reference/mask provenance, requested encoding, actual decoded dimensions and sampled alpha. Generation, decoding and visual approval are separate facts.

Once a provider returns complete image bytes, the tool saves them before local decoding or registration. Cancellation after the response, corrupt image data, and registry failures keep the bytes and a `recovery.json` receipt with the observed decode/registration state and reported usage. Reuse a decoded retained image and repair its bookkeeping; inspect decode-unverified bytes before requesting another paid take. Invalid mask types never silently become an unmasked edit.

URL-only provider results receive a private `download.json` checkpoint before the download, preserving the original usage and edit provenance. `image_generate action:recover path:<checkpoint>` resumes a bounded, validated GET without generation credentials or another generation request. Failed downloads keep that checkpoint; an expired URL reports failure without regenerating. Recovery preserves its input checkpoint and additional files in that folder.

The request formats follow the official [OpenAI generation](https://developers.openai.com/api/reference/resources/images/methods/generate), [OpenAI editing](https://developers.openai.com/api/reference/resources/images/methods/edit) and [OpenRouter image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) documentation.

## Understanding and converting images

`image_understand` sends real image attachments through the current model's provider registry, preserving OAuth headers, gateway configuration and thinking level. It refuses a text-only model. `action:"models"` lists available vision models; `provider` and `model` select an explicit alternative for this call. The response identifies source hashes, original dimensions, optional crop and sent dimensions. Observations remain model inference.

```json
{"path":"layout.png","prompt":"Identify clipping and unreadable labels. Separate visible observations from inference and refer to source regions.","region":{"x":120,"y":40,"width":600,"height":400},"maxTokens":2048}
```

Up to eight images can be compared with `paths`. Prepared attachments are bounded to 12 MiB, sources to 40 MiB, and each decoded attachment to four million pixels. Crops and pixel coordinates use stored pixel axes; EXIF orientation is not automatically applied. Use `image_analyze` for deterministic palette/layout measurements and `image_ocr` for a separately inspectable text extraction.

`image_convert` preserves originals and writes fresh PNG, JPEG (`jpg`) or WebP files plus `conversion.json`. It supports batches of up to 12, clockwise rotation, flips, transparent containment, center cropping, stretching and explicit alpha flattening.

```json
{"paths":["cover.png","detail.png"],"format":"webp","width":1280,"height":720,"fit":"contain","quality":90}
```

`contain` pads; `cover` crops; `stretch` changes aspect ratio. A JPEG default uses white behind alpha; `background:"#rrggbb"` makes the matte explicit. EXIF orientation is not applied; use `rotate` when needed. Metadata is removed. GIF, APNG and animated WebP are rejected instead of silently losing frames. Individual outputs/intermediates are bounded to 16 million pixels, and batch work to 96 million output/intermediate pixels. All sources are preflighted before any output is allocated.

## Raw SVG art and animation

Write the source as an actual SVG, with a meaningful `viewBox`, stable IDs, accessible title/description and explicit paint. `svg_inspect` checks references, source geometry and intended-size render matrices. `svg_render` accepts a local `path` or raw `svg` source and renders real browser frames or an H.264 MP4.

```json
{"path":"art.svg","width":640,"height":640,"duration":3,"times":[0,0.75,1.5,2.25,3],"background":"transparent"}
```

The renderer seeks CSS/WAAPI animations and SVG SMIL roots to absolute time before capturing. Data tracks add programmatic attribute animation without running source scripts:

```json
{"path":"art.svg","mode":"video","duration":3,"fps":24,"width":640,"height":640,"tracks":[{"target":"orbit","property":"transform","keys":[{"time":0,"value":"rotate(0 320 320)","ease":"smooth"},{"time":3,"value":"rotate(360 320 320)"}]}]}
```

Track targets must exist. Duplicate owners, unordered times, changed numeric topology, invalid scalar dimensions and unsupported attributes are rejected. Path keys need valid commands beginning with moveto; transform keys need valid affine functions and argument counts. Colors interpolate RGB; numeric path/transform tokens interpolate with linear, smooth or hold easing. Convert arc paths to cubics before morphing `d`; arc flags require another interpolation contract. SMIL/data ownership collisions reject during preflight; CSS/data collisions reject before capture. Use one animation owner per property.

The export preflight parses XML without accepting recovery and rejects scripts, event handlers, external references and foreign namespaces before a pipeline starts narration or music synthesis. Escape text such as `R&amp;D` correctly and declare the SVG namespace. The browser repeats XML/namespace checks before painting. Network and downloads are blocked, CSP forbids page scripts, and the only browser code executed is harness-owned clock logic. Arbitrary JavaScript/RAF and scroll timelines require an independently seekable page workflow. `motion_inspect` now also seeks discoverable SVG SMIL roots in page captures, and reports their sampling scope separately from CSS descriptors.

Video uses frame times `i/fps` and excludes the duration endpoint. Frames mode allows up to 12 timestamps and transparent PNG output. H.264 requires an opaque background and even dimensions. Exports are bounded to 30 seconds, 900 frames, 600 million pixel-frames and 512 MiB of frame data, with cancellation and queue limits. Receipts include source/tracks, contact sheets, timestamps, decoded video, cadence and optional loop diagnostics. `reducedMotion:true` selects the CSS preference; authored SMIL/data tracks still need a deliberate stable alternative.

SVG diagnostics group identical observations with their first/last frame and occurrence count. This keeps repeated clipping compact while retaining late distinct findings; an omitted-observation count makes overflow explicit. Bounds are approximate and exclude stroke/filter expansion, so inspect the actual pixels at intended sizes.

## Narration, music and 2D/3D delivery

`narration_tts action:"speak"` generates standalone speech without a Remotion project, preferring timestamped ElevenLabs when `ELEVENLABS_API_KEY` is configured. `backend:"piper"` keeps local speech available after an explicit install. It returns a mastered WAV, word timing, SRT/VTT captions and a receipt that distinguishes measured from estimated timing, and bounds standalone speech to 120 seconds. `voiceId`/`model` select exact ElevenLabs identifiers; `voice` selects Piper. Cloud speed is 0.7–1.2; Piper speed is 0.6–1.5. Cloud requests send text to ElevenLabs and do not retry paid failures automatically.

```json
{"action":"speak","text":"The shape turns as the light moves.","style":"calm","speed":1,"lexicon":{"SVG":"ess vee gee"}}
```

`media_pipeline` can render a Three.js scene JSON or an SVG, synthesize narration, compose an editable music score, duck music under voice, encode video and measure the delivered AAC audio in one call. Narration overruns reject before video rendering, rather than silently truncating speech.

The pipeline checks the exact score renderer and local SoundFont bank before narration starts. A later failure or cancellation preserves any paid speech checkpoints and writes `pipeline-recovery.json` when possible. Reuse a completed narration artifact as a `role:voice` track and omit `narration` on the next pipeline call. An unknown submission outcome retains its checkpoint for inspection against provider history; it never silently retries payment.

Three.js pipelines use a bounded, validated scene snapshot for both the audio clock and video rendering. Source edits during synthesis do not change that take. The `visual` receipt identifies the original source, editable snapshot and content hash, and retains available contact-sheet, diagnostic and motion evidence instead of discarding the renderer's review context. Media subprocesses finish closing before worker slots or failed output folders are released.

For longer projects, use the [video studio](VIDEO-STUDIO.md): per-scene narration checkpoints, resumable frame-contiguous render parts, timed browser recordings, surface detail for Blender shots and `media_sync` for text/voice/cut comparisons. `narration_align` locates a supplied transcript in existing speech; `audio_generate` adds directed instrumental music and sound effects through ElevenLabs. Generated timing and duration are evidence to inspect, and alignment is not independent transcription.

```json
{"animation":"art.svg","duration":6,"width":640,"height":640,"fps":24,"narration":{"text":"The shape turns as the light moves."},"score":{"bpm":120,"beats":4,"tracks":[{"notes":[{"pitch":57,"start":0,"duration":4}]}]},"targetLufs":-16}
```

For Three.js scenes, duration comes from scene JSON and `duration` is omitted. `scene_create` retains editable geometry, materials, lights, camera and keyframes. `scene_render` now adds decoded cadence and loop diagnostics to its existing pixel samples. For assembled Blender footage, pass rendered clips to `media_pipeline` with the same narration/score options. A music score is editable synthesis, not evidence of convincing acoustic instruments.

`blender_inspect` accepts `scene` and up to 12 evaluated `frames`. It reports layered/slotted action channels, key ranges, interpolation, muted curves, duplicate times, driver/NLA counts and evaluated world transforms. This uses Blender's [layered action API](https://developer.blender.org/docs/features/animation/animation_system/layered/) rather than relying on removed legacy fields.

```json
{"blend":"scene.blend","frames":[1,24,48]}
```

`blender_render` preserves the scene's `fps/fps_base` and source-frame gaps when assembling a stepped animation. Frames 1, 3 and 5 at 30 fps become five encoded frames, holding each earlier sampled frame through its gap. Passing an explicit output `fps` retimes the rendered samples uniformly instead. Assembly stages a contiguous sequence without overwriting render files, probes and decodes the result, and records timing in `render.json`. Duplicate/invalid frame indices fail before rendering.

Review early low-resolution samples before expensive ranges. Inspect scene lighting/materials, moving pivots, off-camera geometry, action/NLA interactions, actual video playback, pronunciation and final music balance. Technical receipts support those reviews; they do not approve art automatically.
