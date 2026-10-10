---
name: video-editing
description: "Edit, probe, transcode, remux, subtitle and deliver video with FFmpeg/ffprobe, analyze footage through sampled frames, scene candidates and shot logs, and build timed motion graphics (title sequences, kinetic type, lower thirds, audio-reactive visuals) with the deterministic render.mjs frame exporter."
---

# Video editing and motion graphics

## FFmpeg editing and delivery
- Probe every source first: streams, codecs, duration, frame rate, time base, size, rotation, color metadata, audio layout (`media_info` or `ffprobe -v error -show_streams -show_format -of json`).
- Preserve sources; write distinct outputs and keep the command or filter plan. Map streams explicitly and report what was dropped (subtitles, chapters, alternate tracks).
- Stream copy only when codecs and operation allow it; cuts then snap to keyframes. Scaling, grading and burned-in subtitles re-encode. Avoid repeated lossy generations; keep a master.
- Exact filtered trims: `trim` + `setpts=PTS-STARTPTS`, `atrim` + `asetpts=PTS-STARTPTS`. Normalize size, SAR, frame rate and audio format before concat.
- Keep rational frame rates; do not force variable-frame-rate sources to constant rate without a reason.
- Crossfades overlap clips: subtract the overlap from total duration. `amix` sums signals, `amerge` joins channels. Avoid `-shortest` unless discarding the tail is intended.
- SDR delivery trial: H.264/AAC/yuv420p with `-movflags +faststart`. CRF is not comparable across encoders; test a short hard segment (motion, dark gradients, small text, lip sync) first. Size budget: total bitrate ≈ 8 × bytes ÷ seconds, minus audio and overhead.
- Verify by decoding (`ffmpeg -v error -i OUT -f null -`), probing streams, duration, size and color, then playback. A clean mux proves nothing about content.

## Analyzing footage
- Probe, then sample coarsely with `video_frames {path, count:6}`; refine with explicit `times`. Open each PNG (up to 12 per call) with a vision-capable tool such as `image_understand`; a frame the model did not see is not visual evidence.
- Cut candidates: `media_info {action:"scenes", start, duration, threshold}`. The threshold is a percentage score, not a probability. Inspect both sides (flashes and camera moves trigger it) and sample around slow dissolves it can miss.
- Use ffprobe `start_time` for nonzero container timestamps. Never convert variable-frame-rate time with `frame = time × fps`; use decoded presentation timestamps.
- Keep a shot log: start/end estimates, sampled timestamps, visible action, audio evidence, confidence. Absence from sampled frames is not proof of absence.
- Label observation, audible or transcribed evidence, and inference separately. Transcribe only with an available tool; do not install large models or upload private recordings without authorization.

## Motion graphics
- Fix message, aspect ratio, duration, frame rate and format; turn the story into beats with readable holds; map music and narration cues to seconds before animating.
- Each frame is a pure function of absolute time: seed randomness, wait for fonts and assets, avoid accumulated deltas, and pause autonomous CSS/WAAPI/video animation.
- Start from `assets/timeline-starter.html` (exposes `window.renderFrame(seconds)` and a beat sequence). Keep its render function; it is a starting point, not a finished style.
- Render: `node ~/.pi/agent/skills/video-editing/scripts/render.mjs IN.html OUT_PARENT SECONDS FPS WIDTH HEIGHT`, which creates a new folder in OUT_PARENT. Options: `--alpha` (RGBA PNGs plus VP9 `motion.webm`; MP4 drops alpha), `--audio=FILE`, `--props=FILE.json`, `--from=S --to=S`, `--dpr=1..3`. Caps: 60 s, 60 fps, 1920 px. Needs Playwright Chromium and FFmpeg with libx264; remote requests are blocked. Run long renders with `bg_run`. Frames = round(duration × fps); frame i renders at i/fps, with no endpoint frame.
- Before a full encode, inspect selected frames for clipping, composition and transition continuity. Then review playback, first and last frames, loop seam, duration and audio sync.
- Drive audio-reactive amplitude from a smoothed, normalized RMS or band envelope computed from absolute time. Beat grids are estimates until checked against the music.
- For effects beyond the starter, use `motion_examples`, then the motion-approaches skill. Embed pages in Remotion with `HtmlScene`. Keep reduced-motion behavior and playback controls in interactive embeds.
