import React from "react";
import { AbsoluteFill } from "remotion";
import { SAFE, useTheme } from "../theme";
import { Backdrop } from "./Backdrop";

/** Full-frame canvas with a procedural backdrop, vignette and title-safe area.
 * Compose inside `children`; absolute positions are relative to the safe area. */
export const Stage: React.FC<{ children: React.ReactNode; backdrop?: boolean; seed?: number; tint?: string }> = ({ children, backdrop = true, seed = 7, tint }) => {
  const theme = useTheme();
  return (
    <AbsoluteFill style={{ background: theme.background, fontFamily: theme.text, color: theme.ink }}>
      {backdrop ? <Backdrop seed={seed} tint={tint ?? theme.accent} /> : null}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
      <AbsoluteFill style={{ padding: SAFE }}>
        <div style={{ position: "relative", width: "100%", height: "100%" }}>{children}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
