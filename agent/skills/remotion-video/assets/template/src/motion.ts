// Motion vocabulary. Movement should explain: enter along the direction of
// causality, emphasize with scale/color not wobble, and exit before the next
// idea claims attention. Every value is a pure function of the frame.
import { Easing, interpolate, spring } from "remotion";

export const ease = {
  linear: (t: number) => t,
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.7, 0, 0.84, 0),
};

/** 0→1 progress starting at `at` over `frames`, clamped and eased. */
export function progress(frame: number, at: number, frames: number, easing = ease.out): number {
  return interpolate(frame, [at, at + Math.max(1, frames)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });
}
/** Linear 0→1 progress for a staggered group. Primitives ease each item
 * themselves; easing the whole group would crowd the stagger at the start. */
export function sweep(frame: number, at: number, frames: number): number {
  return progress(frame, at, frames, ease.linear);
}
/** Eased progress of item `index` of `count` inside a group sweep (0..1).
 * Items overlap by `overlap` item-lengths and the last item completes
 * exactly when the sweep reaches 1. */
export function groupItem(sweepProgress: number, index: number, count: number, overlap = 1.4, easing = ease.out): number {
  const span = Math.max(1, count - 1 + overlap);
  const t = Math.min(1, Math.max(0, (sweepProgress * span - index) / overlap));
  return easing(t);
}
/** Staggered progress for item i of a group. */
export function stagger(frame: number, at: number, index: number, gap: number, frames: number): number {
  return progress(frame, at + index * gap, frames);
}
/** Physically plausible settle for emphasis moments. */
export function settle(frame: number, fps: number, at: number, damping = 18): number {
  return spring({ frame: frame - at, fps, config: { damping, stiffness: 140, mass: 0.9 } });
}
/** Standard entrance: fade + short travel. Travel is in pixels. */
export function enter(frame: number, at: number, frames = 18, travel = 24) {
  const p = progress(frame, at, frames);
  return { opacity: p, transform: `translateY(${(1 - p) * travel}px)` };
}
/** Fade a scene's content out over its final frames so cuts never snap. */
export function exitFade(frame: number, durationInFrames: number, frames = 12): number {
  return interpolate(frame, [durationInFrames - frames, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}
