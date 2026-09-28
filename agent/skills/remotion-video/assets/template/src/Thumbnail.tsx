import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { mix, onColor, useTheme } from "./theme";
import { spec } from "./timeline";

/** 1280x720 cover: at most four words of display type with one emphasised
 * word, high contrast, and either a supplied image or a bold accent field.
 * Text is what survives a phone-sized thumbnail; keep it to the claim. */
export const Thumbnail: React.FC = () => {
  const theme = useTheme();
  const cover = spec.publish?.thumbnail;
  const text = cover?.text ?? spec.title;
  const parts = text.split(/(\*[^*]+\*)/).filter(Boolean);
  const words = text.replace(/\*/g, "").split(/\s+/).length;
  const size = words <= 2 ? 210 : words <= 3 ? 170 : 132;
  return (
    <AbsoluteFill style={{ background: theme.background, fontFamily: theme.display, overflow: "hidden" }}>
      {cover?.image ? (
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "48%" }}>
          <Img src={staticFile(cover.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, ${theme.background} 0%, transparent 38%)` }} />
        </div>
      ) : (
        <div style={{ position: "absolute", right: -80, top: -60, width: 560, height: 840, background: theme.accent, transform: "rotate(-7deg)", borderRadius: 40 }} />
      )}
      <div style={{ position: "absolute", left: 64, top: 0, bottom: 0, width: cover?.image ? "62%" : "60%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 26 }}>
        <div style={{ fontWeight: theme.displayWeight ?? 800, fontSize: size, lineHeight: 0.95, letterSpacing: `${theme.displayTracking ?? -0.02}em`, color: theme.ink, textWrap: "balance" }}>
          {parts.map((part, i) => part.startsWith("*")
            ? <span key={i} style={{ color: onColor(theme.accent), background: theme.accent, padding: "0 0.12em", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>{part.slice(1, -1)}</span>
            : <React.Fragment key={i}>{part}</React.Fragment>)}
        </div>
        {cover?.sub ? <div style={{ fontFamily: theme.text, fontWeight: 700, fontSize: 46, color: mix(theme.ink, theme.background, 0.25), maxWidth: 640 }}>{cover.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
