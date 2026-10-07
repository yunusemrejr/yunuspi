# Native production contracts

Use the native tools for repeatable staging. The selected LLM supplies the visual argument, copy, assets and choreography; the tools own geometry, frame clocks, fitted regions, footage crops and evidence. The same contract is available to every model. It does not guarantee good direction for every brief.

## Stage a beat without scene code

After `video_project init`, compose the master timeline:

```json
{"action":"compose","dir":"film","scenes":[{"id":"payoff","seconds":4,"headline":"Make the next step clear.","kicker":"A WORKING PRODUCT","layout":"hero-right","hero":{"kind":"shot","shot":"device","screen":{"src":"assets/walkthrough.mp4"},"motion":{"enter":"pop","cue":"reveal","duration":0.8,"easing":"spring"},"sound":"pop"},"narration":"See the next step, then make it happen.","cues":{"reveal":0.4},"cueWords":{"reveal":"step"}}]}
```

`hero-left`, `hero-right`, `screen`, `full` and `type` reserve regions according to landscape or portrait canvas. Headlines wrap and fit the actual loaded font, with deterministic line reveals. Keep copy short; fitting a paragraph into a region still produces an unreadable paragraph. Captions have their own bottom area. Explicit `layers:[{id,kind,box,...}]` replace auto layout; `box:[x,y,width,height]` uses fractions of the canvas. Layer order is back to front.

Choose motion by meaning. A product resolves into position; a measurement advances; an object articulates to show how it works. `motion.keys:[{t,x,y,scale,rotate,opacity}]` uses scene-relative seconds and normalized translations. `motion.cue` starts at a named scene cue and follows measured `cueWords`. `easing` supports smooth, snappy and a seekable analytical spring. Shape, text, image, video and shot layers share one clock. Custom React/HTML/Blender code remains available for specialized effects.

## Real browser actions and readable crops

Inspect the website first and record selectors that exist. Use bounded takes:

```json
{"path":"demo.html","device":"desktop","seconds":8,"accent":"#1565c0","steps":[{"action":"click","at":0.6,"duration":0.7,"selector":"#explore"},{"action":"wait_text","at":1.5,"text":"Project details"},{"action":"highlight","at":2,"duration":1.2,"selector":"#details"},{"action":"scroll","at":4,"duration":1,"dy":480}]}
```

`device:"phone"` sets mobile viewport/touch emulation and a touch marker. `tap` generates a real touchscreen event. `type` focuses its selector; `press` accepts `text` or `key`. Selector highlights dim the surroundings. The take records observed pointer, target, click/tap, typing, press and scroll times, plus actual source-frame timestamps. Planned times are intentions, not evidence of when an action happened.

Import the take with `video_assets action:"import"`. It returns the copied media path and portable `compose.take`; the metadata excludes runtime directories and URLs. Compose a video hero:

```json
{"kind":"video","src":"assets/walkthrough.mp4","take":"public/assets/walkthrough.take.json","zoom":1.8,"lag":0.35,"chrome":"browser","label":"studio.example","startFrom":1,"speed":1}
```

The camera establishes the view before easing into the crop. It follows observed action targets/clicks when available, or pointer motion for freeform takes, with bounded lag and no exposed empty pixels. `follow:false` imports sound cues without automatic camera movement. `camera:[{t,x,y,zoom}]` gives direct control on the source clock; x/y are source fractions and zoom is 1–4.

Native layer and screen `startFrom` are **seconds**. Legacy Remotion `Clip startFrom` is **frames**; do not pass seconds there. Source time is `startFrom + sceneTime*speed`, while imported click accents are `(eventTime-startFrom)/speed`. The compose tool probes media dimensions and rejects footage shorter than its visible scene. Record enough source or shorten the beat. Hold a still deliberately instead of relying on a decoder's accidental final-frame hold.

## Editable 3D that belongs to the film

A native shot builds authored forms without improvising a bpy script. For mixed graphic/3D shots, image planes retain raster alpha, instances share geometry and stagger motion, and cameraPath keys author flythroughs with target/lens changes. Run action:"plan" to validate references and render work before a short preview. See [image-card and camera contracts](../../../public-template/docs/VIDEO-STUDIO.md#image-cards-arrays-and-camera-flythroughs).

```json
{"dir":"film","name":"device","scene":{"objects":[{"id":"laptop","shape":"laptop","color":"#b6bdc7","motion":[{"t":0,"rotation":[0,0,-12]},{"t":4,"rotation":[0,0,4]}]}]},"rig":"static","azimuth":6,"elevation":9,"shadow":"none","seconds":4,"mode":"preview"}
```

Devices have modeled bezels, screens, keys or buttons and named screen corners. Size is the whole device `[width,depth,height]` in metres, including an open laptop lid. Omit it for authored proportions; use `scale:[s,s,s]` to resize uniformly. The tool rejects a flattened device. Native geometry is Z-up, camera facing from -Y; rotations are degrees. Object transform keys are scene-relative seconds. Parent IDs form articulated hierarchies and cannot cycle.

Use `lathe` with `[radius,z]` profile points for designed radial silhouettes, `tube` with `[x,y,z]` points for smooth paths, or smooth box/sphere/cylinder/torus forms. Use `shape:"model",path,size` for detailed licensed assets; imported hierarchy/materials are retained, the longest extent fits `size[0]`, and the bottom is grounded. Primitive piles are not convincing substitutes for detailed food, people or interiors.

`video_assets` can fetch license-tracked Poly Haven PBR map sets or HDRI environments. Surface maps carry sRGB diffuse and Non-Color roughness/metallic/OpenGL normals. Imported models keep their authored materials. Inspect the silhouette and lighting before adding microdetail. Stage blockout → final hero asset → lighting/materials → motion → review; more samples do not repair a weak silhouette.

Existing `.blend` shots default to their authored camera, world, lights, engine and color management. Request a studio rig/lighting/environment explicitly when needed. New shots default to a restrained orbit; `turntable` is an explicit looping demonstration, not a default advertisement move. Swept bounds and per-frame framing evidence help reveal clipping.

The saved `.blend` remains editable. Review the attached contact sheet and preview, then rerender with `mode:"final",replace:true`. Final shots use film fps; a 12 fps draft cannot silently become a 30 fps final. `stepped:true` is only for intentional stop-motion. Split long choreography into shots rather than lowering its delivery cadence to evade the 600-frame shot budget.

## Put footage on the real screen

A native device emits `screen:tl`, `screen:tr`, `screen:br`, `screen:bl`. Set `hero.screen:{src,startFrom,speed}` in a shot layer. `ShotScreen` computes a projective transform at each rendered frame, in the same fitted region as the device. An edge-on or occluded screen hides. Screen dimensions are probed; a phone take keeps portrait aspect. Multiple devices need distinct `screenPrefix` values.

This method composites footage over the device's rendered screen and does not add screen-content reflections to surrounding geometry. Bake an emission texture with the motion library's HTML-as-texture example when those reflections matter. Do not guess independent CSS tilts for an animated Blender device.

## Sound, sync and longer films

`narration_tts backend:"auto"` prefers configured ElevenLabs and preserves exact voice/model choices. `cueWords` connect speech to visible gestures; rerun `media_sync` after narration or timing changes. Existing cloud checkpoints, forced alignment and segmented rendering remain available.

For directed music/SFX use `audio_generate`. For authored instrumentation use `music_compose` with a licensed local SF2/SF3 bank and libfluidsynth. It retains MIDI, JSON, stereo instruments, note timing and release tails. Without a configured bank, auto returns an explicitly labeled oscillator audition. Listen to timbre and composition; the renderer cannot compose a good score for you. `audio_synth sound_design` uses recorded browser accents and named native-layer gestures, alongside timeline cues. The compositor fades the music ending and ducks it under narration.

Keep all sections in one master `video.json`. Compose or append scene batches, synthesize changed narration scenes, and render bounded `segments`. Continue `complete:false` receipts until assembly is complete. Scene seek, crop, screen projection and sampled springs use absolute frame clocks and survive part joins. Check both sides of each join in the delivered encoding.

## Review evidence

Inspect actual frames against the storyboard: occupied hero region, readable type, silhouette, material, contrast, intersections and continuity. `video_qa` returns strips covering entrances, settled composition, keyed gestures and final scene frames, paginated by `startScene`; strips are attached to vision-capable tool responses. Technical success leaves `reviewStatus:"unreviewed"`. Watch actual motion and listen to the final encoding before approving pacing, sync, music or narration. A render, a histogram and a clean lint are not artistic judgments.

## Related source patterns

These projects informed the contracts above; no third-party code or paid Motion+ content is bundled:

- [Blender Agent Studio](https://github.com/ifBars/blender-agent-studio), MIT, reviewed at `9191be7ee2b5ce4bd0596fadcddf8f7b0c6ec3b1`: part/relationship/style contracts, critical-frame evidence, separating execution checks from perceptual judgment.
- [blender-skills](https://github.com/arjun988/blender-skills), MIT, reviewed at `8f778d2405a214b508d4c7d80742be8e43acdd52`: purposeful camera choices and severity-based render review.
- [MCP for Blender](https://github.com/ahujasid/mcp-for-blender), MIT, reviewed at `7a0373ec9199183cb460068c4f96aed9c579fb4f`: real-scale blockouts, preserved authored cameras and grounded asset imports.
- [Motion AI Kit](https://motion.dev/docs/ai-kit): reusable motion guidance and documentation access. YunusPi's frame-sampled springs are implemented locally; no Motion+ subscription or runtime is required by these tools.
