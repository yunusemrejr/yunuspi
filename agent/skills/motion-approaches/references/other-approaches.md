# Other approaches

Beyond HTML and Blender, these are available offline here and have a worked example or a clear pattern. Prefer the simplest that does the job.

## FFmpeg filter graphs and libass (`ffmpeg/ass-kinetic.mjs`)

- libass renders ASS subtitles with animation tags inside FFmpeg: `\move`, `\fad`, `\t(t1,t2,...)` interpolation of scale/rotation/blur/colour, `\clip` for mask wipes, `\blur`/`\bord` for edge shape. One event per word gives stagger; each event holds the whole row with the other words transparent, so libass lays out the text (no guessed widths) and animating one word never reflows its neighbours. Use `\fscy` (vertical-only) for squash and stretch.
- Generators: `gradients`, `color`, `geq` (per-pixel expressions), `mandelbrot`, `testsrc2` (not for design), `showwaves`/`showspectrum` for audio visuals. Combine with `blend`, `overlay`, `xfade` (transitions: `wipeleft`, `circleopen`, `pixelize`, `radial`, `fadegrays`), `zoompan`, `curves`, `colorbalance`, `unsharp`, `noise`, `vignette`.
- Speed ramps with `setpts` expressions; time remaps for slow-motion with `minterpolate`.
- Strength: deterministic, fast, no browser. Weakness: layout and per-element easing are clumsy; use it for finish (grade, grain, composite) and simple type.

## numpy / Pillow frames (`python/numpy-frames.py`)

Frames as vectorised functions of `t` piped to ffmpeg: potential fields and isolines, reaction-diffusion, fractals, particle simulations with fixed seeds, data art. Palette via a 256-entry LUT, ordered dithering before 8-bit quantisation, loops by integer turns per clip. Anti-aliased lines at uniform width come from dividing the distance to the isoline by the field's gradient magnitude. ~40 ms per 720p frame for a field.

## Remotion-native

For text, layout, data and transitions driven by `video.json`, use the template primitives (`Heading`, `KineticText`, `Stage`, `Backdrop`, `BarChart`, `Counter`, `Graph`, `CameraMove`, `Glitch`, `FilmGrain`, `LightLeak`, `ShotScene`, `HtmlScene`, `Grade`, etc.) and `useCanvas()` layout units (short side = 1080 whatever the format). Use `interpolate`/`spring` from Remotion for motion; never CSS transitions or wall-clock timers.

## three.js (`Model3D`, opt-in)

`video_project action:"feature" feature:"3d"` adds a lit GLB to a Remotion scene with orbit. Good for quick 3D when Blender's cost is unjustified; no depth of field or soft shadows. When quality matters, prefer a Blender shot.

## Canvas without a page framework

Same contract as an HTML page (a function of `t`); `canvas-flow-field` and `audio-reactive-field` are the models. Add `OffscreenCanvas` only if a page needs it.

## Extending the library

Add an example under `agent/skills/motion-approaches/assets/examples/<approach>/` with a header comment containing a title line, `APPROACH` (HTML) or a first-line summary, numbered `CONCEPTS`, and `USE` or the command lines; `motion_examples` reads the header, so it is searchable at once. Verify it by rendering at least a few frames and viewing them before adding it. Keep examples under ~100 lines and dependency-free.
