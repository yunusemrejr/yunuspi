---
name: audio-processing
description: "Inspect, transform and validate audio with FFmpeg or SoX: filtering, resampling, channel layouts, loudness, synchronization and output quality; use for audio signal workflows."
---

# Audio processing

Probe the original before choosing filters: streams, codec, sample rate, channel layout, duration, timestamps and existing clipping. Define the deliverable's required format and audible goal. Preserve the source and write a distinct output; a codec conversion cannot restore information already lost.

Use `media_info` for probing, `audio_analyze` for bounded measurements and spectrum images, and `media_edit` with `action:"audio"` or `action:"normalize"` for WAV extraction or measured two-pass normalization. Pass the interval explicitly: these tools default to the first thirty seconds. For long programs and custom effects, use FFmpeg through existing background execution.

Read [signal pipeline](references/signal-pipeline.md) for sample-rate conversion, filters, channel handling, clipping, PCM and SoX usage. Read [loudness and alignment](references/loudness-alignment.md) for measured normalization, synchronization, delay, drift and verification. Check installed encoder and filter support rather than assuming a particular FFmpeg build includes optional libraries.

Make stream selection and output parameters explicit. Keep a lossless intermediate when multiple operations would otherwise repeatedly encode a lossy format. Apply transformations in an intentional order, record the actual filter chain and use bounded measurements before processing a large batch. Distinguish peak normalization, perceived loudness, dynamic compression and denoising; they solve different problems.

Inspect resulting metadata, sample counts or duration, clipping and representative playback. Numeric checks do not prove intelligibility or absence of artifacts. If playback is unavailable, say which objective checks passed and leave listening quality unverified. For batches, test silence, short clips, unusual channels and an already loud input before scaling. Deliver files alongside source-to-output mapping and any changed timing, channel or loudness assumptions.
