// The master timeline. Every frame position is derived from video.json so
// narration, music, cues and rendering can never drift apart.
import video from "../video.json";

export type Theme = {
  background: string; surface: string; ink: string; muted: string;
  accent: string; accent2: string; danger: string;
  display: string; text: string; mono: string;
  /** Procedural backdrop family; "none" leaves the ground clean. */
  backdrop?: "lattice" | "rules" | "halftone" | "contour" | "ticks" | "flow" | "none";
  displayWeight?: number; displayTracking?: number;
  /** Burned-in caption treatment. */
  caption?: "solid" | "outline" | "plain";
};
/** Who made the video. Absent fields are simply not shown; nothing is invented. */
export type Brand = { name?: string; handle?: string; website?: string; tagline?: string; logo?: string };
export type CtaMoment = { at: number; seconds?: number; prompt?: string };
export type Publish = {
  /** "personal" turns every marketing element off. */
  intent: "publish" | "personal";
  /** youtube, shorts, tiktok, instagram, x, linkedin, facebook. One platform gets its own words; several get generic Follow and Like. */
  platforms?: string[];
  cta?: { enabled?: boolean; like?: CtaMoment | null; follow?: CtaMoment | null; comment?: CtaMoment | null; share?: CtaMoment | null };
  brandBug?: boolean;
  /** 1280x720 cover image, rendered by video_render mode "thumbnail". Wrap the emphasised word in asterisks. */
  thumbnail?: { text: string; sub?: string; image?: string };
  /** Attribution lines for fetched assets, written by video_assets. */
  credits?: string[];
};
export type SceneSpec = {
  id: string;
  component: string;
  seconds: number;
  narration?: string | null;
  narrationAudio?: string | null;
  narrationOffset?: number;
  narrationSeconds?: number | null;
  /** Measured word timings (seconds from the narration start), written by narration_tts. */
  narrationWords?: Array<{ w: string; s: number; e: number }>;
  props?: Record<string, unknown>;
  cues?: Record<string, number>;
  /** Cue name → spoken word ("softmax", or "softmax#2" for its second use); narration_tts re-times the cue to that word. */
  cueWords?: Record<string, string>;
  /** Entry transition from the previous scene's end. */
  transition?: { type: "fade" | "slide" | "slideup" | "slidedown" | "wipe" | "zoom" | "blur" | "none"; seconds?: number };
  /** Musical intensity 0..1 around this scene; audio_synth music follows it. */
  energy?: number;
  /** Section title for the YouTube chapter list; the first scene of a chapter carries it. */
  chapter?: string;
};
/** `auto` marks placements made by audio_synth sound_design; re-running replaces only those. */
export type SfxSpec = { src: string; at: number; volume?: number; auto?: boolean };
export type CaptionSpec = { enabled: boolean; style?: "chunks" | "karaoke"; maxWords?: number; position?: "bottom" | "top" };
export type VideoSpec = {
  version: 1; title: string; fps: number; width: number; height: number;
  /** Id of the art-direction look the theme came from. */
  look?: string;
  theme: Theme;
  brand?: Brand;
  publish?: Publish;
  audio: { music: string | null; musicVolume: number; musicDuckedVolume: number; narrationVolume: number; sfx: SfxSpec[]; musicBpm?: number };
  /** Burned-in narration captions; the final render also writes SRT/VTT. */
  captions?: CaptionSpec;
  scenes: SceneSpec[];
};
export type TimedScene = SceneSpec & { index: number; from: number; durationInFrames: number; startSeconds: number };

export const spec = video as unknown as VideoSpec;
export const toFrames = (seconds: number, fps = spec.fps) => Math.round(seconds * fps);

export function timeline(source: VideoSpec = spec): { scenes: TimedScene[]; durationInFrames: number } {
  let from = 0;
  const scenes = source.scenes.map((scene, index) => {
    const durationInFrames = Math.max(1, toFrames(scene.seconds, source.fps));
    const timed = { ...scene, index, from, durationInFrames, startSeconds: from / source.fps };
    from += durationInFrames;
    return timed;
  });
  return { scenes, durationInFrames: Math.max(1, from) };
}

/** Frame (relative to the scene) of a named cue; unknown cues fail loudly so a
 * renamed cue cannot silently desynchronize narration and motion. */
export function cue(scene: Pick<SceneSpec, "id" | "cues">, name: string, fps = spec.fps): number {
  const seconds = scene.cues?.[name];
  if (typeof seconds !== "number") throw new Error(`Scene "${scene.id}" has no cue "${name}" in video.json`);
  return toFrames(seconds, fps);
}

/** A cue that may be absent: the scene still renders, starting at `fallbackSeconds`. */
export function cueOr(scene: Pick<SceneSpec, "cues">, name: string, fallbackSeconds: number, fps = spec.fps): number {
  const seconds = scene.cues?.[name];
  return toFrames(typeof seconds === "number" ? seconds : fallbackSeconds, fps);
}

/** Absolute-frame windows where narration plays, used to duck music. */
export function narrationWindows(source: VideoSpec = spec): Array<[number, number]> {
  return timeline(source).scenes.flatMap((scene) => {
    if (!scene.narrationAudio || !scene.narrationSeconds) return [];
    const start = scene.from + toFrames(scene.narrationOffset ?? 0, source.fps);
    return [[start, start + toFrames(scene.narrationSeconds, source.fps)] as [number, number]];
  });
}
