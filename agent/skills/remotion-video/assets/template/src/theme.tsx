import React, { createContext, useContext } from "react";
import { useVideoConfig } from "remotion";
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
/** Layout units: the canvas's short side is always 1080, so every pixel size
 * here reads the same at 720p, 1080p, 4K or vertical 1080x1920. Canvas scales
 * the laid-out frame to the output; lay out with useCanvas(), never with
 * useVideoConfig().width/height. */
export function useCanvas() {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  return { width: Math.round(width / unit), height: Math.round(height / unit), unit };
}
export const Canvas: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { width, height, unit } = useCanvas();
  return <div style={{ position: "absolute", left: 0, top: 0, width, height, transform: `scale(${unit})`, transformOrigin: "0 0" }}>{children}</div>;
};
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
/** Relative luminance 0..1 of a #rrggbb color. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [16, 8, 0].map((s) => { const v = ((n >> s) & 255) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** Readable text colour on a filled background. */
export const onColor = (bg: string): string => (luminance(bg) > 0.35 ? "#111111" : "#FFFFFF");
/** Light grounds need dark overlays and no black vignette; dark grounds the reverse. */
export const useTone = (): "light" | "dark" => (luminance(useTheme().background) > 0.4 ? "light" : "dark");
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const c = [16, 8, 0].map((s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * Math.min(1, Math.max(0, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
