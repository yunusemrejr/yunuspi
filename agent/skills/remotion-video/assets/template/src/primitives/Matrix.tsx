import React from "react";
import { groupItem } from "../motion";
import { mix, useTheme } from "../theme";

/** Heat-mapped matrix (values 0..1). `reveal` (0..1) fills cells in reading
 * order (pass linear `sweep` progress); `highlightRow` draws attention to one row, e.g. one query's weights.
 * `normalize` rescales by the global or per-row maximum and a gamma lifts
 * small values, so a heat map never collapses into near-background cells.
 * `pulse` (0..1) brightens every cell at once, e.g. to show parallel computation. */
export const Matrix: React.FC<{
  values: number[][]; cell?: number; reveal: number; rowLabels?: string[]; colLabels?: string[];
  highlightRow?: number; highlight?: number; showValues?: boolean; normalize?: "global" | "row" | "none"; gamma?: number; pulse?: number;
}> = ({ values, cell = 72, reveal, rowLabels, colLabels, highlightRow, highlight = 0, showValues = false, normalize = "global", gamma = 0.6, pulse = 0 }) => {
  const theme = useTheme();
  const rows = values.length, cols = values[0]?.length ?? 0, total = rows * cols;
  const globalMax = Math.max(1e-9, ...values.flat());
  const flash = Math.sin(Math.PI * Math.min(1, Math.max(0, pulse))) * 0.45;
  const level = (value: number, row: number[]) => {
    const max = normalize === "row" ? Math.max(1e-9, ...row) : normalize === "global" ? globalMax : 1;
    return Math.pow(Math.min(1, Math.max(0, value / max)), gamma);
  };
  const pad = rowLabels ? Math.max(150, cell * 1.9) : 0, top = colLabels ? Math.max(64, cell * 0.8) : 0;
  return (
    <svg width={pad + cols * cell} height={top + rows * cell} style={{ overflow: "visible" }}>
      {colLabels?.map((label, c) => {
        // Labels wider than a cell are angled instead of colliding.
        const size = Math.max(26, cell * 0.3), angled = Math.max(...colLabels.map((l) => l.length)) * size * 0.62 > cell - 8;
        const x = pad + c * cell + cell / 2, y = top - 16;
        return <text key={`c${c}`} x={x} y={y} textAnchor={angled ? "start" : "middle"} transform={angled ? `rotate(-40 ${x} ${y})` : undefined} fontFamily={theme.mono} fontSize={size} fill={theme.muted}>{label}</text>;
      })}
      {values.map((row, r) => (
        <g key={r}>
          {rowLabels ? <text x={pad - 20} y={top + r * cell + cell / 2 + 9} textAnchor="end" fontFamily={theme.mono} fontSize={Math.max(26, cell * 0.3)} fill={highlightRow === r ? theme.ink : theme.muted}>{rowLabels[r]}</text> : null}
          {row.map((value, c) => {
            const order = r * cols + c;
            const shown = groupItem(reveal, order, total, 1.5);
            const dim = highlightRow !== undefined && highlightRow !== r ? Math.min(1, 1 - 0.7 * highlight + flash * 1.5) : 1;
            return (
              <g key={c} opacity={shown * dim}>
                <rect x={pad + c * cell + 3} y={top + r * cell + 3} width={cell - 6} height={cell - 6} rx={8}
                  fill={mix(theme.surface, theme.accent, Math.min(1, 0.1 + 0.9 * level(value, row) + flash))} />
                {showValues ? <text x={pad + c * cell + cell / 2} y={top + r * cell + cell / 2 + 8} textAnchor="middle" fontFamily={theme.mono} fontSize={22} fill={level(value, row) > 0.55 ? theme.background : theme.ink}>{value.toFixed(2)}</text> : null}
              </g>
            );
          })}
          {highlightRow === r && highlight > 0 ? <rect x={pad - 2} y={top + r * cell} width={cols * cell + 4} height={cell} rx={12} fill="none" stroke={theme.accent2} strokeWidth={4} opacity={highlight} /> : null}
        </g>
      ))}
    </svg>
  );
};
