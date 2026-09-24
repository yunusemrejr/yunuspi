---
id: video
part: media
title: Motion graphics and video production
summary: Making videos from code: storyboard first, one idea per scene, visual metaphors over text slides, narration pacing and sync, kinetic typography, sound design, rendering and encoding, and reviewing actual frames.
terms: video videos motion graphics explainer documentary remotion render rendering scene scenes storyboard narration voiceover voice speech tts subtitle captions timeline keyframe composition ffmpeg mp4 h264 frame frames fps kinetic typography transition cut music sound effects sfx trailer promo animation
files: video.json .mp4 .mov .webm remotion.config.ts
tools: video_project video_render video_qa narration_tts audio_synth video_frames media_info media_edit video_compose scene_create scene_render
skills: code-first-video remotion-video motion-graphics-production procedural-audio terminal-video-editing video-analysis storytelling
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
