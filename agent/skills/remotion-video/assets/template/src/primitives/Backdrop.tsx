import React, { useLayoutEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { rng } from "../theme";

/** Quiet procedural depth: a slow dot lattice with parallax drift. Keep it
 * below ~8% contrast so it never competes with the subject. */
export const Backdrop: React.FC<{ seed?: number; tint: string; density?: number }> = ({ seed = 7, tint, density = 1 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const random = rng(seed);
    const count = Math.round(140 * density);
    for (let i = 0; i < count; i++) {
      const depth = 0.3 + random() * 0.7;
      const x = (random() * width + frame * 0.35 * depth) % width;
      const y = random() * height + Math.sin(frame / 90 + i) * 6 * depth;
      ctx.globalAlpha = 0.05 + 0.1 * depth;
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(x, y, 1.2 + depth * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [frame, width, height, seed, tint, density]);
  return <canvas ref={ref} width={width} height={height} style={{ position: "absolute", inset: 0 }} />;
};
