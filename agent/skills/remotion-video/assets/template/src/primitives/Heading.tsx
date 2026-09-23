import React from "react";
import { useCurrentFrame } from "remotion";
import { progress } from "../motion";
import { type, useTheme } from "../theme";

/** Kicker + display title + subtitle. Each title line rises out of a mask so
 * the eye reads it in order. Keep titles under ~8 words. */
export const Heading: React.FC<{ kicker?: string; title: string; subtitle?: string; at?: number; subtitleAt?: number; align?: "left" | "center"; size?: number }> = ({ kicker, title, subtitle, at = 0, subtitleAt, align = "left", size = type.display }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const lines = title.split("\n");
  const kick = progress(frame, at, 16);
  return (
    <div style={{ textAlign: align }}>
      {kicker ? (
        <div style={{ fontFamily: theme.mono, fontSize: type.label, letterSpacing: "0.18em", textTransform: "uppercase", color: theme.accent, opacity: kick, marginBottom: 28 }}>
          {kicker}
        </div>
      ) : null}
      {lines.map((line, i) => {
        const p = progress(frame, at + 6 + i * 6, 26);
        return (
          <div key={i} style={{ overflow: "hidden", paddingBottom: size * 0.08 }}>
            <div style={{ fontFamily: theme.display, fontWeight: 700, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.02em", textWrap: "balance", transform: `translateY(${(1 - p) * 105}%)` }}>{line}</div>
          </div>
        );
      })}
      {subtitle ? (
        <div style={{ marginTop: 36, fontSize: type.body, color: theme.muted, maxWidth: 1100, textWrap: "balance", marginLeft: align === "center" ? "auto" : 0, marginRight: align === "center" ? "auto" : 0, opacity: progress(frame, subtitleAt ?? at + 30, 20) }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
};
