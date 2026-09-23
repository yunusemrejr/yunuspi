import React, { useLayoutEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { rng } from "../theme";

/** Seeded particles that drift, then converge onto `targets` (0..1 coords)
 * as `gather` goes 0→1. Use it to show many things becoming one structure. */
export const ParticleField: React.FC<{
  count?: number; seed?: number; color: string; gather?: number;
  targets?: Array<[number, number]>; width?: number; height?: number; size?: number;
}> = ({ count = 600, seed = 11, color, gather = 0, targets, width: w, height: h, size = 2.2 }) => {
  const frame = useCurrentFrame();
  const video = useVideoConfig();
  const width = w ?? video.width, height = h ?? video.height;
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const random = rng(seed);
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const bx = random() * width, by = random() * height, phase = random() * Math.PI * 2, speed = 0.4 + random();
      const fx = bx + Math.cos(frame / 40 * speed + phase) * 30;
      const fy = by + Math.sin(frame / 50 * speed + phase) * 30;
      const target = targets?.length ? targets[i % targets.length] : undefined;
      const x = target ? fx + (target[0] * width - fx) * gather : fx;
      const y = target ? fy + (target[1] * height - fy) * gather : fy;
      ctx.globalAlpha = 0.35 + 0.65 * random();
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [frame, width, height, count, seed, color, gather, targets, size]);
  return <canvas ref={ref} width={width} height={height} style={{ position: "absolute", inset: 0 }} />;
};
