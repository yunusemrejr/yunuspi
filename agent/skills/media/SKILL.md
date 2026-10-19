---
name: media
description: "Audio, video and code-to-video: probing, frames, loudness, mixing, scores, narration and the video_project pipeline for narrated explainers and edits of existing footage."
---

# Media — audio, video, code-to-video

- Tools: `media_info` (probe), `video_frames` (frames, contact sheets), `audio_analyze` (LUFS, peaks), `audio_mix`, `music_compose`, `narration_tts`, and `video_project`/`video_render` for timeline films; `video_qa` checks the master. Plain `bash` + ffmpeg always works.
- Probe first (streams, duration, loudness), work on copies, keep originals, use fresh output folders.
- Measure (LUFS, true peak, scene cuts) and inspect frames before judging quality.
- Code-to-video: derive the look from the subject, sync captions to narration, audit frames/cuts before delivery.
- Hosted generation (e.g. ElevenLabs voices) only when configured; never upload silently.
