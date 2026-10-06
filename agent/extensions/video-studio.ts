/** Code-first video tools. Discovered on demand through tool_search; the
 * code-first-video skill owns the production workflow and review discipline. */
import { Type } from "typebox";
import { audioSynth, narrationTts, PIPER_VOICES, SFX_TYPES, VOICE_STYLES, videoProject, videoQa, videoRender } from "./lib/video-studio.ts";
import { LOOKS } from "./lib/video-looks.ts";
import { videoAssets } from "./lib/video-assets.ts";
import { SHOT_LIGHTS, SHOT_MATERIALS, SHOT_RIGS, SHOT_SHADOWS, videoShot } from "./lib/video-shot.ts";
import { copyMotionExample, MOTION_APPROACHES, motionExample, motionGuide, motionStarters, searchMotion } from "./lib/motion-library.ts";
import { PLATFORMS } from "./lib/video-publish.ts";
import { choices } from "./lib/tool-schema.ts";

const localPath = Type.String({ minLength: 1, maxLength: 4096 });

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
    "Create or validate a code-first video project: Remotion (React/TypeScript) scenes driven by one master timeline video.json (look, brand, publish settings, scenes, narration text/audio, scene-relative cues, transitions, music, sfx). init scaffolds reusable primitives and an art-directed look derived from the topic (palette, type pair, backdrop, captions, matching voice and music; follows the project's creative_direct avoid list), with brand and platform settings; check validates timing, narration fit, design defaults, publish readiness, registry and assets; look re-skins an existing project; cta places like/follow/comment moments on the finished timeline. The code-first-video skill offers optional workflow guidance.",
    Type.Object({ action: Type.Optional(choices(["init", "check", "install", "look", "cta", "feature"])), dir: localPath, title: Type.Optional(Type.String({ maxLength: 120 })),
      topic: Type.Optional(Type.String({ maxLength: 300, description: "init: subject in a few words; picks the look that fits it" })),
      look: Type.Optional(choices(["derive", "suggest", ...LOOKS.map((look) => look.id)], "init/look: omit or derive builds a look from the subject (palette, type pair, backdrop, captions, music, voice; deterministic per brief, re-rolled when it reads as a default or hits the creative direction's avoid list); suggest picks the closest curated look; a curated id uses it as is")),
      variation: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "init/look derive: another take on the same brief" })),
      accent: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$", description: "init/look derive: a brand colour to build the palette around" })),
      tone: Type.Optional(choices(["dark", "light"], "init/look derive: force the ground's tone")),
      format: Type.Optional(choices(["landscape", "vertical", "square"], "init: 1920x1080, 1080x1920 (Shorts, Reels, TikTok) or 1080x1080")),
      intent: Type.Optional(choices(["publish", "personal"], "init: publish (default) is built to perform for an audience; personal drops brand, calls to action and end screen")),
      platforms: Type.Optional(Type.Array(choices([...PLATFORMS]), { minItems: 1, maxItems: 7, description: "init: where it will be published. One platform gets its own wording (YouTube: Subscribe and a bell); several get generic Follow and Like" })),
      brand: Type.Optional(Type.Object({ name: Type.Optional(Type.String({ maxLength: 120 })), handle: Type.Optional(Type.String({ maxLength: 120 })), website: Type.Optional(Type.String({ maxLength: 120 })), tagline: Type.Optional(Type.String({ maxLength: 120 })), logo: Type.Optional(Type.String({ maxLength: 120, description: "path under public/" })) }, { description: "init: only what the user gave; nothing is invented" })),
      feature: Type.Optional(choices(["3d"], "feature: add opt-in 3D model support (three.js, Model3D primitive)")),
      commentPrompt: Type.Optional(Type.String({ maxLength: 140, description: "cta: the author's own question for a comment moment" })), sharePrompt: Type.Optional(Type.String({ maxLength: 140 })),
      captions: Type.Optional(Type.Boolean({ description: "init with intent personal: burn captions in (default off)" })),
      fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), install: Type.Optional(Type.Boolean()) }),
    async (params, cwd, signal, progress) => {
      const result = await videoProject(params, cwd, signal, progress);
      // A new project starts from worked motion: the starter kit rides on the init result.
      return params.action === "init" ? { ...result, motion: await motionStarters() } : result;
    }, 1_200_000);
  register("video_shot",
    "Render a Blender shot into a video project: a camera move around one subject (a .blend, an imported glb/obj/ply/stl/fbx, or extruded 3D title text) as an RGBA image sequence in public/shots/<name>/ with a manifest and per-frame screen positions of named anchors, lit and framed with the project's palette so the 3D belongs to the film. Rigs: turntable (loops), orbit, push-in, pull-out, crane, drift, static. Studio lights (softbox, rim, top, overcast) and a composited ground shadow keep EEVEE fast; Cycles catcher is slower. Play it with BlenderShot / the ShotScene component; ShotAnchor pins 2D callouts to 3D features (anchors: object names from the blend, or bbox:top|bottom|left|right|front|back|center). mode preview (default) is cheap and says so; final renders delivery quality. The blender-production and motion-approaches skills offer optional reference guidance.",
    Type.Object({ dir: localPath, name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$", description: "shot id; becomes public/shots/<name>" }),
      blend: Type.Optional(localPath), model: Type.Optional(localPath),
      title: Type.Optional(Type.Object({ text: Type.String({ minLength: 1, maxLength: 120 }), font: Type.Optional(localPath), depth: Type.Optional(Type.Number({ minimum: 0.01, maximum: 2 })), bevel: Type.Optional(Type.Number({ minimum: 0, maximum: 0.3 })) }, { description: "extruded 3D text; font must be a .ttf/.otf (Blender cannot read woff2)" })),
      rig: Type.Optional(choices([...SHOT_RIGS], "camera move; default turntable, orbit for titles")), seconds: Type.Optional(Type.Number({ minimum: 0.5, maximum: 20 })), fps: Type.Optional(Type.Number({ minimum: 4, maximum: 60 })),
      mode: Type.Optional(choices(["preview", "final"], "preview (default): half size, 12 fps, 16 samples; final: project size, project fps, 64 samples")),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 2160 })), scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2 })), samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
      engine: Type.Optional(choices(["EEVEE", "CYCLES"], "EEVEE default; CYCLES for glass, caustics or the shadow catcher")),
      lights: Type.Optional(choices([...SHOT_LIGHTS], "softbox (default), rim, top, overcast, or scene to keep the blend's own lights")), lightStrength: Type.Optional(Type.Number({ minimum: 0.1, maximum: 5 })),
      material: Type.Optional(choices([...SHOT_MATERIALS], "keep (blend/model materials) or replace with clay, satin, metal, glass or glow in `color`")), color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$", description: "material colour; defaults to the project accent" })),
      shadow: Type.Optional(choices([...SHOT_SHADOWS], "soft (default for blends and models): ground shadow composited per frame; none for floating subjects and titles; catcher uses Cycles")),
      transparent: Type.Optional(Type.Boolean({ description: "default true: RGBA frames to composite in the film; false flattens onto the palette background with a lit floor" })), background: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })), look: Type.Optional(Type.Boolean({ description: "false ignores the project's palette" })),
      azimuth: Type.Optional(Type.Number({ minimum: -360, maximum: 360 })), elevation: Type.Optional(Type.Number({ minimum: -80, maximum: 85 })), elevationEnd: Type.Optional(Type.Number({ minimum: -80, maximum: 85 })), degrees: Type.Optional(Type.Number({ minimum: 1, maximum: 720 })), travel: Type.Optional(Type.Number({ minimum: 0.2, maximum: 3, description: "push-in/pull-out: end distance as a fraction of start" })),
      ease: Type.Optional(choices(["inOut", "out", "in", "linear"])), lensMm: Type.Optional(Type.Number({ minimum: 18, maximum: 200 })), margin: Type.Optional(Type.Number({ minimum: 1, maximum: 3, description: "framing margin around the subject; 1.18 default" })),
      offset: Type.Optional(Type.Array(Type.Number({ minimum: -0.5, maximum: 0.5 }), { minItems: 2, maxItems: 2, description: "shift the subject in the frame [x, y] as fractions, to leave room for a headline" })), fStop: Type.Optional(Type.Number({ minimum: 0.7, maximum: 32 })), motionBlur: Type.Optional(Type.Boolean()),
      anchors: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 16 })), replace: Type.Optional(Type.Boolean({ description: "re-render over an existing shot of this name" })) }),
    videoShot, 3_600_000);
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
    "Local neural narration with Piper (no cloud, no generated images, capped threads). status lists engine/voices; install downloads the pinned engine and a checksum-verified voice once; speak turns standalone text into a fresh WAV plus measured/estimated word timings and SRT/VTT sidecars without a video project; synthesize speaks each video.json scene's narration into public/audio/narration with a style (documentary, calm, energetic, intimate), masters it to a common loudness, measures every word's start and end from the synthesized speech (captions use them) and writes durations back. cueWords in a scene ({\"reveal\": \"softmax\"}) re-time the named cue to that spoken word. fitScenes:true lengthens short scenes. lexicon maps display spellings to spoken respellings ({\"Vaswani\": \"Vas-wah-nee\", \"GPT\": \"G P T\"}); video.json keeps the display spelling for captions and on-screen text. A blank line in the narration adds a longer pause.",
    Type.Object({ action: Type.Optional(choices(["status", "install", "synthesize", "speak"])), text: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), outputDir: Type.Optional(localPath), dir: Type.Optional(localPath), voice: Type.Optional(choices(Object.keys(PIPER_VOICES))), style: Type.Optional(choices(Object.keys(VOICE_STYLES), "delivery; defaults to the project look's voice style")), scenes: Type.Optional(Type.Array(Type.String({ maxLength: 48 }), { maxItems: 200 })), speed: Type.Optional(Type.Number({ minimum: 0.6, maximum: 1.5, description: "1 = the style's calibrated pace (~170 wpm for documentary); lower is slower" })), fitScenes: Type.Optional(Type.Boolean()), tailSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })), cueLead: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, description: "seconds a cueWords cue lands before its word (default 0.08)" })), lexicon: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 128 }), { maxProperties: 64 })) }),
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
  register("motion_examples",
    "Worked, verified examples of advanced motion graphics in several approaches, each with the concepts it demonstrates: vanilla HTML/CSS/JS pages (seekable CSS and WAAPI timelines, @property, linear() springs, SVG morph and path-draw, SVG filter liquid, canvas flow fields, WebGL domain warping and SDF raymarching, audio-reactive fields, scroll-driven animation, CSS 3D, halftone transitions, kinetic type), Blender scripts (product hero with named anchors, procedural materials, camera rigs, 3D kinetic type, geometry-node terrain, an HTML sequence as a device screen), merges (HTML annotations pinned to Blender anchors, FFmpeg composite of a Blender shot over a rendered background), FFmpeg/libass kinetic type and numpy procedural frames. search: ranked by the words of the task (use it before writing a motion scene from memory); get: one example's concepts and, with source:true, its full file; copy: place it in a video project where the project looks for it (HTML in public/html for HtmlScene, Blender scripts in blender/scripts, tools in scripts) so you adapt a proven starting point to the film's look; approaches: the guide to choosing between them and combining them.",
    Type.Object({ action: Type.Optional(choices(["search", "get", "copy", "approaches"])), query: Type.Optional(Type.String({ maxLength: 300, description: "search: the effect or technique wanted, in a few words" })),
      approach: Type.Optional(choices([...MOTION_APPROACHES], "search: limit to one approach")), id: Type.Optional(Type.String({ maxLength: 120, description: "get/copy: an id from search, like html/webgl-domain-warp" })),
      source: Type.Optional(Type.Boolean({ description: "get: include the full file" })), dir: Type.Optional(localPath), name: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$", description: "copy: file name in the project (default: the example's own)" })),
      replace: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }),
    async (params, cwd) => {
      const action = params.action ?? "search";
      if (action === "approaches") return motionGuide();
      if (action === "get") return motionExample(String(params.id ?? ""), params.source === true);
      if (action === "copy") return copyMotionExample(params, cwd);
      return searchMotion(String(params.query ?? ""), params.approach, params.limit ?? 5);
    }, 60_000);
}
