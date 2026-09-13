---
name: video-analysis
description: Analyze recorded video through timestamped frames, scene candidates, visual events and audio evidence. Use for footage summaries, shot logs, continuity checks or comparisons; use terminal-video-editing for transformations.
---

# Video analysis

Identify the question, source file and interval. Use `media_info` to probe streams, dimensions, rotation, color, frame rate and duration. Metadata supports technical claims; understanding the action requires inspecting decoded frames or playback.

Use `video_frames` for a coarse survey, then explicit `times` around events. Each call returns up to twelve PNG paths and a timing manifest; open the actual images with an available image/vision tool. Preserve requested and decoded timestamps. Use `media_info` with `action:"scenes"` to locate candidate cuts, then inspect both sides: flashes and camera motion can also trigger the detector. For audio evidence, use `audio_analyze` and representative listening.

Read [sampling and evidence](references/sampling.md) for variable frame rate, shot logs, comparison and speech handling. Never describe a frame as viewed if only its metadata was read. Missing vision, playback or transcription is an evidence limit, not a reason to invent events.

Deliver the requested summary or analysis with source timestamps and confidence. Distinguish visible observation, audible/transcribed evidence and inference. Exact counts and event boundaries require denser sampling or continuous review. Keep conclusions within the sampled coverage; preserve uncertainty about offscreen or intervening activity.
