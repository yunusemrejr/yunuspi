import React from "react";
import { mix, type, useTheme } from "../theme";

/** Stepped progress bar: a filling track with labelled step dots. Pass the
 * overall `progress` (0..1) plus step labels; the active step is derived, so
 * narration and motion can never disagree about where the story is. */
export const ProgressBar: React.FC<{ progress: number; steps: string[] }> = ({ progress, steps }) => {
  const theme = useTheme();
  const p = Math.min(1, Math.max(0, progress));
  const count = Math.max(1, steps.length);
  const activeFloat = p * count;
  return (
    <div>
      <div style={{ height: 10, borderRadius: 5, background: mix(theme.surface, theme.ink, 0.14), overflow: "hidden" }}>
        <div style={{ width: `${p * 100}%`, height: "100%", borderRadius: 5, background: theme.accent }} />
      </div>
      <div style={{ display: "flex", marginTop: 18 }}>
        {steps.map((label, i) => {
          const done = activeFloat >= i + 1, active = !done && activeFloat > i;
          return (
            <div key={i} style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, opacity: done || active ? 1 : 0.45 }}>
              <div style={{ width: 20, height: 20, borderRadius: 10, background: done ? theme.accent : active ? mix(theme.accent, theme.background, 0.45) : mix(theme.surface, theme.ink, 0.2), border: `3px solid ${done || active ? theme.accent : "transparent"}` }} />
              <span style={{ fontFamily: theme.text, fontSize: type.label, color: done || active ? theme.ink : theme.muted }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
