import React from "react";
import { hold } from "../timing";
import { mix, type, useTheme } from "../theme";

/** Lower third: name + role caption over an accent bar. Driven by a 0..1
 * `progress` from the scene (see `hold` for read/hold/clear envelopes), so
 * timing stays in video.json cues. Keep name + title under ~6 words total. */
export const LowerThird: React.FC<{ name: string; title?: string; progress: number; accent?: string }> = ({ name, title, progress, accent }) => {
  const theme = useTheme();
  const bar = accent ?? theme.accent;
  const p = hold(progress);
  if (p <= 0) return null;
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * 40}px)` }}>
      <div style={{ display: "inline-block", background: mix(theme.background, "#000000", 0.35), borderLeft: `8px solid ${bar}`, padding: "20px 36px 24px 28px", borderRadius: "0 12px 12px 0" }}>
        <div style={{ fontFamily: theme.text, fontWeight: 700, fontSize: type.body, color: theme.ink, lineHeight: 1.15 }}>{name}</div>
        {title ? (
          <div style={{ fontFamily: theme.text, fontSize: type.label, color: theme.muted, marginTop: 6 }}>{title}</div>
        ) : null}
      </div>
    </div>
  );
};
