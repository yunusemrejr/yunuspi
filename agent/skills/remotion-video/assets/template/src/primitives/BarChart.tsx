import React from "react";
import { groupItem } from "../motion";
import { useTheme } from "../theme";

/** Bars grow from a shared baseline in order (pass linear `sweep` progress); values label the bar tips.
 * Keep categories under ~8 and state the unit in the title, not per bar. */
export const BarChart: React.FC<{ data: Array<{ label: string; value: number }>; width: number; height: number; grow: number; max?: number; format?: (v: number) => string; highlight?: string }> = ({ data, width, height, grow, max, format = (v) => v.toLocaleString("en-US"), highlight }) => {
  const theme = useTheme();
  const top = max ?? Math.max(...data.map((d) => d.value));
  const band = width / data.length, bar = band * 0.62, base = height - 56;
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <line x1={0} x2={width} y1={base} y2={base} stroke={theme.muted} strokeOpacity={0.5} strokeWidth={2} />
      {data.map((d, i) => {
        const t = groupItem(grow, i, data.length);
        const h = (d.value / top) * (base - 60) * t;
        const x = i * band + (band - bar) / 2;
        const hot = highlight === d.label;
        return (
          <g key={d.label}>
            <rect x={x} y={base - h} width={bar} height={h} rx={10} fill={hot ? theme.accent2 : theme.accent} opacity={highlight && !hot ? 0.45 : 0.95} />
            <text x={x + bar / 2} y={base - h - 16} textAnchor="middle" fontFamily={theme.mono} fontSize={28} fill={theme.ink} opacity={t}>{format(d.value * t)}</text>
            <text x={x + bar / 2} y={base + 42} textAnchor="middle" fontFamily={theme.text} fontSize={28} fill={theme.muted}>{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
};
