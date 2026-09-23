import React from "react";
import { interpolate } from "remotion";
import { useTheme } from "../theme";

/** Layered network diagram. `build` (0..1) draws layers left to right;
 * `signal` (0..1) sends activation pulses through the layers; `focus`
 * optionally highlights one node per layer as a traced path. */
export const NeuralNet: React.FC<{
  layers: number[]; width: number; height: number; build: number; signal?: number;
  focus?: number[]; nodeRadius?: number; labels?: string[];
}> = ({ layers, width, height, build, signal = 0, focus, nodeRadius = 16, labels }) => {
  const theme = useTheme();
  const gapX = width / Math.max(1, layers.length - 1);
  const pos = layers.map((n, l) => Array.from({ length: n }, (_, i) => [l * gapX, height / 2 + (i - (n - 1) / 2) * Math.min(96, height / Math.max(n, 1))] as const));
  const layerShown = (l: number) => interpolate(build, [l / layers.length, (l + 1) / layers.length], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const wave = signal * (layers.length - 1);
  return (
    <svg width={width + nodeRadius * 4} height={height} viewBox={`${-nodeRadius * 2} 0 ${width + nodeRadius * 4} ${height}`} style={{ overflow: "visible" }}>
      {pos.slice(0, -1).map((column, l) => column.map(([x1, y1], i) => pos[l + 1].map(([x2, y2], j) => {
        const shown = Math.min(layerShown(l), layerShown(l + 1));
        const onPath = focus && focus[l] === i && focus[l + 1] === j;
        const hot = Math.max(0, 1 - Math.abs(wave - (l + 0.5)) * 1.6);
        return <line key={`${l}-${i}-${j}`} x1={x1} y1={y1} x2={x1 + (x2 - x1) * shown} y2={y1 + (y2 - y1) * shown}
          stroke={onPath ? theme.accent2 : theme.accent} strokeWidth={onPath ? 3.5 : 1.4} strokeOpacity={(onPath ? 0.95 : 0.14 + hot * 0.45) * shown} />;
      })))}
      {signal > 0 && signal < 1 ? pos.slice(0, -1).map((column, l) => {
        const t = wave - l;
        if (t < 0 || t > 1) return null;
        return column.map(([x1, y1], i) => pos[l + 1].filter((_, j) => (i + j) % 2 === 0).map(([x2, y2], j) => (
          <circle key={`p${l}-${i}-${j}`} cx={x1 + (x2 - x1) * t} cy={y1 + (y2 - y1) * t} r={4} fill={theme.accent} opacity={0.9} />
        )));
      }) : null}
      {pos.map((column, l) => column.map(([x, y], i) => {
        const shown = layerShown(l);
        const active = Math.max(0, 1 - Math.abs(wave - l) * 1.4);
        const onPath = focus?.[l] === i;
        return (
          <g key={`n${l}-${i}`} opacity={shown} transform={`translate(${x} ${y}) scale(${0.6 + 0.4 * shown})`}>
            <circle r={nodeRadius + active * 8} fill={theme.accent} opacity={active * 0.18} />
            <circle r={nodeRadius} fill={theme.surface} stroke={onPath ? theme.accent2 : theme.accent} strokeWidth={3} />
            <circle r={nodeRadius * 0.45 * (0.3 + active * 0.7)} fill={onPath ? theme.accent2 : theme.accent} />
          </g>
        );
      }))}
      {labels?.map((label, l) => (
        <text key={`l${l}`} x={l * gapX} y={height + 16} textAnchor="middle" fill={theme.muted} fontSize={30} fontFamily={theme.mono} opacity={layerShown(l)}>{label}</text>
      ))}
    </svg>
  );
};
