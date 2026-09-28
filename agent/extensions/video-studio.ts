/** Code-first video tools. Discovered on demand through tool_search; the
 * code-first-video skill owns the production workflow and review discipline. */
import { Type } from "typebox";
import { audioSynth, narrationTts, PIPER_VOICES, SFX_TYPES, VOICE_STYLES, videoProject, videoQa, videoRender } from "./lib/video-studio.ts";
import { LOOKS } from "./lib/video-looks.ts";
import { videoAssets } from "./lib/video-assets.ts";
import { PLATFORMS } from "./lib/video-publish.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const choices = (values: string[], description?: string) => Type.Union(values.map((value) => Type.Literal(value)), description ? { description } : {});

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
    "Create or validate a code-first video project: Remotion (React/TypeScript) scenes driven by one master timeline video.json (look, brand, publish settings, scenes, narration text/audio, scene-relative cues, transitions, music, sfx). init scaffolds reusable primitives and an art-directed look (palette, type, backdrop, matching voice and music) chosen from the topic, with brand and platform settings; check validates timing, narration fit, design defaults, publish readiness, registry and assets; look re-skins an existing project; cta places like/follow/comment moments on the finished timeline. Read the code-first-video skill before starting a video.",
    Type.Object({ action: Type.Optional(choices(["init", "check", "install", "look", "cta", "feature"])), dir: localPath, title: Type.Optional(Type.String({ maxLength: 120 })),
      topic: Type.Optional(Type.String({ maxLength: 300, description: "init: subject in a few words; picks the look that fits it" })),
      look: Type.Optional(choices(LOOKS.map((look) => look.id), "init/look: art direction; omit on init to derive it from topic/title")),
      format: Type.Optional(choices(["landscape", "vertical", "square"], "init: 1920x1080, 1080x1920 (Shorts, Reels, TikTok) or 1080x1080")),
      intent: Type.Optional(choices(["publish", "personal"], "init: publish (default) is built to perform for an audience; personal drops brand, calls to action and end screen")),
      platforms: Type.Optional(Type.Array(choices([...PLATFORMS]), { minItems: 1, maxItems: 7, description: "init: where it will be published. One platform gets its own wording (YouTube: Subscribe and a bell); several get generic Follow and Like" })),
      brand: Type.Optional(Type.Object({ name: Type.Optional(Type.String({ maxLength: 120 })), handle: Type.Optional(Type.String({ maxLength: 120 })), website: Type.Optional(Type.String({ maxLength: 120 })), tagline: Type.Optional(Type.String({ maxLength: 120 })), logo: Type.Optional(Type.String({ maxLength: 120, description: "path under public/" })) }, { description: "init: only what the user gave; nothing is invented" })),
      feature: Type.Optional(choices(["3d"], "feature: add opt-in 3D model support (three.js, Model3D primitive)")),
      commentPrompt: Type.Optional(Type.String({ maxLength: 140, description: "cta: the author's own question for a comment moment" })), sharePrompt: Type.Optional(Type.String({ maxLength: 140 })),
      captions: Type.Optional(Type.Boolean({ description: "init with intent personal: burn captions in (default off)" })),
      fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), install: Type.Optional(Type.Boolean()) }),
    videoProject, 1_200_000);
  register("video_render",
    "Render a video project. stills: representative frames (default one per scene at 60%, or count frames across one scene, or explicit times) plus a labeled contact sheet to inspect with read/vision. preview: low-resolution MP4 of a scene or seconds range to judge motion and timing. final: full-quality H.264/AAC with decode verification, captions, chapters and a description draft. thumbnail: the 1280x720 cover from video.json publish.thumbnail. Bundles are cached; renders are queued and run at low priority. A successful render is not visual approval.",
    Type.Object({ dir: localPath, mode: Type.Optional(choices(["stills", "preview", "final", "thumbnail"])), scene: Type.Optional(Type.String({ maxLength: 48 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1800 }), { minItems: 1, maxItems: 24 })), from: Type.Optional(Type.Number({ minimum: 0, maximum: 1800 })), to: Type.Optional(Type.Number({ minimum: 0, maximum: 1800 })), scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2 })), crf: Type.Optional(Type.Integer({ minimum: 1, maximum: 51 })), master: Type.Optional(Type.Boolean({ description: "final: normalize loudness to the platform target (default true); false keeps the raw mix" })) }),
    videoRender, 3_700_000);
  register("video_qa",
    "Audit a rendered video: black and frozen stretches, audio/video duration drift, mid-video silence, EBU R128 loudness/peak/range against a target (default -16 LUFS), per-scene narration audibility when dir points at the project, and a labeled scene contact sheet for mandatory visual review. Automated passes find technical defects only.",
    Type.Object({ path: localPath, dir: Type.Optional(localPath), targetLufs: Type.Optional(Type.Number({ minimum: -30, maximum: -8 })) }),
    videoQa, 3_700_000);
  register("video_assets",
    "Media for a video project from the open web or disk, license-tracked. search: photographs and illustration (openverse, commons), footage (commons, kind video) and CC0 3D models/textures (polyhaven); licenses that forbid commercial use or derivatives are filtered out. fetch: download a hit into public/assets (SSRF-guarded, oversized images shrunk), record its license in assets.json and add attribution to video.json publish.credits when required. import: copy a local file (logo, screenshot, footage) in. list: the manifest and credits. Animate results with the MediaFrame, Clip and Model3D primitives.",
    Type.Object({ action: Type.Optional(choices(["search", "fetch", "import", "list"])), dir: Type.Optional(localPath), query: Type.Optional(Type.String({ maxLength: 200 })), source: Type.Optional(choices(["openverse", "commons", "polyhaven"])), kind: Type.Optional(choices(["image", "video", "model", "texture"])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      url: Type.Optional(Type.String({ maxLength: 2048, description: "fetch: direct file URL from a search hit" })), id: Type.Optional(Type.String({ maxLength: 80, description: "fetch with source polyhaven: asset id" })), resolution: Type.Optional(choices(["1k", "2k"])), path: Type.Optional(localPath), name: Type.Optional(Type.String({ maxLength: 48 })),
      title: Type.Optional(Type.String({ maxLength: 200 })), creator: Type.Optional(Type.String({ maxLength: 200 })), license: Type.Optional(Type.String({ maxLength: 60 })), licenseUrl: Type.Optional(Type.String({ maxLength: 300 })), page: Type.Optional(Type.String({ maxLength: 500 })), attributionRequired: Type.Optional(Type.Boolean()) }),
    videoAssets, 600_000);
  register("narration_tts",
    "Local neural narration with Piper (no cloud, no generated images, capped threads). status lists engine/voices; install downloads the pinned engine and a checksum-verified voice once; synthesize speaks each video.json scene's narration into public/audio/narration with a style (documentary, calm, energetic, intimate), masters it to a common loudness, measures every word's start and end from the synthesized speech (captions use them) and writes durations back. cueWords in a scene ({\"reveal\": \"softmax\"}) re-time the named cue to that spoken word. fitScenes:true lengthens short scenes. lexicon maps display spellings to spoken respellings ({\"Vaswani\": \"Vas-wah-nee\", \"GPT\": \"G P T\"}); video.json keeps the display spelling for captions and on-screen text. A blank line in the narration adds a longer pause.",
    Type.Object({ action: Type.Optional(choices(["status", "install", "synthesize"])), dir: Type.Optional(localPath), voice: Type.Optional(choices(Object.keys(PIPER_VOICES))), style: Type.Optional(choices(Object.keys(VOICE_STYLES), "delivery; defaults to the project look's voice style")), scenes: Type.Optional(Type.Array(Type.String({ maxLength: 48 }), { maxItems: 200 })), speed: Type.Optional(Type.Number({ minimum: 0.6, maximum: 1.5, description: "1 = the style's calibrated pace (~170 wpm for documentary); lower is slower" })), fitScenes: Type.Optional(Type.Boolean()), tailSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })), cueLead: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, description: "seconds a cueWords cue lands before its word (default 0.08)" })), lexicon: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 128 }), { maxProperties: 64 })) }),
    narrationTts, 1_200_000);
  register("audio_synth",
    "Procedural audio for a video project, deterministic and seeded, CPU-light (numpy). kind music: an arranged bed with voice-led chords, a developed melody, bass, arpeggio, bells and style-set drums that enter layer by layer with an intensity arc taken from the timeline (scene `energy` bends it), sidechain pump, a real ending, wired into video.json with a bar grid for syncing motion. The look's music style is the default. kind sfx: whoosh, riser, downlifter, impact, tick, pop, chime, swell. kind sound_design: reads the timeline and places transition whooshes, riser+impact on reveal cues, chimes and like/follow pops as auto sfx in video.json.",
    Type.Object({ dir: localPath, kind: choices(["music", "sfx", "sound_design"]), name: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$" })), seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 ** 31 })), seconds: Type.Optional(Type.Number({ minimum: 0.02, maximum: 600 })),
      style: Type.Optional(choices(["curious", "focused", "driving", "reflective", "upbeat", "confident", "warm", "tense"], "music arrangement; defaults to the project look's")),
      bpm: Type.Optional(Type.Number({ minimum: 40, maximum: 180 })), key: Type.Optional(choices(["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"])), mode: Type.Optional(choices(["major", "minor", "dorian"])),
      progression: Type.Optional(Type.Array(Type.String({ pattern: "^(?:[iI]{1,3}|[iI]?[vV]|[vV][iI]{1,2})$" }), { minItems: 1, maxItems: 16 })), barsPerChord: Type.Optional(Type.Number({ minimum: 0.5, maximum: 8 })),
      swing: Type.Optional(Type.Number({ minimum: 0, maximum: 0.25 })), drumPattern: Type.Optional(choices(["none", "soft", "steady", "groove", "drive"])), melodyVoice: Type.Optional(choices(["glass", "ep", "pluck", "saw"])),
      layers: Type.Optional(Type.Object({ pad: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), bass: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), pulse: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), melody: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), bell: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), drums: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) })),
      intensity: Type.Optional(Type.Union([Type.Literal("auto"), Type.Array(Type.Array(Type.Number({ minimum: 0, maximum: 1800 }), { minItems: 2, maxItems: 2 }), { maxItems: 64 })], { description: "[[seconds, 0..1], …] or auto (default): follows the timeline" })),
      wire: Type.Optional(Type.Boolean({ description: "music: write audio.music and audio.musicBpm into video.json (default true)" })),
      type: Type.Optional(choices(SFX_TYPES, "sfx sound; required for kind sfx")), pitch: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })) }),
    audioSynth, 360_000);
}
