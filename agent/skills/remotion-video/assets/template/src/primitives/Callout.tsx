import React from "react";
import { hold } from "../timing";
import { type, useTheme } from "../theme";

/** Diagram annotation: a dot pinned at `from`, an elbow line to `to`, and a
 * label. Coordinates are fractions of the container (0..1). The line draws
 * on across `progress`; the label fades in once the line arrives. */
export const Callout: React.FC<{ from: [number, number]; to: [number, number]; label: string; progress: number; sub?: string }> = ({ from, to, label, progress, sub }) => {
  const theme = useTheme();
  const p = hold(progress, 0.25, 0.12);
  if (p <= 0) return null;
  const W = 1000, H = 1000;
  const x1 = from[0] * W, y1 = from[1] * H, x2 = to[0] * W, y2 = to[1] * H;
  const elbow = x2;
  const total = Math.abs(elbow - x1) + Math.abs(y2 - y1);
  const drawn = total * Math.min(1, p * 1.6);
  const seg1 = Math.min(Math.abs(elbow - x1), drawn);
  const seg2 = Math.max(0, drawn - Math.abs(elbow - x1));
  const dirX = elbow >= x1 ? 1 : -1, dirY = y2 >= y1 ? 1 : -1;
  const mx = x1 + dirX * seg1, my = y1 + dirY * seg2;
  const labelOn = Math.min(1, Math.max(0, (p - 0.55) / 0.45));
  const d = `M ${x1} ${y1} L ${mx} ${y1}${seg2 > 0 ? ` L ${mx} ${my}` : ""}`;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <path d={d} fill="none" stroke={theme.accent} strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x1} cy={y1} r={11} fill={theme.accent} vectorEffect="non-scaling-stroke" />
        <circle cx={x1} cy={y1} r={22} fill="none" stroke={theme.accent} strokeWidth={3} opacity={0.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ position: "absolute", left: `${to[0] * 100}%`, top: `${to[1] * 100}%`, transform: "translate(18px, -50%)", opacity: labelOn, background: theme.surface, border: `2px solid ${theme.accent}`, borderRadius: 10, padding: "12px 20px", maxWidth: 420 }}>
        <div style={{ fontFamily: theme.text, fontWeight: 700, fontSize: type.label, color: theme.ink, whiteSpace: "nowrap" }}>{label}</div>
        {sub ? <div style={{ fontFamily: theme.text, fontSize: type.micro, color: theme.muted, marginTop: 4 }}>{sub}</div> : null}
      </div>
    </div>
  );
};
