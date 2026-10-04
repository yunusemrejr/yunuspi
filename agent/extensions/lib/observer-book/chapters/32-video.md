---
id: video
part: media
title: Motion graphics and video production
summary: Making videos from code: storyboard first, one idea per scene, visual metaphors over text slides, narration pacing and sync, kinetic typography, sound design, rendering and encoding, and reviewing actual frames.
terms: video videos motion graphics explainer documentary remotion render rendering scene scenes storyboard narration voiceover voice speech tts subtitle captions timeline keyframe composition ffmpeg mp4 h264 frame frames fps kinetic typography transition cut music sound effects sfx trailer promo animation blender shader webgl html css svg 3d product hero look palette
files: video.json .mp4 .mov .webm remotion.config.ts
tools: video_project video_render video_shot motion_examples video_qa narration_tts audio_synth video_frames media_info media_edit video_compose scene_create scene_render
skills: code-first-video remotion-video motion-graphics-production motion-approaches procedural-audio terminal-video-editing video-analysis storytelling
---

# Motion graphics and video production

A video is a sequence of claims on the viewer's attention, each lasting a few seconds. Code-first video makes every frame reproducible, but the craft is the same as in any studio: a clear story, one idea per scene, visuals that explain rather than decorate, sound that carries emotion, and ruthless review of the actual rendered frames.

## Storyboard before rendering anything {#storyboard}
<!-- terms: storyboard script outline plan scenes beats structure story arc hook -->

**Principle.** Write the script and a scene-by-scene storyboard—what is seen, what is heard, how long—before building scenes.

**Why.** Building scenes before the story is settled wastes the most expensive work (animation) on content that gets cut. A storyboard exposes pacing problems, missing transitions and scenes without a clear purpose while changes are still cheap. It also aligns narration and visuals: each line of voiceover should have a planned visual beat.

**Signals.** Scene components written before a script exists; scenes without a stated purpose; narration written after visuals.

**Ask.** Is there a storyboard mapping every line of narration to what is on screen and for how long?

**Traps.** Storyboards so detailed they prevent discovering better visuals during production.

## One idea per scene, shown not told {#one-idea}
<!-- terms: scene idea visual metaphor show dont tell text slide bullet points diagram explain concept -->

**Principle.** Each scene communicates one idea through a visual metaphor or diagram in motion; on-screen text supports, never replaces, the visuals.

**Why.** Viewers cannot pause to read slides; text-heavy scenes compete with narration for the same verbal channel and lose. Visual explanations use the other channel: a network that grows, tokens flowing through a pipeline, a chart that builds. Dual coding (hearing words while seeing a related image) is how explainers become memorable. A scene with two ideas usually needs to become two scenes.

**Signals.** Scenes that are bullet lists; narration repeated verbatim as on-screen text; scenes explaining several concepts at once.

**Ask.** What single idea does this scene show, and what visual carries it without text?

**Traps.** Abstract visuals disconnected from the narration's meaning.

## Pace narration for comprehension {#narration}
<!-- terms: narration voiceover pace pacing words per minute syllables speed pause breath sync cue timing tts -->

**Principle.** Narrate at a comfortable pace (roughly 140–170 words per minute, fewer for dense ideas), leave breathing room between thoughts, and cue visuals to the words they illustrate.

**Why.** Dense narration overwhelms; viewers need pauses to absorb each point. Syllables per second predict perceived speed better than words per minute. Visual changes should land on the relevant word—a chart appears as it is mentioned—which requires measured narration timing rather than guesses. Scenes should end with a short hold after the last word so transitions do not cut thoughts off.

**Signals.** Narration overrunning scene durations; visuals changing before or long after their words; no pauses between scenes.

**Ask.** Are visual cues aligned to measured narration timing, and is there room to breathe?

**Traps.** Slowing narration unnaturally instead of cutting words.

## Kinetic typography reinforces, it does not recite {#kinetic-type}
<!-- terms: kinetic typography text animation title lower third caption subtitle emphasis words on screen -->

**Principle.** Animate only key words and numbers on screen, timed to their spoken moment, in a consistent typographic system.

**Why.** Showing every word creates a karaoke effect that splits attention. Highlighting the key term, number or phrase at the moment it is spoken reinforces memory. Consistent type (one or two families, a clear scale, safe margins) keeps text readable at video resolution and on phones. Captions are separate: they serve accessibility and silent viewing and should be available for all speech.

**Signals.** Full sentences animated on screen while narrated; inconsistent fonts across scenes; small text unreadable on phones.

**Ask.** Which few words deserve to be on screen here, and are they readable at phone size?

**Traps.** Text placed in areas cropped by social platforms' interfaces.

## Sound is half the experience {#sound}
<!-- terms: sound music bed sfx sound effects mix ducking loudness lufs silence audio whoosh impact -->

**Principle.** Design audio deliberately: a music bed that supports the mood without competing with voice, sound effects that punctuate key visual moments, and consistent loudness.

**Why.** Viewers forgive imperfect visuals more than bad audio. Music sets emotion and pace but must duck under narration. Subtle sound effects on transitions and reveals make motion feel physical. Loudness should meet platform targets (around -14 to -16 LUFS integrated for online video) without clipping peaks. Silence can be a powerful emphasis tool.

**Signals.** Music at constant level under voice; no sound effects on major transitions; loudness far from targets or clipping.

**Ask.** Does the mix keep narration clear, and do key visual moments have matching sound?

**Traps.** Sound effects on every movement becoming noise.

## Review actual frames, not code {#review-frames}
<!-- terms: review frames stills contact sheet preview watch render qa black frames frozen sync check -->

**Principle.** Judge the video by rendered frames and full playback—contact sheets, previews, the final file—not by reading scene code.

**Why.** A successful render proves nothing about quality: text may overflow the frame, elements may overlap, scenes may be empty for seconds, audio may drift from video. Representative stills from each scene catch layout problems quickly; low-resolution previews catch timing and motion issues; a full watch of the final catches everything else. Automated QA finds technical defects (black or frozen frames, silence, loudness), never whether the video communicates.

**Signals.** Final renders produced without stills or preview review; QA checks passing treated as approval; changes made without re-rendering affected scenes.

**Ask.** Which rendered frames and previews were inspected after the last change?

**Traps.** Reviewing only the first scenes; approving based on automated checks alone.

## Encode for where it will play {#encoding}
<!-- terms: encoding codec h264 h265 av1 aac bitrate crf frame rate resolution aspect ratio vertical social platform color -->

**Principle.** Choose resolution, aspect ratio, frame rate and codec for the destination—H.264/AAC MP4 for broad compatibility, vertical formats for short-form social—and verify the file decodes.

**Why.** Platforms re-encode uploads, so sources should be high quality with standard settings. Aspect ratio must be designed from the start: a 16:9 composition cropped to 9:16 loses its content. Constant frame rates, even dimensions and yuv420p pixel format avoid playback problems. Decoding the final file end to end catches corruption before publishing.

**Signals.** Unusual codecs or pixel formats; odd dimensions; horizontal videos intended for vertical platforms.

**Ask.** Does this render's format match its destination, and has the final file been decoded end to end?

**Traps.** Excessive bitrates for web embeds.

## Pick the approach the idea needs, and merge deliberately {#motion-approach}
<!-- terms: approach html css js webgl shader svg blender 3d shot render composite overlay anchors merge hybrid library examples copy adapt -->

**Principle.** Choose the technique per idea: a vanilla HTML page for type, shapes and shader fields; a Blender shot for lit 3D; a documented merge when the two must meet. Start from a worked example rather than from memory.

**Why.** Each approach has a strength the others lack: pages give crisp type and effects cheaply, Blender gives real light, depth and camera, FFmpeg gives finish. Advanced motion written from memory tends to be the generic version of the effect; a verified example carries the details (seekable clocks, frame-pure noise, anchor projection, straight-alpha handling) that make it hold up frame by frame. Merging without a contract (shared palette, fonts, frame rate, anchors) produces layers that visibly belong to different films.

**Signals.** Everything built from the same few primitives regardless of idea; 3D faked with CSS where lighting matters, or Blender used for flat type; labels that drift off the 3D feature they name; a 3D layer lit in colours unrelated to the 2D palette; no example consulted.

**Ask.** What does this beat's idea need (type, shader field, lit object, UI on a device), which approach gives it, and what example did the scene start from?

**Traps.** Layering two heavy effects in one scene; shipping an example's placeholder colours or fonts.

## Derive the look and motion language from the subject {#derived-look}
<!-- terms: look palette font type pair default stock generic template slop swap test originality motion language material verb rhythm easing hold -->

**Principle.** Derive palette, type and motion language from the subject's material, verb and rhythm; replace every stock default with a stated decision.

**Why.** The defaults of video tools (indigo or cyan-magenta glow on dark, teal and orange, cream with terracotta, one display serif or geometric sans, fade-up stagger, slow zoom, particle fields) mark a film as templated before anyone reads it. A motion language that embodies the subject (flowing and damped for water, quantised and ruled for precision, layered and masked for archives) is memorable and coherent. One signature move per scene, held long enough to read, beats constant motion.

**Signals.** The same easing and entrance on every element; glow, halos or particle clouds as decoration; a palette that would suit any topic (the swap test passes); fonts chosen by habit; every scene animating at once.

**Ask.** Could this scene work unchanged for another topic, and what would the subject's own material and verb do instead?

**Traps.** Novelty for its own sake that costs legibility; abandoning a coherent system scene by scene.
