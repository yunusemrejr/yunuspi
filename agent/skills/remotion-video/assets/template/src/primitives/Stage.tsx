import React from "react";
import { AbsoluteFill } from "remotion";
import { useSafe, useTheme, useTone } from "../theme";
import { Backdrop } from "./Backdrop";

/** Full-frame canvas with the look's backdrop, a tone-aware vignette and a
 * title-safe area. Compose inside `children`; absolute positions are relative
 * to the safe area. The safe margin is 120px on the short side. */
export const Stage: React.FC<{ children: React.ReactNode; backdrop?: boolean; seed?: number; tint?: string }> = ({ children, backdrop = true, seed = 7, tint }) => {
  const theme = useTheme();
  const tone = useTone();
  const safe = useSafe();
  // Dark grounds sink at the edges; light grounds lift slightly instead of graying.
  const vignette = tone === "dark" ? "radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,0.5) 100%)" : "radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(0,0,0,0.07) 100%)";
  return (
    <AbsoluteFill style={{ background: theme.background, fontFamily: theme.text, color: theme.ink }}>
      {backdrop ? <Backdrop seed={seed} tint={tint} /> : null}
      <AbsoluteFill style={{ background: vignette }} />
      <AbsoluteFill style={{ padding: safe }}>
        <div style={{ position: "relative", width: "100%", height: "100%" }}>{children}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
