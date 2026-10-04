import React, { useLayoutEffect, useRef } from "react";
import { useCurrentFrame } from "remotion";
import { rng, useCanvas, useTheme } from "../theme";

/** Quiet procedural ground that belongs to the look: "lattice" drifting dots,
 * "rules" ruled verticals, "halftone" a dot screen swelling around slow
 * centres, "contour" flowing iso-lines, "ticks" a drifting measuring scale,
 * "flow" slow curl-noise ribbons, "none" a clean field. Every kind
 * stays below ~8% contrast so it never competes with the subject, and every
 * value is a pure function of the frame. */
export const Backdrop: React.FC<{ seed?: number; tint?: string; density?: number; kind?: "lattice" | "rules" | "halftone" | "contour" | "ticks" | "flow" | "none" }> = ({ seed = 7, tint, density = 1, kind }) => {
  const frame = useCurrentFrame();
  const { width, height } = useCanvas();
  const theme = useTheme();
  const family = kind ?? theme.backdrop ?? "lattice";
  const color = tint ?? (family === "lattice" ? theme.accent : theme.ink);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const random = rng(seed);
    if (family === "lattice") {
      const count = Math.round(140 * density);
      for (let i = 0; i < count; i++) {
        const depth = 0.3 + random() * 0.7;
        const x = (random() * width + frame * 0.35 * depth) % width;
        const y = random() * height + Math.sin(frame / 90 + i) * 6 * depth;
        ctx.globalAlpha = 0.05 + 0.1 * depth;
        ctx.beginPath();
        ctx.arc(x, y, 1.2 + depth * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (family === "rules") {
      const gap = 120 / Math.max(0.5, density);
      const drift = (frame * 0.25) % gap;
      ctx.lineWidth = 1.5;
      for (let x = -gap + drift; x < width + gap; x += gap) {
        ctx.globalAlpha = 0.07;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        for (let y = (seed * 37) % 96; y < height; y += 96) { ctx.globalAlpha = 0.1; ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.stroke(); }
      }
    } else if (family === "halftone") {
      const step = 44 / Math.max(0.5, density);
      const centres = [0, 1].map((i) => ({ x: width * (0.3 + 0.4 * i + 0.12 * Math.sin(frame / 160 + seed + i * 2)), y: height * (0.35 + 0.3 * i + 0.1 * Math.cos(frame / 200 + seed + i)) }));
      ctx.globalAlpha = 0.11;
      for (let y = step / 2; y < height; y += step) for (let x = step / 2 + ((y / step) % 2) * (step / 2); x < width; x += step) {
        const d = Math.min(...centres.map((c) => Math.hypot(x - c.x, y - c.y))) / Math.hypot(width, height);
        const r = Math.max(0, step * 0.42 * (1 - d * 2.4));
        if (r < 0.8) continue;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    } else if (family === "ticks") {
      // a measuring scale: fine ticks every 24px with a longer one every fifth, sliding slowly, on two edges
      const gap = 24, drift = (frame * 0.4) % (gap * 5);
      ctx.lineWidth = 1.5;
      for (let i = -5; i * gap < width + gap * 5; i++) {
        const x = i * gap + drift, major = ((i % 5) + 5) % 5 === 0;
        ctx.globalAlpha = major ? 0.13 : 0.07;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, major ? 34 : 18); ctx.moveTo(x, height); ctx.lineTo(x, height - (major ? 34 : 18)); ctx.stroke();
      }
    } else if (family === "flow") {
      // slow ribbons following a smooth vector field: frame-pure, each integrated from a fixed seed point
      const count = Math.round(70 * density), step = 18, t = frame / 300;
      ctx.lineWidth = 1.6;
      for (let i = 0; i < count; i++) {
        let x = random() * width, y = random() * height;
        ctx.globalAlpha = 0.05 + 0.05 * random();
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let k = 0; k < 26; k++) {
          const angle = Math.sin(x * 0.004 + t * 1.3 + seed) * 1.9 + Math.cos(y * 0.005 - t + i * 0.01) * 1.6;
          x += Math.cos(angle) * step; y += Math.sin(angle) * step; ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (family === "contour") {
      const lines = Math.round(16 * density), phase = frame / 240;
      ctx.lineWidth = 1.6;
      for (let i = 0; i < lines; i++) {
        const base = (i + 0.5) / lines, wobble = 0.5 + random();
        ctx.globalAlpha = 0.05 + 0.05 * random();
        ctx.beginPath();
        for (let x = 0; x <= width; x += 24) {
          const nx = x / width;
          const y = height * (base + 0.05 * Math.sin(nx * 5 * wobble + phase * 2 + i * 0.7) + 0.03 * Math.sin(nx * 11 - phase * 3 + seed + i));
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }, [frame, width, height, seed, color, density, family]);
  if (family === "none") return null;
  return <canvas ref={ref} width={width} height={height} style={{ position: "absolute", inset: 0 }} />;
};
