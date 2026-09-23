import React from "react";
import { useTheme } from "../theme";

/** Code as a visual: characters type in with `reveal` (0..1) and highlighted
 * lines glow. Show at most ~12 short lines; code is illustration, not docs. */
export const CodeBlock: React.FC<{ code: string; reveal: number; highlight?: number[]; fontSize?: number; width?: number }> = ({ code, reveal, highlight = [], fontSize = 34, width = 1100 }) => {
  const theme = useTheme();
  const total = code.length;
  let remaining = Math.floor(total * reveal);
  return (
    <div style={{ width, padding: "40px 48px", borderRadius: 24, background: theme.surface, border: `1px solid ${theme.muted}33`, fontFamily: theme.mono, fontSize, lineHeight: 1.5 }}>
      {code.split("\n").map((line, i) => {
        const shown = line.slice(0, Math.max(0, remaining));
        remaining -= line.length + 1;
        const hot = highlight.includes(i);
        return (
          <div key={i} style={{ whiteSpace: "pre", color: hot ? theme.ink : theme.muted, background: hot ? `${theme.accent}22` : "transparent", borderRadius: 8, padding: "0 12px", margin: "0 -12px" }}>
            {shown || " "}
          </div>
        );
      })}
    </div>
  );
};
