# Blender-driven motion

Blender gives a film what HTML cannot: real lighting, physically plausible materials, depth of field, soft contact shadows, camera moves through a believable space. The harness runs it headless: `blender_run` executes a script that builds or edits a scene (and saves a `.blend`), `video_shot` renders a camera move around that scene into the project as an RGBA frame sequence with a manifest and per-frame screen positions of named anchors. The editable `.blend` always stays in `blender/`. The blender-production skill covers headless discipline; this file covers what to build and how to make it look designed.

## The loop

1. Build the subject with a script (examples: `blender/product-hero.py`, `kinetic-type-3d.py`, `materials.py`, `geonodes-terrain.py`, `html-as-texture.py`). Deterministic names and no randomness without a seed, so a re-run replaces instead of duplicating.
2. `video_shot` at the default preview (half size, 12 fps, 16 samples) with a `rig`, `lights`, `material` if the subject has none, and `anchors` for features to annotate. Open the contact sheet and the preview video; change rig, elevation, lens, margin, offset or palette with `replace:true` until it reads.
3. Render the delivery version once (`mode:"final"`), in the background, only after framing and lighting are locked.
4. Use it with `ShotScene` / `BlenderShot` in the Remotion timeline; pin text with `ShotNote` / `ShotAnchor`.

## Rigs (video_shot `rig`) and custom moves

`turntable` (steady yaw), `orbit` (arc with slight elevation change; default for titles), `push-in`, `pull-out`, `crane` (rise while orbiting), `drift` (slow, almost static; best behind type), `static`. Parameters: `azimuth`, `elevation`, `elevationEnd`, `degrees` (sweep), `travel` (dolly), `lensMm`, `ease`, `margin`, `offset` (shifts the subject off-centre to make room for type), `fStop` (depth of field), `motionBlur`.

For a move the presets do not cover, key your own camera in the scene (`blender/camera-rigs.py`): dolly zoom (lens proportional to distance keeps the subject's size constant while the background stretches), crane (camera on a Bezier path with Follow Path, Track To last in the constraint stack), seeded handheld (fractal noise sampled to keyframes), focus pull (DOF `focus_distance` keyed between two objects), whip pan (fast yaw into a blur frame; the cut hides inside it).

Composition for video: leave a quiet region (the `offset` parameter) for the headline; wide lenses (24-35 mm) for spaces and energy, long lenses (65-100 mm) for products and calm; keep horizon and verticals deliberate.

## Lighting (video_shot `lights`)

`softbox` (large key + fill, product default), `rim` (dark ground, edge light separates the subject; good for titles), `top` (even overhead, tabletop feel), `overcast` (dome, soft and low contrast), `scene` (keep the blend's own lights). Lighting is tinted from the film's palette automatically. Rules that matter: one key, a rim to separate from the ground, never flat front light; contrast between light and shadow sides gives form; the background colour is the film's, so judge on it.

## Shadows and ground

`shadow:"soft"` composites a soft contact shadow under the subject (EEVEE has no shadow catcher, so the worker renders the object with and without the shadow-casting floor in linear EXR and composites the difference with a contact light); `shadow:"catcher"` uses Cycles' real shadow catcher (slower, truly accurate); `"none"` for floating subjects. Shadows are what make 3D sit in a 2D film.

## Materials (video_shot `material`, or build your own)

`keep` leaves the blend's materials; `clay` neutral, matte (to judge form); `satin`, `metal`, `glass`, `glow` presets tinted from the palette. For authored work see `blender/materials.py`: real surfaces vary, so mix large- and micro-scale noise in roughness; brushed metal is anisotropy plus a bump stretched along one axis; glaze is a base colour plus clearcoat; wax and skin need subsurface scattering with a short radius; frosted glass is rough transmission; rubber is high roughness with micro bump. Colour is passed in from the palette; never leave a library default. The view transform is Khronos PBR Neutral so palette colours are not desaturated or hue-shifted by a filmic curve.

## Anchors

An anchor is an object (usually an Empty) at a 3D feature, or a bounding-box point (`bbox:top|bottom|left|right|front|back|center`). `video_shot anchors:[...]` projects each to screen space for every frame (`anchors.json`: x, y as fractions of the frame, `depth`, `visible`), so 2D labels follow the object and fade when it turns away. Create them in the build script (`bpy.ops.object.empty_add`, name `Anchor_Dial`) at positions that mean something (a port, a dial, a seam).

## Procedural geometry and 3D type

- 3D type: one Text object per letter gives per-letter pivots and keyframes (kinetic-type-3d); extrude and bevel so edges catch light; Blender reads `.ttf`/`.otf` only, not `woff2`.
- Geometry Nodes (`geonodes-terrain.py`): a node group is a function geometry -> geometry; displacement with animated 4D noise (W is time) gives terrain, cloth-like surfaces or landscapes that evolve without simulation; Set Material inside the group (modifiers replace the mesh and drop slots).
- Product hero: build with the data API, one bevel radius everywhere (bevels catch the light that makes forms read), detail that survives 4K (a knurled dial from a radial array, an inset display with a real emission material).

## Cost and honesty

- A preview frame is ~0.3-1 s at 640x360; a final 1080p EEVEE frame ~2-6 s; Cycles with denoise 10-60 s. The shot result reports `secondsPerFrame` and an estimate for the final.
- 12-15 fps previews are drafts. Final shots use the film fps with no blending by default; only intentional stepped motion can opt out.
- Blender 5 API changes you will hit: no `Action.fcurves` (set `bpy.context.preferences.edit.keyframe_new_interpolation_type` before keying); `transform_apply` bakes location by default (`location=False` to keep it); text objects cannot apply rotation before conversion to mesh.
- The preview is not the delivery: say so when you show it.
