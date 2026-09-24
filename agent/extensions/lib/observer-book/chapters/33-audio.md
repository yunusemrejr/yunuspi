---
id: audio
part: media
title: Audio and sound design
summary: Sound that serves: loudness standards, gain staging and headroom, mixing voice with music, frequency balance, sample rates and formats, music theory for beds, and procedural sound effects.
terms: audio sound music mix mixing master mastering loudness lufs peak true peak dbfs gain headroom compression eq equalizer frequency bass voice speech podcast sample rate 48khz 44.1khz wav mp3 aac chord progression key tempo bpm synth sfx reverb noise
files: .wav .mp3 .aac .flac .ogg .m4a
tools: audio_synth audio_analyze audio_mix music_compose narration_tts media_info
skills: procedural-audio audio-processing sound-analysis music-composition
---

# Audio and sound design

Audio is judged emotionally and technically at once: it must feel right and measure right. Most audio problems come from a few technical mistakes—wrong levels, clipping, muddy frequencies, masking of the voice—and a few craft ones, such as music that fights the message.

## Mix to a loudness target, keep true-peak headroom {#loudness}
<!-- terms: loudness lufs integrated true peak dbtp normalize target -14 -16 -23 ebu r128 streaming broadcast -->

**Principle.** Measure integrated loudness in LUFS and mix to the destination's target (about -14 to -16 LUFS for online video and streaming, -23 for broadcast), with true peaks below about -1 dBTP.

**Why.** Platforms normalize loudness; a mix far louder than the target is turned down with its dynamics squashed, and one far quieter sounds weak. Peak normalization is not loudness normalization: two files with the same peak can differ greatly in perceived loudness. True-peak headroom prevents distortion when files are transcoded to lossy formats.

**Signals.** Levels set by ear only; clipping or peaks at 0 dBFS; loudness varying widely between scenes or episodes.

**Ask.** What is the integrated loudness and true peak of this mix, and do they meet the destination's target?

**Traps.** Over-compressing to hit loudness targets, removing all dynamics.

## Voice first: duck the music {#voice-clarity}
<!-- terms: voice speech narration dialogue intelligibility ducking sidechain music bed masking level balance -->

**Principle.** Keep speech clearly intelligible: lower music under narration (ducking), and carve space in the frequencies where voice lives.

**Why.** Music and voice compete in the midrange (roughly 1–4 kHz), where intelligibility lives. A bed at constant level either drowns the narration or disappears between lines. Ducking the music by several decibels under speech, and slightly cutting music in the vocal band, keeps words clear while preserving energy between phrases.

**Signals.** Narration hard to understand over music; music level constant throughout; viewers needing captions to follow speech.

**Ask.** Is every narrated word intelligible over the music, including on phone speakers?

**Traps.** Ducking so deep that transitions pump audibly.

## Balance frequencies, clean the low end {#frequency}
<!-- terms: eq equalization high pass low end rumble mud boxy harsh sibilance frequency spectrum bass -->

**Principle.** Remove unnecessary low frequencies from voice and effects, avoid buildup in the low-mids, and tame harshness—cut before boosting.

**Why.** Rumble below about 80 Hz in voice recordings wastes headroom and muddies the mix. Many layered sounds accumulate energy around 200–500 Hz, making mixes boxy. Harsh upper mids tire listeners; sibilance hurts on earbuds. Subtractive EQ fixes problems without adding noise, and checking on small speakers reveals what most listeners hear.

**Signals.** Boomy or muddy mixes; harsh "s" sounds; mixes checked only on good headphones.

**Ask.** Does the mix sound clear on laptop and phone speakers, not just studio headphones?

**Traps.** Excessive EQ making voices sound thin or unnatural.

## Formats and sample rates are part of the pipeline {#formats}
<!-- terms: sample rate 48khz 44.1khz bit depth wav mp3 aac opus lossless lossy mono stereo resample -->

**Principle.** Work in lossless formats at the destination's sample rate (48 kHz for video), and encode lossy formats only once, at the end.

**Why.** Repeated lossy encoding stacks artifacts; mismatched sample rates cause resampling artifacts or drift between audio and video. 48 kHz is the video standard, 44.1 kHz the music standard. Mono narration is often best; stereo music gives width. Keeping masters lossless preserves quality for future edits.

**Signals.** MP3 files used as intermediate masters; 44.1 kHz audio in 48 kHz video timelines; audio drifting out of sync over long videos.

**Ask.** Is this pipeline lossless until the final encode, at the right sample rate?

**Traps.** Unnecessarily high sample rates bloating files.

## Music theory makes beds feel right {#music}
<!-- terms: key mode major minor dorian chord progression tempo bpm rhythm tension resolution emotion bed score -->

**Principle.** Choose key, mode, tempo and harmonic movement for the emotion the scene needs: major and faster for optimism, minor and slower for gravity, rising intensity for builds, resolution at conclusions.

**Why.** Background music steers emotion powerfully. Modes carry character (major bright, minor serious, Dorian hopeful-melancholic); tempo sets energy; progressions create tension and release. Music whose intensity follows the story—sparse at explanations, fuller at reveals, resolving at the end—makes a video feel crafted. Seeded procedural generation makes this reproducible.

**Signals.** One loop at constant intensity under a whole video; music mood contradicting the content; abrupt music endings.

**Ask.** Does the music's intensity follow the story's arc, and does it resolve at the end?

**Traps.** Busy melodies competing with narration.

## Sound effects punctuate motion {#sfx}
<!-- terms: sound effects sfx whoosh riser impact tick chime transition sync punctuate foley -->

**Principle.** Use a small, consistent palette of sound effects—whooshes for transitions, risers into reveals, impacts on arrivals, ticks for counters—synchronized to the frame.

**Why.** Sound effects give motion physical weight and help viewers notice changes. Out-of-sync effects feel wrong even when viewers cannot say why; frame-accurate placement matters. A consistent palette reads as design; random sounds read as noise. Effects must sit below narration in the mix.

**Signals.** Silent transitions in energetic videos; effects slightly early or late; many different effect styles.

**Ask.** Are sound effects synchronized to their visual events and consistent in style?

**Traps.** Effects on every motion, fatiguing the viewer.
