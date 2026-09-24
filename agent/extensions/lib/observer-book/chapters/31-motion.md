---
id: motion
part: media
title: Motion design principles
summary: Animation that communicates: purpose before movement, timing and easing, the classical principles applied to interfaces and motion graphics, choreography and staging, springs, performance and reduced motion.
terms: motion animation animate animated animations transition transitions easing ease ease-out ease-in cubic-bezier spring duration timing keyframes framer motion gsap css animation choreography stagger anticipation follow through squash stretch arc staging
files: .css .scss .tsx .jsx .vue .svelte
tools: render_see browser_session video_render video_frames
skills: motion motion-graphics-production animation-libraries browser-animation-engineering procedural-animation-math physical-animation-systems svg-motion-engineering
---

# Motion design principles

Motion is the language of change. It tells viewers where something came from, where it went and what caused it. The classical principles of animation—developed by Disney animators to make drawings feel alive—apply directly to interfaces and motion graphics, adjusted for speed and restraint.

## Every movement needs a job {#purpose}
<!-- terms: purpose meaning function orientation continuity feedback attention decorative gratuitous -->

**Principle.** Animate only to orient (where things came from and went), to give feedback (an action registered), to show relationships (this expands from that), or to direct attention—never merely to decorate.

**Why.** Motion is the strongest attention signal on a screen; the eye cannot ignore it. Purposeful motion reduces cognitive load by showing cause and effect. Decorative motion competes with content, slows users down and becomes irritating on the tenth viewing. The test is whether removing the animation would make the change harder to understand.

**Signals.** Elements that animate on every load; looping animations near reading content; movement without a relationship to user actions or narrative.

**Ask.** What would a viewer fail to understand if this animation were removed?

**Traps.** Removing all motion and losing continuity cues users relied on.

## Timing: fast for interfaces, paced for stories {#timing}
<!-- terms: duration timing milliseconds fast slow 200ms 300ms frames seconds pacing speed hold -->

**Principle.** Interface transitions mostly take 150–300 ms, scaling with distance and size; motion graphics need holds long enough to read and feel.

**Why.** UI motion that is too slow makes the product feel sluggish; too fast and it is invisible. Larger movements and bigger elements need slightly more time; exits can be faster than entrances. In narrative motion graphics, timing carries emotion and comprehension: important reveals need holds, text needs reading time (roughly the time to read it aloud twice), and rhythm should vary to avoid monotony.

**Signals.** Half-second transitions on frequent actions; text on screen too briefly to read; uniform timing everywhere.

**Ask.** Does each duration match the distance moved and the time viewers need to understand it?

**Traps.** Slowing motion down to make it "feel premium".

## Easing makes motion believable {#easing}
<!-- terms: easing ease-out ease-in ease-in-out linear cubic-bezier acceleration deceleration curve spring -->

**Principle.** Use ease-out for entrances and responses, ease-in for exits, ease-in-out for moves between positions, and linear only for continuous processes.

**Why.** Real objects accelerate and decelerate; linear motion looks mechanical. Ease-out (fast start, gentle stop) feels responsive because the change begins immediately—ideal for elements responding to input. Ease-in suits things leaving view. Custom cubic-bezier curves give a product a consistent motion personality. Springs model physical responsiveness and handle interruption naturally.

**Signals.** Linear transitions on UI elements; inconsistent curves across similar animations; ease-in on responses making them feel laggy.

**Ask.** Does each easing curve match whether the element is entering, leaving or moving?

**Traps.** Bouncy overshoot on serious or frequent interactions.

## Apply the classical principles, lightly {#principles}
<!-- terms: anticipation follow through overlapping action squash stretch arcs secondary action exaggeration staging slow in slow out appeal -->

**Principle.** Anticipation, follow-through, overlapping action, arcs, squash and stretch and secondary action make motion feel alive; in interfaces, use them subtly.

**Why.** Anticipation prepares the eye (a slight wind-up before a movement); follow-through and overlap make parts settle at different times, avoiding stiff unison; arcs look natural where straight lines look robotic; squash and stretch convey weight and speed. In motion graphics these can be pronounced; in UI they should be a few pixels and milliseconds, felt more than seen.

**Signals.** All elements starting and stopping in perfect unison; rigid straight-line paths in character or illustrative motion.

**Ask.** Would a touch of overlap, follow-through or an arc make this movement feel less mechanical?

**Traps.** Cartoon exaggeration in productivity software.

## Choreograph, do not animate everything at once {#choreography}
<!-- terms: choreography stagger sequence order hierarchy staging focus orchestration group entrance -->

**Principle.** Sequence related motion so the eye follows one path: stagger items slightly, lead with the most important element, and keep the rest still.

**Why.** When everything moves simultaneously, nothing is emphasized and the viewer's eye has no path. Staggering list items by 20–50 ms creates a readable cascade; leading with the primary element establishes hierarchy; holding background elements still (staging) directs attention. Total sequence duration must stay short in interfaces.

**Signals.** Page loads where every element animates at once; staggered sequences taking over a second; background motion during key reveals.

**Ask.** Where should the eye go first in this sequence, and does the choreography lead it there?

**Traps.** Long staggers that delay access to content.

## Animate cheap properties {#performance}
<!-- terms: performance transform opacity layout reflow jank 60fps compositor will-change gpu frame drop -->

**Principle.** Animate transform and opacity, which browsers can composite on the GPU; avoid animating width, height, top, left and other layout properties.

**Why.** Layout properties force reflow and repaint every frame, dropping frames on modest devices and producing jank. Transforms and opacity skip layout. When size must animate, techniques like FLIP (measure, invert with transforms, play) achieve the effect cheaply. will-change should be used sparingly because each promoted layer costs memory.

**Signals.** Transitions on height or margin; stutter on mobile; will-change on many elements.

**Ask.** Is this animation driven by transform and opacity, and does it hold 60 fps on a mid-range phone?

**Traps.** Animating filters and shadows at large sizes.

## Honor reduced motion {#reduced-motion}
<!-- terms: prefers-reduced-motion accessibility vestibular reduce motion alternative fade -->

**Principle.** Under prefers-reduced-motion, replace large movements, parallax and zooms with fades or instant changes, keeping essential feedback.

**Why.** Large or continuous motion can trigger nausea and dizziness for people with vestibular disorders. The reduced-motion preference is an explicit request. The right response is not to remove all feedback but to substitute gentle alternatives—cross-fades instead of slides, no parallax, no autoplaying movement.

**Signals.** No reduced-motion media query; parallax and scroll-driven motion without alternatives.

**Ask.** What does this experience look like with reduced motion enabled?

**Traps.** Treating reduced motion as "no feedback at all".
