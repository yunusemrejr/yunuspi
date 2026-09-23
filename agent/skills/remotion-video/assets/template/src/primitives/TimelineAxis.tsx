import React from "react";
import { interpolate } from "remotion";
import { useTheme } from "../theme";

/** Horizontal history axis. The axis draws first, then events land in order;
 * `pan` (0..1) slides a long axis through the frame like a camera move. */
export const TimelineAxis: React.FC<{ events: Array<{ year: string; label: string }>; width: number; reveal: number; spacing?: number; pan?: number; focus?: number }> = ({ events, width, reveal, spacing = 420, pan = 0, focus }) => {
  const theme = useTheme();
  const length = spacing * (events.length - 1);
  const shift = -Math.max(0, length - width + 200) * pan;
  const axis = interpolate(reveal, [0, 0.35], [0, 1], { extrapolateRight: "clamp" });
  return (
    <svg width={width} height={360} style={{ overflow: "visible" }}>
      <g transform={`translate(${100 + shift} 180)`}>
        <line x1={-60} x2={-60 + (length + 120) * axis} y1={0} y2={0} stroke={theme.muted} strokeWidth={3} strokeOpacity={0.6} />
        {events.map((event, i) => {
          const t = interpolate(reveal, [0.3 + (i / events.length) * 0.65, 0.3 + ((i + 1) / events.length) * 0.65], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const up = i % 2 === 0;
          const hot = focus === i;
          return (
            <g key={i} transform={`translate(${i * spacing} 0)`} opacity={t}>
              <circle r={hot ? 16 : 11} fill={hot ? theme.accent2 : theme.accent} />
              <line y1={0} y2={up ? -58 * t : 58 * t} stroke={theme.accent} strokeOpacity={0.5} strokeWidth={2} />
              <text y={up ? -120 : 120} textAnchor="middle" fontFamily={theme.mono} fontSize={30} fill={hot ? theme.accent2 : theme.accent}>{event.year}</text>
              <text y={up ? -76 : 164} textAnchor="middle" fontFamily={theme.text} fontSize={32} fontWeight={600} fill={theme.ink}>{event.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
};
