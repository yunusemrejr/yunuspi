import React from "react";
import { groupItem } from "../motion";
import { useTheme } from "../theme";

export type GraphNode = { id: string; label: string; x: number; y: number };
export type GraphEdge = { from: string; to: string; weight?: number };
/** Weighted relation graph. Edges draw in along their direction (`draw`, linear `sweep` progress);
 * weight controls thickness and opacity so importance is visible, not labeled. */
export const Graph: React.FC<{ nodes: GraphNode[]; edges: GraphEdge[]; draw: number; appear: number; width: number; height: number; focus?: string }> = ({ nodes, edges, draw, appear, width, height, focus }) => {
  const theme = useTheme();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={theme.accent} />
        </marker>
      </defs>
      {edges.map((edge, i) => {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        if (!a || !b) throw new Error(`Graph edge ${edge.from}->${edge.to} references a missing node`);
        const weight = edge.weight ?? 0.5;
        const t = groupItem(draw, i, edges.length, 1.2);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const dim = focus && edge.from !== focus && edge.to !== focus ? 0.25 : 1;
        return <path key={i} d={`M${a.x},${a.y} L${b.x},${b.y}`} stroke={theme.accent} strokeWidth={2 + weight * 8} strokeOpacity={(0.25 + weight * 0.7) * dim}
          fill="none" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - t)} markerEnd={t > 0.98 ? "url(#arrow)" : undefined} />;
      })}
      {nodes.map((node, i) => {
        const p = groupItem(appear, i, nodes.length);
        const isFocus = focus === node.id;
        return (
          <g key={node.id} transform={`translate(${node.x} ${node.y}) scale(${0.7 + 0.3 * p})`} opacity={p}>
            <rect x={-110} y={-40} width={220} height={80} rx={40} fill={theme.surface} stroke={isFocus ? theme.accent2 : theme.accent} strokeWidth={isFocus ? 4 : 2} />
            <text textAnchor="middle" y={11} fontSize={32} fontFamily={theme.text} fontWeight={600} fill={theme.ink}>{node.label}</text>
          </g>
        );
      })}
    </svg>
  );
};
