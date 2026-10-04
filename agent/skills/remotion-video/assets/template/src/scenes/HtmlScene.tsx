import React from "react";
import { AbsoluteFill } from "remotion";
import { Heading, HtmlMotion, Stage } from "../primitives";
import { useSafe, useTheme } from "../theme";
import { cueOr, type TimedScene } from "../timeline";

/** A vanilla HTML motion page (public/html/*.html exposing window.renderFrame) as a whole scene.
 * Pages that paint their own ground fill the frame; transparent pages (props.transparent) sit
 * on the look's stage with `backdrop`. An optional title overlays the lower left. */
export const HtmlScene: React.FC<{ scene: TimedScene; src: string; props?: Record<string, unknown>; from?: number; speed?: number; backdrop?: boolean; kicker?: string; title?: string; subtitle?: string }> = ({
  scene, src, props, from, speed, backdrop = false, kicker, title, subtitle,
}) => {
  const safe = useSafe();
  const theme = useTheme();
  return (
    <AbsoluteFill>
      {backdrop ? <Stage seed={scene.index + 9}>{null}</Stage> : null}
      <HtmlMotion src={src} props={backdrop ? { transparent: true, ...props } : props} from={from} speed={speed} />
      {title ? (
        <AbsoluteFill style={{ padding: safe }}>
          <div style={{ position: "relative", width: "100%", height: "100%", fontFamily: theme.text, color: theme.ink }}>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
              <Heading kicker={kicker} title={title} subtitle={subtitle} at={cueOr(scene, "title", 0.4)} subtitleAt={cueOr(scene, "subtitle", 1.1)} size={96} />
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
