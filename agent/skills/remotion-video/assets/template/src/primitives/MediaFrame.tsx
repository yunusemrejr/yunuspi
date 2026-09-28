import React from "react";
import { Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ease, progress } from "../motion";
import { useTheme } from "../theme";

/** Fetched or supplied photography, illustration and footage, framed and set
 * in motion so a still is never a static slab. `src` is a path under public/
 * (see video_assets). Motion runs over the whole scene by default:
 *  - push / pull: slow scale toward or away from the focus point
 *  - pan: drift across the image along `focus` → `focusTo`
 *  - parallax: image moves slightly against the frame so the crop feels deep
 * `reveal` wipes the frame in with a mask, `fade`, or none. Everything is a
 * pure function of the frame. */
export type MediaProps = {
  src: string; width: number; height: number;
  motion?: "push" | "pull" | "pan" | "parallax" | "none";
  /** Focus point (0..1, 0..1) the crop centres on; `focusTo` is where a pan ends. */
  focus?: [number, number]; focusTo?: [number, number];
  /** Frames the motion spans; defaults to the composition length. */
  over?: number; at?: number; intensity?: number;
  reveal?: "mask" | "fade" | "none"; radius?: number; frame?: "none" | "hairline" | "shadow";
  fit?: "cover" | "contain";
  /** Photo credit shown as a small line under the frame. */
  credit?: string;
};

const useMotion = (props: MediaProps) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { motion = "push", focus = [0.5, 0.5], focusTo = focus, over = durationInFrames, at = 0, intensity = 0.09 } = props;
  const t = progress(frame, at, Math.max(1, over), ease.inOut);
  const scale = motion === "push" ? 1 + intensity * t : motion === "pull" ? 1 + intensity * (1 - t) : motion === "pan" ? 1 + intensity * 1.2 : motion === "parallax" ? 1 + intensity : 1;
  const fx = motion === "pan" ? focus[0] + (focusTo[0] - focus[0]) * t : focus[0];
  const fy = motion === "pan" ? focus[1] + (focusTo[1] - focus[1]) * t : focus[1];
  const shift = motion === "parallax" ? (t - 0.5) * 2 * intensity * 50 : 0;
  return { scale, origin: `${fx * 100}% ${fy * 100}%`, shift };
};

const Framed: React.FC<{ props: MediaProps; children: React.ReactNode }> = ({ props, children }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, height, reveal = "mask", radius = 20, frame: chrome = "shadow", at = 0, credit } = props;
  const r = reveal === "none" ? 1 : progress(frame, at, 24, ease.out);
  const style: React.CSSProperties = {
    width, height, borderRadius: radius, overflow: "hidden", position: "relative", background: theme.surface,
    clipPath: reveal === "mask" ? `inset(0 ${(1 - r) * 100}% 0 0 round ${radius}px)` : undefined, opacity: reveal === "fade" ? r : 1,
    boxShadow: chrome === "shadow" ? "0 24px 60px rgba(0,0,0,0.35)" : undefined, outline: chrome === "hairline" ? `2px solid ${theme.ink}33` : undefined,
  };
  return (
    <div style={{ width, display: "inline-block" }}>
      <div style={style}>{children}</div>
      {credit ? <div style={{ marginTop: 12, fontFamily: theme.text, fontSize: 22, color: theme.muted, opacity: r }}>{credit}</div> : null}
    </div>
  );
};

export const MediaFrame: React.FC<MediaProps> = (props) => {
  const { scale, origin, shift } = useMotion(props);
  return (
    <Framed props={props}>
      <Img src={staticFile(props.src)} style={{ width: "100%", height: "100%", objectFit: props.fit ?? "cover", transformOrigin: origin, transform: `translateX(${shift}px) scale(${scale})` }} />
    </Framed>
  );
};

/** Video footage in the same frame. Muted by default (narration and music own the sound). */
export const Clip: React.FC<MediaProps & { startFrom?: number; endAt?: number; playbackRate?: number; muted?: boolean }> = ({ startFrom, endAt, playbackRate = 1, muted = true, ...props }) => {
  const { scale, origin, shift } = useMotion({ motion: "none", ...props });
  return (
    <Framed props={props}>
      <OffthreadVideo src={staticFile(props.src)} startFrom={startFrom} endAt={endAt} playbackRate={playbackRate} muted={muted} style={{ width: "100%", height: "100%", objectFit: props.fit ?? "cover", transformOrigin: origin, transform: `translateX(${shift}px) scale(${scale})` }} />
    </Framed>
  );
};
