import React from "react";
import { type, useTheme } from "../theme";

/** Counting number: interpolates from `from` to `to` across `progress`
 * (0..1, eased by the caller). Monospace tabular figures keep every frame
 * the same width, so the number never jitters while it counts. */
export const Counter: React.FC<{ to: number; from?: number; progress: number; prefix?: string; suffix?: string; decimals?: number; size?: number }> = ({ to, from = 0, progress, prefix = "", suffix = "", decimals = 0, size = type.title }) => {
  const theme = useTheme();
  const p = Math.min(1, Math.max(0, progress));
  const value = from + (to - from) * p;
  const text = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  return (
    <span style={{ fontFamily: theme.mono, fontWeight: 700, fontSize: size, color: theme.ink, fontVariantNumeric: "tabular-nums", letterSpacing: "0" }}>
      {prefix}{text}{suffix}
    </span>
  );
};
