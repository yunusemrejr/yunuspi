// Beat-synced and looping time helpers. Pure functions of the frame with no
// imports, so scenes, tests and tooling can share them: motion.ts
// re-exports everything here. Pair with audio_synth music (same bpm) and
// place sfx accents on the same beats in video.json.
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Phase 0..1 of the current beat at `bpm`, starting at `offsetFrames`. */
export function beat(frame: number, fps: number, bpm: number, offsetFrames = 0): number {
  if (!(fps > 0) || !(bpm > 0)) return 0;
  const framesPerBeat = (fps * 60) / bpm;
  const t = (frame - offsetFrames) / framesPerBeat;
  return t < 0 ? 0 : t % 1;
}

/** Beat envelope: 1 exactly on the beat, decaying to 0 before the next one.
 * Multiply a scale, opacity or glow by `1 + amount * pulse(...)` so motion
 * lands with the music. `decay` 3 is snappy, 1.5 is lazy. */
export function pulse(frame: number, fps: number, bpm: number, offsetFrames = 0, decay = 3): number {
  return Math.exp(-beat(frame, fps, bpm, offsetFrames) * Math.max(0.1, decay));
}

/** Whole beats elapsed since `offsetFrames` (0 before the first beat). Use
 * it to step through items, alternate sides, or trigger one-shots per beat. */
export function beatCount(frame: number, fps: number, bpm: number, offsetFrames = 0): number {
  if (!(fps > 0) || !(bpm > 0)) return 0;
  return Math.max(0, Math.floor(((frame - offsetFrames) * bpm) / (fps * 60)));
}

/** Saw 0..1 over `frames`, for seamless loops (rotation, marquee, shimmer).
 * The value at frame N equals frame 0, so the loop seam is invisible. */
export function loopProgress(frame: number, frames: number): number {
  if (!(frames > 0)) return 0;
  return ((frame % frames) + frames) % frames / frames;
}

/** Triangle 0..1..0 over `frames`, for oscillation without springs
 * (breathing scale, hovering position, sweeping gradients). */
export function pingpong(frame: number, frames: number): number {
  const p = loopProgress(frame, frames);
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

/** 0..1 progress with an attack/decay envelope: fades in over `attack`,
 * holds, fades out over `release`. For lower thirds and callouts that must
 * read, hold, then clear before the cut. */
export function hold(p: number, attack = 0.15, release = 0.15): number {
  const t = clamp01(p);
  const a = Math.min(0.49, Math.max(0, attack)), r = Math.min(0.49, Math.max(0, release));
  return Math.min(t / Math.max(1e-6, a), 1, (1 - t) / Math.max(1e-6, r));
}
