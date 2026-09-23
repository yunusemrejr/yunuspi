import React, { createContext, useContext } from "react";
import { spec, type Theme } from "./timeline";

const ThemeContext = createContext<Theme>(spec.theme);
export const ThemeProvider: React.FC<{ theme?: Theme; children: React.ReactNode }> = ({ theme = spec.theme, children }) => (
  <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
);
export const useTheme = () => useContext(ThemeContext);

/** Type scale for a 1080p canvas. Sizes are chosen for reading at video
 * distance: body text below ~34px is illegible on phones and in previews. */
export const type = {
  display: 132, title: 88, heading: 60, body: 40, caption: 34, label: 28, micro: 22,
} as const;
/** Spacing on an 8px grid; the stage keeps a 120px title-safe margin. */
export const space = (steps: number) => steps * 8;
export const SAFE = 120;

/** Deterministic PRNG (mulberry32). Never use Math.random in a frame. */
export function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const c = [16, 8, 0].map((s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * Math.min(1, Math.max(0, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
