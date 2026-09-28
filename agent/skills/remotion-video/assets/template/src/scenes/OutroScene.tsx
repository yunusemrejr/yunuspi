import React from "react";
import { useCurrentFrame } from "remotion";
import { ease, enter, progress } from "../motion";
import { FollowButton, ctaVariant } from "../primitives/Cta";
import { Heading, Stage } from "../primitives";
import { type, useTheme } from "../theme";
import { cue, spec, type TimedScene } from "../timeline";

/** End screen for a published video: one closing line, the channel and its
 * follow action. The right 40% stays empty on purpose: platforms place their
 * own end-screen video and subscribe elements there for 5-20 s, so keep the
 * scene at least 8 s. Attribution for fetched assets sits at the foot. */
export const OutroScene: React.FC<{ scene: TimedScene; headline: string; sub?: string }> = ({ scene, headline, sub }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const brand = spec.brand;
  const variant = ctaVariant(spec.publish?.platforms);
  const follow = progress(frame, cue(scene, "follow"), 150, ease.linear);
  const rise = enter(frame, cue(scene, "follow") - 6);
  return (
    <Stage seed={scene.index + 9}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center" }}>
        <div style={{ width: "58%", display: "flex", flexDirection: "column", gap: 56 }}>
          <Heading title={headline} subtitle={sub} at={cue(scene, "headline")} size={type.title + 12} />
          {brand?.name || brand?.handle ? <div style={{ transformOrigin: "0 50%", opacity: rise.opacity, transform: `scale(1.08) ${rise.transform}` }}><FollowButton t={follow} variant={variant} name={brand.name} handle={brand.handle} logo={brand.logo} /></div> : null}
          {brand?.website ? <div style={{ fontFamily: theme.text, fontWeight: 600, fontSize: type.caption, color: theme.muted, ...enter(frame, cue(scene, "follow") + 12) }}>{brand.website}</div> : null}
        </div>
      </div>
      {spec.publish?.credits?.length ? <div style={{ position: "absolute", left: 0, bottom: -40, fontFamily: theme.text, fontSize: 20, color: theme.muted, maxWidth: "70%", lineHeight: 1.35 }}>{spec.publish.credits.join(" · ")}</div> : null}
    </Stage>
  );
};
