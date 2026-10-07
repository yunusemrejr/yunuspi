# Merging HTML motion with Blender

The two approaches are strongest together: Blender owns form, light, depth and camera; the page (or Remotion) owns type, rules, data and timing. The seam between them is a small number of contracts. Choose the merge by which side must drive the other.

## 1. Remotion composes them (default)

`video_shot` renders the Blender subject as an RGBA sequence with anchors; the Remotion template plays it (`BlenderShot`), pins annotations (`ShotNote`, `ShotAnchor`), and layers HTML motion pages (`HtmlScene`/`HtmlMotion`) behind or in front. Order in a scene: backdrop (HTML shader field, transparent) -> Blender shot -> type/annotations -> optional `Grade`. One timeline, one look, one render. Use this unless a reason below applies.

```json
{"component":"ShotScene","props":{"shot":"gauge","notes":[{"anchor":"LensTip","text":"Dial","cue":"note"}]}}
{"component":"HtmlScene","props":{"src":"html/webgl-domain-warp.html","props":{"transparent":true}}}
```

Rules: derive the HTML page's theme from the film (HtmlScene supplies it); light the Blender shot with the film's palette (`video_shot` does); the same typeface appears in both layers' annotations because both read the film's fonts.

## 2. HTML drawn over a Blender shot, no framework (`merge/shot-overlay.html`)

A single page draws the shot's frames on a canvas (decoded on demand, frame-rate-matched source for delivery; optional blending can ghost edges) and SVG annotations positioned from `anchors.json`. Use when the annotated clip should be a standalone HTML/`render.mjs` artifact or when the overlay design is complex DOM/CSS. From `public/html/` reference the shot as `../shots/<name>`. Labels flip sides to stay on canvas, hide when the feature is occluded, and use the film's fonts.

## 3. Tracked device screens and baked textures

For a native phone/laptop, `video_shot scene` emits `screen:tl/tr/br/bl` anchors. Compose `hero:{kind:"shot",shot:"device",screen:{src:"assets/take.mp4",startFrom:0}}`; `ShotScreen` uses a per-frame projective transform and hides an occluded/edge-on screen. Footage changes without another Blender render. The shot and fitted region share transforms, so the screen follows the actual camera and device motion. Screen `startFrom` is seconds and optional `speed` is independent of device playback. This is a composited screen without screen-content reflections. Use the baked method below when lighting/reflections need the content.

### HTML as a texture in Blender (`blender/html-as-texture.py`)

Render the page to frames (`render.mjs`), then use the sequence as the emission texture of a screen: UI, dashboards, titles and charts on glass in a perspective shot with reflections. `video_shot` the saved `.blend`. Type stays crisp because it was rasterised at the page's resolution; to change the screen, edit the page and re-render. Typical uses: a laptop or phone hero, a billboard in a scene, a monitor in an environment, wall projections.

The reverse also works: HTML-generated patterns (noise, halftone, gradients) as Blender displacement, roughness or emission maps (render a still with `render.mjs`, load as an image texture with Non-Color data for maps).

## 4. FFmpeg composite of a Blender shot over any background (`merge/composite.mjs`)

When the background is a video (an HTML-rendered `motion.mp4`, a numpy clip, footage) and no Remotion pass is wanted: overlay the shot's RGBA sequence with straight alpha, match source frames to the film's fps, hold the last frame of a non-looping shot, apply one grade (warm/cool/none) over the finished picture, map audio. Grading the finished composite is what makes the 2D and 3D layers feel like one photograph.

## 5. Data handoffs in either direction

- Blender -> page: anchors (screen positions), depth, visibility; for depth-aware effects, render a depth/mist pass image and feed it to a WebGL page as a texture for depth-of-field or fog that matches.
- Page -> Blender: audio envelope or beat times (`html/extract-envelope.py`) drive keyframes (emission strength, camera shake, scale pulses) in the build script; data (JSON) drives geometry (bars, terrain height) so charts exist in space.
- A shared `props.json`/palette: read colours once from the film's `video.json` theme and pass to both sides as hex.

## Handoff checklist

- Same palette, same fonts, same frame rate and aspect on both sides; check the aspect before rendering (pixel size ratio).
- Transparency: shots are straight-alpha PNG; HTML layers use `transparent:true`/`--alpha`; flatten only for review.
- Colour: the Blender view transform is Khronos PBR Neutral; judge colour in the composite, not the Blender window.
- Timing: cues come from `video.json`; shots start at their scene's first frame (`BlenderShot offset`/`speed` to retime); HTML pages get time from `HtmlMotion` (`from`, `speed`).
- Parallax coherence: if an HTML background has depth cues (perspective grid, vanishing point) and the Blender camera moves, match them or keep the background flat/abstract; a mismatched horizon is the most common tell.
- Review the *composite*: contact sheet at transitions and at the moment each annotation lands.

## Choosing quickly

| Need | Merge |
|---|---|
| Labelled 3D in a narrated film | 1 (ShotScene notes) |
| Annotated clip as an HTML artifact | 2 |
| App/screen/chart inside a 3D scene | 3 |
| Quick finished clip, no Remotion | 4 |
| Music or data shaping 3D motion | 5 |
