import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ease } from "../motion";
import { rng, useTheme } from "../theme";

/** Finishing effects. Each is a pure function of the frame, so previews,
 * stills and the final render show the same pixels. Use sparingly: one
 * texture per scene, and motion that explains rather than decorates. */

/** Animated film grain: SVG turbulence whose seed changes every frame. */
export const FilmGrain: React.FC<{ opacity?: number; scale?: number; seed?: number }> = ({ opacity = 0.07, scale = 0.9, seed = 3 }) => {
  const frame = useCurrentFrame();
  const id = `grain-${seed}`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width="100%" height="100%">
        <filter id={id}><feTurbulence type="fractalNoise" baseFrequency={scale} numOctaves={2} seed={(frame % 97) + seed} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Soft drifting glows, like light leaking into a lens. */
export const LightLeak: React.FC<{ color?: string; color2?: string; intensity?: number; speed?: number; seed?: number }> = ({ color, color2, intensity = 0.35, speed = 1, seed = 11 }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const random = rng(seed);
  const blobs = [0, 1, 2].map((i) => {
    const phase = random() * Math.PI * 2, radius = 30 + random() * 25;
    const x = 50 + 38 * Math.sin(frame * 0.004 * speed * (1 + i * 0.3) + phase);
    const y = 50 + 30 * Math.cos(frame * 0.003 * speed * (1 + i * 0.2) + phase * 1.3);
    return `radial-gradient(circle at ${x}% ${y}%, ${i === 1 ? color2 ?? theme.accent2 : color ?? theme.accent}cc 0%, transparent ${radius}%)`;
  });
  return <AbsoluteFill style={{ pointerEvents: "none", background: blobs.join(","), mixBlendMode: "screen", opacity: intensity, filter: "blur(40px)" }} />;
};

/** Camera motion over a scene: a slow push, pull, pan or drift that gives a
 * still composition depth. Pass the scene's durationInFrames. */
export const CameraMove: React.FC<{ move?: "push-in" | "pull-out" | "pan-left" | "pan-right" | "drift"; amount?: number; durationInFrames: number; children: React.ReactNode }> = ({ move = "push-in", amount = 1, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, Math.max(1, durationInFrames)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease.inOut });
  const k = amount;
  const transform = move === "push-in" ? `scale(${1 + 0.06 * k * t})`
    : move === "pull-out" ? `scale(${1 + 0.06 * k * (1 - t)})`
    : move === "pan-left" ? `scale(${1 + 0.05 * k}) translateX(${(0.5 - t) * 4 * k}%)`
    : move === "pan-right" ? `scale(${1 + 0.05 * k}) translateX(${(t - 0.5) * 4 * k}%)`
    : `scale(${1 + 0.03 * k}) translate(${Math.sin(t * Math.PI * 2) * 1.2 * k}%, ${Math.cos(t * Math.PI * 1.5) * 0.8 * k}%)`;
  return <AbsoluteFill style={{ transform, transformOrigin: "50% 50%" }}>{children}</AbsoluteFill>;
};

/** A brief digital glitch at frame `at` for `frames` frames: channel split,
 * slice offsets and a jitter, deterministic per frame. */
export const Glitch: React.FC<{ at: number; frames?: number; intensity?: number; children: React.ReactNode }> = ({ at, frames = 8, intensity = 1, children }) => {
  const frame = useCurrentFrame();
  const active = frame >= at && frame < at + frames;
  if (!active) return <AbsoluteFill>{children}</AbsoluteFill>;
  const random = rng(frame * 7919 + at);
  const shift = (random() - 0.5) * 24 * intensity;
  const slices = [0, 1, 2].map(() => ({ top: random() * 90, height: 2 + random() * 8, dx: (random() - 0.5) * 60 * intensity }));
  return (
    <AbsoluteFill style={{ transform: `translateX(${shift * 0.3}px)` }}>
      <AbsoluteFill style={{ mixBlendMode: "screen", filter: "hue-rotate(-40deg) saturate(3)", opacity: 0.7, transform: `translateX(${-shift}px)` }}>{children}</AbsoluteFill>
      <AbsoluteFill style={{ mixBlendMode: "screen", filter: "hue-rotate(60deg) saturate(3)", opacity: 0.7, transform: `translateX(${shift}px)` }}>{children}</AbsoluteFill>
      <AbsoluteFill>{children}</AbsoluteFill>
      {slices.map((s, i) => (
        <AbsoluteFill key={i} style={{ clipPath: `inset(${s.top}% 0 ${Math.max(0, 100 - s.top - s.height)}% 0)`, transform: `translateX(${s.dx}px)` }}>{children}</AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
};
