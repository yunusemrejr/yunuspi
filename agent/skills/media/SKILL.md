---
name: media
description: "Audio, video and code-to-video through the single studio hub tool."
---

# Media — audio, video, code-to-video

- One hub: the `studio` tool (actions: probe, frames, analyze, mix, compose, render, blender, design). Plain `bash` + ffmpeg always overrides.
- Probe first (streams, duration, loudness), work on copies, keep originals, use fresh output folders.
- Measure (LUFS, true peak, scene cuts) and inspect frames before judging quality.
- Code-to-video: derive the look from the subject, sync captions to narration, audit frames/cuts before delivery.
- Hosted generation (e.g. ElevenLabs voices) only when configured; never upload silently.
