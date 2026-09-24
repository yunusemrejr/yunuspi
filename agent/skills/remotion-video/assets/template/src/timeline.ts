// The master timeline. Every frame position is derived from video.json so
// narration, music, cues and rendering can never drift apart.
import video from "../video.json";

export type Theme = {
  background: string; surface: string; ink: string; muted: string;
  accent: string; accent2: string; danger: string;
  display: string; text: string; mono: string;
};
export type SceneSpec = {
  id: string;
  component: string;
  seconds: number;
  narration?: string | null;
  narrationAudio?: string | null;
  narrationOffset?: number;
  narrationSeconds?: number | null;
  props?: Record<string, unknown>;
  cues?: Record<string, number>;
  /** Entry transition from the previous scene's end. */
  transition?: { type: "fade" | "slide" | "wipe" | "zoom" | "blur" | "none"; seconds?: number };
};
export type SfxSpec = { src: string; at: number; volume?: number };
export type CaptionSpec = { enabled: boolean; style?: "chunks" | "karaoke"; maxWords?: number; position?: "bottom" | "top" };
export type VideoSpec = {
  version: 1; title: string; fps: number; width: number; height: number;
  theme: Theme;
  audio: { music: string | null; musicVolume: number; musicDuckedVolume: number; narrationVolume: number; sfx: SfxSpec[] };
  /** Burned-in narration captions; the final render also writes SRT/VTT. */
  captions?: CaptionSpec;
  scenes: SceneSpec[];
};
export type TimedScene = SceneSpec & { index: number; from: number; durationInFrames: number; startSeconds: number };

export const spec = video as VideoSpec;
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

/** Absolute-frame windows where narration plays, used to duck music. */
export function narrationWindows(source: VideoSpec = spec): Array<[number, number]> {
  return timeline(source).scenes.flatMap((scene) => {
    if (!scene.narrationAudio || !scene.narrationSeconds) return [];
    const start = scene.from + toFrames(scene.narrationOffset ?? 0, source.fps);
    return [[start, start + toFrames(scene.narrationSeconds, source.fps)] as [number, number]];
  });
}
