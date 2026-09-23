/** Code-first video tools. Discovered on demand through tool_search; the
 * code-first-video skill owns the production workflow and review discipline. */
import { Type } from "typebox";
import { audioSynth, narrationTts, videoProject, videoQa, videoRender } from "./lib/video-studio.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const choices = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));

export default function videoStudio(pi: any) {
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal, progress?: (text: string) => void) => Promise<any>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, update: ((partial: any) => void) | undefined, ctx: any) {
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const progress = (text: string) => { try { update?.({ content: [{ type: "text", text }], details: { progress: text } }); } catch { /* progress is advisory */ } };
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded, progress);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  register("video_project",
    "Create or validate a code-first video project: Remotion (React/TypeScript) scenes driven by one master timeline video.json (scene order, seconds, narration text/audio, scene-relative cues, music, sfx). init scaffolds reusable primitives (network, matrix, graph, chart, timeline, code, particles, typography) and installs pinned dependencies; check validates timing, narration fit, registry and assets. Read the code-first-video skill before starting a video.",
    Type.Object({ action: Type.Optional(choices(["init", "check", "install"])), dir: localPath, title: Type.Optional(Type.String({ maxLength: 120 })), fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), install: Type.Optional(Type.Boolean()) }),
    videoProject, 1_200_000);
  register("video_render",
    "Render a video project. stills: representative frames (default one per scene at 60%, or count frames across one scene, or explicit times) plus a labeled contact sheet to inspect with read/vision. preview: low-resolution MP4 of a scene or seconds range to judge motion and timing. final: full-quality H.264/AAC with decode verification. Bundles are cached; renders are queued. A successful render is not visual approval.",
    Type.Object({ dir: localPath, mode: Type.Optional(choices(["stills", "preview", "final"])), scene: Type.Optional(Type.String({ maxLength: 48 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1800 }), { minItems: 1, maxItems: 24 })), from: Type.Optional(Type.Number({ minimum: 0, maximum: 1800 })), to: Type.Optional(Type.Number({ minimum: 0, maximum: 1800 })), scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })) }),
    videoRender, 3_700_000);
  register("video_qa",
    "Audit a rendered video: black and frozen stretches, audio/video duration drift, mid-video silence, EBU R128 loudness/peak/range against a target (default -16 LUFS), per-scene narration audibility when dir points at the project, and a labeled scene contact sheet for mandatory visual review. Automated passes find technical defects only.",
    Type.Object({ path: localPath, dir: Type.Optional(localPath), targetLufs: Type.Optional(Type.Number({ minimum: -30, maximum: -8 })) }),
    videoQa, 3_700_000);
  register("narration_tts",
    "Local neural narration with Piper (no cloud, no generated images). status lists engine/voices; install downloads the pinned engine and a checksum-verified voice once; synthesize speaks each video.json scene's narration text into public/audio/narration, measures durations, writes narrationAudio/narrationSeconds back and reports overruns (fitScenes:true lengthens short scenes).",
    Type.Object({ action: Type.Optional(choices(["status", "install", "synthesize"])), dir: Type.Optional(localPath), voice: Type.Optional(choices(["en_US-ryan-high", "en_US-lessac-medium", "en_GB-alan-medium"])), scenes: Type.Optional(Type.Array(Type.String({ maxLength: 48 }), { maxItems: 200 })), speed: Type.Optional(Type.Number({ minimum: 0.6, maximum: 1.5, description: "1 = calibrated documentary pace (~150-170 wpm); lower is slower" })), fitScenes: Type.Optional(Type.Boolean()), tailSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })) }),
    narrationTts, 1_200_000);
  register("audio_synth",
    "Procedural audio for a video project, deterministic and seeded (numpy): kind music renders an ambient bed over a chord progression (pad, bass, pluck pulse, bells, intensity automation) sized to the timeline; kind sfx renders whoosh, riser, impact, tick or chime. Writes public/audio/<name>.wav and returns its publicPath for video.json.",
    Type.Object({ dir: localPath, kind: choices(["music", "sfx"]), name: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$" })), seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 ** 31 })), seconds: Type.Optional(Type.Number({ minimum: 0.02, maximum: 600 })),
      bpm: Type.Optional(Type.Number({ minimum: 40, maximum: 180 })), key: Type.Optional(choices(["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"])), mode: Type.Optional(choices(["major", "minor", "dorian"])),
      progression: Type.Optional(Type.Array(Type.String({ pattern: "^(?:[iI]{1,3}|[iI]?[vV]|[vV][iI]{1,2})$" }), { minItems: 1, maxItems: 16 })), barsPerChord: Type.Optional(Type.Number({ minimum: 0.5, maximum: 8 })),
      layers: Type.Optional(Type.Object({ pad: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), bass: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), pulse: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), bell: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) })),
      intensity: Type.Optional(Type.Array(Type.Array(Type.Number({ minimum: 0, maximum: 1800 }), { minItems: 2, maxItems: 2 }), { maxItems: 64 })),
      type: Type.Optional(choices(["whoosh", "riser", "impact", "tick", "chime"])), pitch: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })) }),
    audioSynth, 360_000);
}
