import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { captionChunks } from "../captions";
import { progress } from "../motion";
import { SAFE, useTheme } from "../theme";

/** Narration captions synced to the measured narration length. "chunks"
 * shows short phrases; "karaoke" also lights the word being spoken. Mount
 * inside a Sequence that starts where the narration starts. */
export const Captions: React.FC<{ text: string; seconds: number; style?: "chunks" | "karaoke"; maxWords?: number; position?: "bottom" | "top"; size?: number }> = ({ text, seconds, style = "chunks", maxWords = 7, position = "bottom", size }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const theme = useTheme();
  const chunks = useMemo(() => captionChunks(text, seconds, maxWords), [text, seconds, maxWords]);
  const t = frame / fps;
  const index = chunks.findIndex((c) => t >= c.start && t < c.end);
  if (index < 0) return null;
  const chunk = chunks[index];
  const fontSize = size ?? Math.round(height * 0.04);
  const appear = progress(frame, Math.round(chunk.start * fps), 4);
  return (
    <div style={{ position: "absolute", left: SAFE, right: SAFE, [position]: Math.round(height * 0.07), display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ maxWidth: "80%", padding: `${Math.round(fontSize * 0.3)}px ${Math.round(fontSize * 0.55)}px`, borderRadius: Math.round(fontSize * 0.35), background: "rgba(0, 0, 0, 0.62)",
        fontFamily: theme.text, fontWeight: 600, fontSize, lineHeight: 1.25, color: theme.ink, textAlign: "center", textWrap: "balance", opacity: appear, transform: `translateY(${(1 - appear) * 6}px)` }}>
        {style === "karaoke"
          ? chunk.words.map((w, i) => (
              <span key={i} style={{ color: t >= w.start && t < w.end ? theme.accent : t >= w.end ? theme.ink : theme.muted }}>{w.word}{i < chunk.words.length - 1 ? " " : ""}</span>
            ))
          : chunk.text}
      </div>
    </div>
  );
};
