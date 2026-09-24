import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { settle } from "../motion";
import { type, useTheme } from "../theme";

/** Kinetic typography: words land one after another with a physical settle;
 * highlighted words take the accent color. For short statements (≤ 12
 * words) that the narration says at the same time. */
export const KineticText: React.FC<{ text: string; at?: number; stagger?: number; highlight?: string[]; size?: number; font?: "display" | "text"; align?: "left" | "center"; maxWidth?: number }> = ({ text, at = 0, stagger = 4, highlight = [], size = type.title, font = "display", align = "center", maxWidth = 1500 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const marks = new Set(highlight.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: align === "center" ? "center" : "flex-start", gap: `0 ${Math.round(size * 0.28)}px`, maxWidth, margin: align === "center" ? "0 auto" : 0 }}>
      {words.map((word, i) => {
        const s = settle(frame, fps, at + i * stagger, 16);
        const marked = marks.has(word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
        return (
          <span key={i} style={{ display: "inline-block", fontFamily: font === "display" ? theme.display : theme.text, fontWeight: 700, fontSize: size, lineHeight: 1.1, letterSpacing: "-0.02em",
            color: marked ? theme.accent : theme.ink, opacity: Math.min(1, s * 1.4), transform: `translateY(${(1 - s) * size * 0.45}px) scale(${0.94 + 0.06 * s})` }}>{word}</span>
        );
      })}
    </div>
  );
};
