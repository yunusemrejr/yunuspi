# Sampling and evidence

- Probe once before decoding. `video_frames {path:"clip.mp4", count:6}` samples interval midpoints. Refine with `{path:"clip.mp4", times:[2.0,2.1,2.2]}`. Read the returned images, not just filenames.
- `media_info {action:"scenes",path:"clip.mp4",start:0,duration:60,threshold:10}` returns approximate candidates from a small proxy. Threshold is a percentage score, not a probability. Sample before and after candidates; slow dissolves may be missed.
- The tools report seconds relative to source presentation start. For nonzero or negative container timestamps, retain ffprobe start_time. Do not convert variable-frame-rate timestamps with `frame = time * nominal_fps`; use decoded presentation timestamps for exact work.
- Build a shot log with start/end estimates, actual sampled timestamps, visible action, audio evidence and confidence. A person leaving the sampled frame is not proof they left the scene.
- Compare equivalent crop, orientation and time in two sources. Align audio/video before comparing changes; resizing and color conversion alter pixel metrics. Metadata, pixels and semantic judgments are different evidence.
- Audio analysis measures signals, not words. If speech is required, use an actually available transcription tool/model, retain language and timestamps, and check uncertain names against audio. Do not install large model weights or upload private recordings without task authorization.
- More samples reduce gaps but do not prove complete coverage. For fast actions, lip sync or motion smoothness, inspect a short continuous segment. State when only still frames were available.

References: [ffprobe documentation](https://ffmpeg.org/ffprobe.html), [FFmpeg scdet](https://ffmpeg.org/ffmpeg-filters.html#scdet).
