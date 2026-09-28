import React from "react";
import { useCurrentFrame } from "remotion";
import { ease, progress } from "../motion";
import { type, useTheme } from "../theme";

/** Kicker + display title + subtitle. Each title line rises out of a mask so
 * the eye reads it in order. The kicker is a chapter marker with a job (where
 * we are in the argument), set in the text face, never a mono eyebrow. Keep
 * titles under ~8 words; wrap the emphasised word in *asterisks* to colour it. */
export const Heading: React.FC<{ kicker?: string; title: string; subtitle?: string; at?: number; subtitleAt?: number; align?: "left" | "center"; size?: number }> = ({ kicker, title, subtitle, at = 0, subtitleAt, align = "left", size = type.display }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const lines = title.split("\n");
  const kick = progress(frame, at, 16);
  const rule = progress(frame, at, 22, ease.inOut);
  const emphasise = (line: string) => line.split(/(\*[^*]+\*)/).filter(Boolean).map((part, i) => part.startsWith("*") ? <span key={i} style={{ color: theme.accent }}>{part.slice(1, -1)}</span> : <React.Fragment key={i}>{part}</React.Fragment>);
  return (
    <div style={{ textAlign: align }}>
      {kicker ? (
        <div style={{ display: "flex", alignItems: "center", gap: 20, justifyContent: align === "center" ? "center" : "flex-start", fontFamily: theme.text, fontWeight: 700, fontSize: type.label + 2, color: theme.accent, opacity: kick, marginBottom: 28 }}>
          <span style={{ display: "block", width: 56 * rule, height: 5, borderRadius: 3, background: theme.accent }} />
          {kicker}
        </div>
      ) : null}
      {lines.map((line, i) => {
        const p = progress(frame, at + 6 + i * 6, 26);
        return (
          <div key={i} style={{ overflow: "hidden", paddingBottom: size * 0.08 }}>
            <div style={{ fontFamily: theme.display, fontWeight: theme.displayWeight ?? 700, fontSize: size, lineHeight: 1.04, letterSpacing: `${theme.displayTracking ?? -0.02}em`, textWrap: "balance", transform: `translateY(${(1 - p) * 105}%)` }}>{emphasise(line)}</div>
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
