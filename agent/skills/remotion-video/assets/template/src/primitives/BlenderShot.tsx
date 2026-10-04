import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ease, progress } from "../motion";
import { type, useCanvas, useTheme } from "../theme";

/** A Blender shot from `video_shot`: an RGBA image sequence in public/shots/<name>/
 * with a manifest and, when anchors were requested, the per-frame screen
 * positions of named 3D features. The player is a pure function of the frame;
 * it blends neighbouring frames when the film runs faster than the render, so a
 * 12-15 fps render of a slow move plays smoothly in a 30 fps film. ShotAnchor
 * and ShotNote pin 2D graphics to 3D features, so labels follow the object. */

export type ShotMeta = { name: string; fps: number; frames: number; width: number; height: number; alpha: boolean; loop: boolean; anchors: string | null; anchorNames: string[]; quality?: string };
type AnchorPoint = { x: number; y: number; depth: number; visible: boolean };
type AnchorTrack = { frames: Array<{ frame: number; anchors: Record<string, AnchorPoint> }> };
export type ShotMode = "hold" | "loop" | "pingpong";
type Rect = { x: number; y: number; w: number; h: number };
type ShotContext = { meta: ShotMeta; track: AnchorTrack | null; rect: Rect; position: ReturnType<typeof shotPosition> };

const documents = new Map<string, Promise<any>>();
const fetchJson = (url: string) => {
  let pending = documents.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => { if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response.json(); });
    documents.set(url, pending);
  }
  return pending;
};

/** Manifest and anchor track of a shot; the render waits until both are in. */
export function useShot(shot: string): { meta: ShotMeta; track: AnchorTrack | null } | null {
  const [loaded, setLoaded] = useState<{ meta: ShotMeta; track: AnchorTrack | null } | null>(null);
  const handle = useRef<number | null>(null);
  if (handle.current === null) handle.current = delayRender(`shot ${shot}`, { timeoutInMilliseconds: 60000 });
  useEffect(() => {
    let alive = true;
    (async () => {
      const meta: ShotMeta = await fetchJson(staticFile(`shots/${shot}/shot.json`));
      const track: AnchorTrack | null = meta.anchors ? await fetchJson(staticFile(`shots/${shot}/${meta.anchors}`)) : null;
      if (!alive) return;
      setLoaded({ meta, track });
      continueRender(handle.current!);
    })().catch((error) => cancelRender(error));
    return () => { alive = false; };
  }, [shot]);
  return loaded;
}

/** Which rendered frames, and how much of each, show at `seconds` into the shot. */
export function shotPosition(meta: Pick<ShotMeta, "fps" | "frames">, seconds: number, mode: ShotMode = "hold", speed = 1, offset = 0) {
  const last = meta.frames - 1;
  let t = (offset + seconds * speed) * meta.fps;
  if (mode === "loop") t = ((t % meta.frames) + meta.frames) % meta.frames;
  else if (mode === "pingpong") { const span = Math.max(1, last * 2); const m = ((t % span) + span) % span; t = m <= last ? m : span - m; }
  else t = Math.min(last, Math.max(0, t));
  const a = Math.min(last, Math.floor(t));
  const b = mode === "loop" ? (a + 1) % meta.frames : Math.min(last, a + 1);
  return { t, a, b, mix: t - a };
}

const place = (box: { width: number; height: number }, meta: ShotMeta, fit: "contain" | "cover", align: [number, number], scale: number): Rect => {
  const k = (fit === "cover" ? Math.max : Math.min)(box.width / meta.width, box.height / meta.height) * scale;
  const w = meta.width * k, h = meta.height * k;
  return { x: (box.width - w) * align[0], y: (box.height - h) * align[1], w, h };
};
const frameUrl = (shot: string, index: number) => staticFile(`shots/${shot}/frame-${String(index + 1).padStart(4, "0")}.png`);
const ShotCtx = createContext<ShotContext | null>(null);

export const BlenderShot: React.FC<{
  shot: string; mode?: ShotMode; speed?: number; offset?: number; fit?: "contain" | "cover"; align?: [number, number]; scale?: number;
  /** Blend between rendered frames (default true); turn off for stylised, stepped motion. */
  blend?: boolean; opacity?: number; children?: React.ReactNode;
}> = ({ shot, mode, speed = 1, offset = 0, fit = "contain", align = [0.5, 0.5], scale = 1, blend = true, opacity = 1, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvas = useCanvas();
  const loaded = useShot(shot);
  if (!loaded) return null;
  const { meta, track } = loaded;
  const position = shotPosition(meta, frame / fps, mode ?? (meta.loop ? "loop" : "hold"), speed, offset);
  const rect = place(canvas, meta, fit, align, scale);
  const image: React.CSSProperties = { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" };
  return (
    <ShotCtx.Provider value={{ meta, track, rect, position }}>
      <div style={{ position: "absolute", inset: 0, opacity }}>
        <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <Img src={frameUrl(shot, position.a)} style={image} />
          {blend && position.b !== position.a && position.mix > 0.02 ? <Img src={frameUrl(shot, position.b)} style={{ ...image, opacity: position.mix }} /> : null}
        </div>
        {children}
      </div>
    </ShotCtx.Provider>
  );
};

/** Position of a named anchor in layout units (relative to the BlenderShot's container); `visible` is 0..1, falling when the feature turns behind the subject. */
export function useShotAnchor(name: string): { x: number; y: number; visible: number } | null {
  const context = useContext(ShotCtx);
  if (!context?.track) return null;
  const { track, rect, position } = context;
  const a = track.frames[position.a]?.anchors[name], b = track.frames[position.b]?.anchors[name];
  if (!a || !b) return null;
  const mix = position.mix;
  const x = a.x + (b.x - a.x) * mix, y = a.y + (b.y - a.y) * mix;
  return { x: rect.x + x * rect.w, y: rect.y + y * rect.h, visible: (a.visible ? 1 - mix : 0) + (b.visible ? mix : 0) };
}

/** Pins children to a 3D feature; they follow it across the shot and fade while it is hidden. */
export const ShotAnchor: React.FC<{ name: string; dx?: number; dy?: number; children?: React.ReactNode }> = ({ name, dx = 0, dy = 0, children }) => {
  const anchor = useShotAnchor(name);
  if (!anchor || anchor.visible <= 0.01) return null;
  return <div style={{ position: "absolute", left: anchor.x + dx, top: anchor.y + dy, opacity: anchor.visible }}>{children}</div>;
};

/** Annotation with a leader line to a 3D feature: a ring on the feature, a hairline that draws on and runs under the label, and the label rising out of a mask. `at` is the cue frame; dx/dy place the label (default: outward from the frame centre, up). */
export const ShotNote: React.FC<{ anchor: string; text: string; sub?: string; at?: number; dx?: number; dy?: number }> = ({ anchor, text, sub, at = 0, dx: dxProp, dy = -150 }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width } = useCanvas();
  const point = useShotAnchor(anchor);
  const draw = progress(frame, at, 22, ease.inOut), label = progress(frame, at + 12, 18);
  if (!point || point.visible <= 0.01 || draw <= 0) return null;
  // Labels leave toward the nearer side of the frame, away from the subject, unless dx says otherwise.
  const dx = dxProp ?? (point.x < width / 2 ? -190 : 190);
  const toRight = dx >= 0;
  const ex = point.x + dx, ey = point.y + dy;
  const path = `M ${point.x} ${point.y} L ${ex - (toRight ? 36 : -36)} ${ey} L ${ex} ${ey}`;
  const side: React.CSSProperties = toRight ? { left: ex, textAlign: "left", paddingLeft: 18 } : { right: width - ex, textAlign: "right", paddingRight: 18 };
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: point.visible }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle cx={point.x} cy={point.y} r={14} fill="none" stroke={theme.accent} strokeWidth={3} opacity={draw} />
        <path d={path} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} fill="none" stroke={theme.ink} strokeWidth={2} strokeLinecap="square" opacity={0.9} />
      </svg>
      <div style={{ position: "absolute", top: ey, transform: "translateY(-100%)", whiteSpace: "nowrap", ...side }}>
        <div style={{ overflow: "hidden", paddingBottom: 10 }}>
          <div style={{ transform: `translateY(${(1 - label) * 105}%)`, fontFamily: theme.text, fontWeight: 700, fontSize: type.label + 6, lineHeight: 1.15, color: theme.ink }}>{text}</div>
          {sub ? <div style={{ transform: `translateY(${(1 - label) * 105}%)`, fontFamily: theme.mono, fontSize: type.micro, color: theme.muted, marginTop: 4 }}>{sub}</div> : null}
        </div>
        <div style={{ height: 2, background: theme.ink, opacity: 0.9, transform: `scaleX(${draw})`, transformOrigin: toRight ? "left" : "right" }} />
      </div>
    </div>
  );
};
