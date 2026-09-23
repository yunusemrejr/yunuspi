import React from "react";
import { groupItem } from "../motion";
import { mix, useTheme } from "../theme";

/** A sentence as token chips with optional attention arcs from one focus token.
 * `appear` (linear `sweep` progress) lands chips in reading order; `lift` raises the focus chip;
 * `arcs` (linear `sweep`) grows arcs in reading order; `weights` sets arc strength;
 * `scan` (linear `sweep`) passes a highlight across the tokens, e.g. a model searching. */
export const TokenRow: React.FC<{
  tokens: string[]; width: number; appear: number; focus?: number; lift?: number;
  weights?: number[]; arcs?: number; winner?: number; winnerGlow?: number; scan?: number;
}> = ({ tokens, width, appear, focus, lift = 0, weights, arcs = 0, winner, winnerGlow = 0, scan }) => {
  const theme = useTheme();
  const gap = 18;
  const charW = 25, pad = 30, height = 84;
  const widths = tokens.map((t) => t.length * charW + pad * 2);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (tokens.length - 1);
  const scale = Math.min(1, width / total);
  let x = (width / scale - total) / 2;
  const centers = widths.map((w) => { const c = x + w / 2; x += w + gap; return c; });
  // Reserve arc headroom only when arcs will be drawn.
  const headroom = weights ? 300 : 30;
  const baseY = headroom + height / 2 + 20;
  const svgHeight = baseY + height / 2 + 30;
  const order = tokens.map((_, i) => i).filter((i) => i !== focus);
  return (
    <svg width={width} height={svgHeight * scale} viewBox={`0 0 ${width / scale} ${svgHeight}`} style={{ overflow: "visible" }}>
      {focus !== undefined && weights ? order.map((i, k) => {
        const t = groupItem(arcs, k, order.length, 1.6);
        if (t <= 0) return null;
        const x1 = centers[focus], x2 = centers[i], w = weights[i] ?? 0;
        const h = 90 + Math.abs(x2 - x1) * 0.28;
        const y = baseY - height / 2 - 6 - lift * 34;
        const d = `M${x1},${y} C${x1},${y - h} ${x2},${y - h} ${x2},${baseY - height / 2 - 6}`;
        // The winner stays neutral until its beat so the reveal is not spoiled.
        const hot = winner === i && winnerGlow > 0;
        return <path key={i} d={d} fill="none" stroke={hot ? mix(theme.accent, theme.accent2, winnerGlow) : theme.accent} strokeLinecap="round"
          strokeWidth={2 + w * 14 + (hot ? winnerGlow * 4 : 0)} strokeOpacity={(0.18 + w * 0.8) * (winner !== undefined && !hot ? 1 - 0.55 * winnerGlow : 1)}
          pathLength={1} strokeDasharray={1} strokeDashoffset={1 - t} />;
      }) : null}
      {tokens.map((token, i) => {
        const p = groupItem(appear, i, tokens.length);
        const isFocus = i === focus, isWinner = i === winner;
        const scanned = scan === undefined || scan <= 0 || scan >= 1 ? 0 : Math.max(0, 1 - Math.abs(i - (scan * (tokens.length + 1) - 1)));
        const y = baseY + (1 - p) * 28 - (isFocus ? lift * 34 : 0);
        const fill = isFocus ? mix(theme.surface, theme.accent, 0.25 + 0.35 * lift) : isWinner ? mix(theme.surface, theme.accent2, 0.3 * winnerGlow) : theme.surface;
        const stroke = isFocus ? theme.accent : isWinner && winnerGlow > 0 ? theme.accent2 : scanned > 0.05 ? mix(theme.surface, theme.accent, 0.35 + 0.65 * scanned) : `${theme.muted}66`;
        return (
          <g key={i} opacity={p} transform={`translate(${centers[i] - widths[i] / 2} ${y - height / 2 - scanned * 6})`}>
            <rect width={widths[i]} height={height} rx={20} fill={fill} stroke={stroke} strokeWidth={isFocus || (isWinner && winnerGlow > 0) ? 3 : 1.5 + 1.5 * scanned} />
            <text x={widths[i] / 2} y={height / 2 + 14} textAnchor="middle" fontFamily={theme.text} fontWeight={600} fontSize={40} fill={theme.ink}>{token}</text>
          </g>
        );
      })}
    </svg>
  );
};
