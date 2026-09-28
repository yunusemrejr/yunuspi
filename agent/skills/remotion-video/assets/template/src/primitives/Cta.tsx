import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ease, progress } from "../motion";
import { mix, onColor, useCanvas, useTheme, useTone } from "../theme";
import { spec, type CtaMoment } from "../timeline";

// Calls to action and brand marks. They exist only when video.json names a
// brand and a publish intent: nothing here invents an author, a follower count
// or a like count. One platform gets its own words (Subscribe and a bell for
// YouTube); several platforms, or none named, get the generic Follow and Like.
// All shapes are drawn here; no platform logos are used.

const PATHS = {
  like: "M2 10h4v11H2zM8 21V10l4-8c1.6 0 2.6 1.3 2.3 2.8L13.6 9H20a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21z",
  bell: "M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  comment: "M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z",
  share: "M14 4l7 7-7 7v-4c-6 0-9 2-11 6 1-7 4-11 11-12z",
} as const;
const Icon: React.FC<{ d: string; size: number; fill?: string; stroke?: string; strokeWidth?: number }> = ({ d, size, fill = "none", stroke = "none", strokeWidth = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible" }}><path d={d} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" /></svg>
);

export type CtaVariant = "youtube" | "generic";
/** One platform earns its own vocabulary; anything else stays universal. */
export function ctaVariant(platforms: string[] | undefined): CtaVariant {
  const list = (platforms ?? []).map((p) => p.toLowerCase());
  return list.length === 1 && (list[0] === "youtube" || list[0] === "shorts") ? "youtube" : "generic";
}
const YOUTUBE_RED = "#E5241B";

const Pill: React.FC<{ children: React.ReactNode; p: number }> = ({ children, p }) => {
  const theme = useTheme();
  const tone = useTone();
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 22, padding: "16px 30px 16px 20px", borderRadius: 999, fontFamily: theme.text, fontWeight: 700, fontSize: 34, color: theme.ink,
      background: tone === "dark" ? mix(theme.surface, "#000000", 0.25) : theme.surface, border: `2px solid ${theme.ink}22`, boxShadow: "0 10px 28px rgba(0,0,0,0.22)", opacity: p, transform: `translateY(${(1 - p) * -22}px) scale(${0.96 + 0.04 * p})` }}>
      {children}
    </div>
  );
};

/** The thumb presses (0.25-0.45), fills and throws six short rays. `t` is 0..1 over the moment. */
export const LikeButton: React.FC<{ t: number; label?: string }> = ({ t, label = "Like" }) => {
  const theme = useTheme();
  const enter = progress(t * 100, 0, 12), press = Math.max(0, t - 0.28);
  const squash = press > 0 && press < 0.12 ? 1 - 0.2 * Math.sin((press / 0.12) * Math.PI) : press >= 0.12 ? 1 + 0.16 * Math.max(0, 1 - (press - 0.12) / 0.14) * Math.cos(press * 40) : 1;
  const filled = t >= 0.32;
  const rays = progress(t * 100, 32, 14, ease.out);
  return (
    <Pill p={enter}>
      <div style={{ position: "relative", width: 52, height: 52, transform: `scale(${squash})` }}>
        <Icon d={PATHS.like} size={52} fill={filled ? theme.accent : "none"} stroke={filled ? theme.accent : theme.ink} strokeWidth={filled ? 1.2 : 2} />
        {rays > 0 && rays < 1 ? [0, 1, 2, 3, 4, 5].map((i) => { const a = -Math.PI / 2 + (i - 2.5) * 0.5; return <span key={i} style={{ position: "absolute", left: 26, top: 26, width: 4, height: 14, borderRadius: 2, background: theme.accent, opacity: 1 - rays, transform: `translate(-50%, -50%) translate(${Math.cos(a) * (34 + rays * 22)}px, ${Math.sin(a) * (34 + rays * 22)}px) rotate(${a + Math.PI / 2}rad)` }} />; }) : null}
      </div>
      {label}
    </Pill>
  );
};

/** Avatar + name and a button that presses (0.35) into its done state. */
export const FollowButton: React.FC<{ t: number; variant: CtaVariant; name?: string; handle?: string; logo?: string }> = ({ t, variant, name, handle, logo }) => {
  const theme = useTheme();
  const enter = progress(t * 100, 0, 12);
  const done = t >= 0.4;
  const press = Math.max(0, t - 0.35), pop = press > 0 && press < 0.1 ? 1 - 0.09 * Math.sin((press / 0.1) * Math.PI) : 1;
  const idle = variant === "youtube" ? YOUTUBE_RED : theme.accent;
  const fill = done ? mix(theme.surface, theme.ink, 0.16) : idle;
  const ink = done ? theme.ink : variant === "youtube" ? "#FFFFFF" : onColor(theme.accent);
  const wiggle = variant === "youtube" && done ? Math.sin(Math.max(0, t - 0.44) * 90) * 16 * Math.max(0, 1 - Math.max(0, t - 0.44) / 0.2) : 0;
  const initial = (name ?? handle ?? "?").replace(/^@/, "").charAt(0).toUpperCase();
  const label = variant === "youtube" ? (done ? "Subscribed" : "Subscribe") : done ? "Following" : "Follow";
  return (
    <Pill p={enter}>
      {logo ? <Img src={staticFile(logo)} style={{ width: 56, height: 56, borderRadius: 28, objectFit: "cover" }} /> : <div style={{ width: 56, height: 56, borderRadius: 28, background: theme.accent, color: onColor(theme.accent), display: "grid", placeItems: "center", fontFamily: theme.display, fontWeight: theme.displayWeight ?? 700, fontSize: 30 }}>{initial}</div>}
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        <span>{name ?? handle}</span>
        {name && handle ? <span style={{ fontWeight: 500, fontSize: 24, color: theme.muted }}>{handle}</span> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 26px", borderRadius: 999, background: fill, color: ink, fontSize: 30, transform: `scale(${pop})` }}>
        {done ? <Icon d={PATHS.check} size={28} stroke={ink} strokeWidth={3} /> : null}
        {label}
        {variant === "youtube" && done ? <span style={{ transform: `rotate(${wiggle}deg)`, transformOrigin: "50% 10%" }}><Icon d={PATHS.bell} size={30} fill={ink} /></span> : null}
      </div>
    </Pill>
  );
};

export const PromptChip: React.FC<{ t: number; kind: "comment" | "share"; text: string }> = ({ t, kind, text }) => {
  const theme = useTheme();
  return <Pill p={progress(t * 100, 0, 12)}><Icon d={PATHS[kind]} size={44} fill={theme.accent} /><span style={{ maxWidth: 760, textWrap: "balance" }}>{text}</span></Pill>;
};

/** Local 0..1 progress of a moment at the current absolute frame, or null outside it. */
function momentProgress(frame: number, fps: number, moment: CtaMoment | null | undefined, fallback: number): number | null {
  if (!moment || typeof moment.at !== "number") return null;
  const start = moment.at * fps, length = (moment.seconds ?? fallback) * fps;
  return frame >= start && frame < start + length ? (frame - start) / length : null;
}

/** Global overlay: each configured moment plays once at its absolute time. */
export const CtaLayer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height } = useCanvas();
  const cta = spec.publish?.cta;
  if (spec.publish?.intent === "personal" || !cta || cta.enabled === false) return null;
  const variant = ctaVariant(spec.publish?.platforms);
  const like = momentProgress(frame, fps, cta.like, 3.4), follow = momentProgress(frame, fps, cta.follow, 4.2);
  const comment = momentProgress(frame, fps, cta.comment, 5), share = momentProgress(frame, fps, cta.share, 3.6);
  // Portrait feeds cover the bottom and right edges with their own controls.
  const top = height > width ? Math.round(height * 0.09) : 64, left = height > width ? 48 : 72;
  const leave = (t: number) => 1 - progress(t * 100, 88, 12, ease.in);
  return (
    <div style={{ position: "absolute", left, top, display: "flex", flexDirection: "column", gap: 16, pointerEvents: "none" }}>
      {like !== null ? <div style={{ opacity: leave(like) }}><LikeButton t={like} /></div> : null}
      {follow !== null ? <div style={{ opacity: leave(follow) }}><FollowButton t={follow} variant={variant} name={spec.brand?.name} handle={spec.brand?.handle} logo={spec.brand?.logo} /></div> : null}
      {comment !== null ? <div style={{ opacity: leave(comment) }}><PromptChip t={comment} kind="comment" text={cta.comment?.prompt ?? "Tell me in the comments"} /></div> : null}
      {share !== null ? <div style={{ opacity: leave(share) }}><PromptChip t={share} kind="share" text={cta.share?.prompt ?? "Send this to someone who needs it"} /></div> : null}
    </div>
  );
};

/** Quiet channel mark, top right, from 1.5 s until the end screen takes over. */
export const BrandBug: React.FC<{ endsAt?: number }> = ({ endsAt }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const theme = useTheme();
  const brand = spec.brand;
  if (spec.publish?.intent === "personal" || spec.publish?.brandBug === false || !brand || (!brand.name && !brand.handle && !brand.logo)) return null;
  const end = (endsAt ?? durationInFrames / fps) * fps;
  const p = Math.min(progress(frame, Math.round(1.5 * fps), 18), 1 - progress(frame, end - 12, 12, ease.in));
  if (p <= 0) return null;
  const label = brand.name ?? brand.handle;
  return (
    <div style={{ position: "absolute", right: 72, top: 64, display: "flex", alignItems: "center", gap: 14, opacity: 0.82 * p, fontFamily: theme.display, fontWeight: theme.displayWeight ?? 700, fontSize: 30, letterSpacing: `${theme.displayTracking ?? 0}em`, color: theme.ink, pointerEvents: "none" }}>
      {brand.logo ? <Img src={staticFile(brand.logo)} style={{ height: 44, width: "auto" }} /> : null}
      <span>{label}</span>
    </div>
  );
};
