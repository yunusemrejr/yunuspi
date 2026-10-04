# Motion originality

Generic motion is the default of every tool: fade-up stagger on every line, a slow zoom on every shot, a glowing particle field, a spinning logo, neon on dark. Viewers read it as "made by a template". Originality here is not novelty for its own sake; it is motion that could only belong to this subject.

## Derive the motion language from the subject

Before choosing effects, answer four questions in one line each (write them into the storyboard):

1. **Material**: what is this thing made of or about? (paper, water, circuitry, metal, light, sound, time, soil, glass)
2. **Verb**: what does it do? (accumulates, splits, flows, locks, erodes, orbits, calibrates, ripples)
3. **Rhythm**: fast and percussive, slow and heavy, irregular, periodic, accelerating?
4. **Tension**: what is in conflict or being resolved? (order/chaos, small/large, before/after)

Then pick a motion language that embodies them: a water topic gets continuous, curved, damped motion (domain-warp fields, liquid SVG filters, slow Blender drift); a precision topic gets stepped, quantised, ruled motion (ticks, snap eases, wipes along grid lines); a memory/archive topic gets masks, halftone and layered paper-like moves; an energy topic gets accelerating easing and compression/release. The same question applies to transitions: the transition is part of the language.

## What reads as stock (avoid unless the subject demands it)

- Fade-up + stagger on every text block and every list; the same easing (`ease-out cubic`) everywhere.
- A slow zoom-in on every scene (the "Ken Burns" default).
- Glowing orbs, soft radial halos, particle clouds, lens flares, bokeh, scanlines as decoration.
- Indigo/violet gradient grounds, cyan-magenta neon, teal and orange as the automatic cinematic pair, cream with terracotta.
- Spinning/pulsing logos, bouncing emoji, floating icon cards in a 3-up grid, glassmorphism panels.
- Typewriter reveals on every line; counters that count for no reason; fake dashboards with invented numbers.
- HUD ornaments (corner brackets, rotating rings, data streams) with no meaning.
- Fonts on autopilot (Inter, Space Grotesk, Poppins, a display serif in italic). Use the film's derived pair (`video_project action:"look"` with `look:"derive"`) or choose from the catalogue deliberately.

If you see a default, replace it with a decision: say what motion this beat needs and why, then choose the easing, duration and holds for that reason.

## Principles that make motion look authored

- **Hierarchy of motion**: one thing moves at a time or one thing moves most; everything else supports. If everything animates, nothing does.
- **Holds**: hold finished frames long enough to read (a line of 6 words needs ~2 s after it lands). The pause is part of the design; many generic videos never stop moving.
- **Easing vocabulary**: choose two or three easings for the film and reuse them (a snappy out-expo for arrivals, a symmetrical in-out for repositioning, a spring for emphasis). Different easings per element in the same moment look accidental.
- **Anticipation, follow-through and overshoot** at small scale (a few percent), not everywhere; they add weight when used on the hero move only.
- **Timing against the narration/music**: cue the hero move to the sentence's key word or the beat; offset secondary motion by 2-4 frames so they do not land on the same frame.
- **Scale and distance**: big slow background motion, small fast foreground motion; parallax ratios consistent with a plausible camera.
- **Continuity across cuts**: carry a shape, colour, direction or sound across a cut (match cut, matched wipe direction) so scenes feel authored as a sequence.
- **Constraints**: pick a grid and a type scale and keep to them; a narrow palette (3-4 colours with one accent used for one meaning) beats a rainbow.

## Colour and type for motion

- Derive the palette from the subject (OKLCH, one dominant ground, one text colour with proper contrast, one accent that means something). Dark grounds are the common default; consider a light ground when the subject is paper, daylight, print or clarity, and tinted darks (deep green, oxblood, ink blue, aubergine) rather than neutral black.
- Test contrast at video sizes (body text 40 px+ at 1080p; captions inside safe areas).
- Typography carries personality more than any effect: choose a display face and a text face with real contrast (width, weight, or style), set big, tight, intentional lines, and animate by words or lines with meaning.
- Avoid pairing the "default" accent hues (indigo 255-290 degrees; cyan-magenta; the orange-teal pair) unless the subject is that colour.

## A quick review before rendering

1. Could the swap test pass? Replace the topic with another and the scene still works unchanged = generic; redesign it.
2. Is there one hero move per scene, and can you name it?
3. Does every effect have a reason you could say aloud?
4. Are there any defaults from the stock list above? Replace each with a decision.
5. Does the motion language match the material/verb/rhythm/tension answers?

The harness backs this with `video_project` design lint (monotony, metronome pacing, defaults) and source lint (non-deterministic code, glow halos, violet gradients, accent rails, hard-coded fonts, off-palette colours, emoji icons); fix every warning or justify it.
