/** Video tools. One film engine (cinetic's Remotion starter, three.js ready) behind
 * video_project and video_render, plus narration, generated audio, website takes and
 * QA that work on any footage, whatever made it. */
import { Type } from "typebox";
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { selectedMediaParams } from "./lib/media-model-routing.ts";
import { narrationTts, PIPER_VOICES, SFX_TYPES, VOICE_STYLES, videoQa } from "./lib/video-studio.ts";
import { filmCheck, filmInit, filmInstall, filmRender, filmStatus } from "./lib/film.ts";
import { choices } from "./lib/tool-schema.ts";
import { audioGenerate } from './lib/elevenlabs.ts';
import { videoBrowser } from './lib/video-browser.ts';
import { videoReviewRouting, installVideoReviewEvidence } from './lib/video-review-evidence.ts';

const localPath = Type.String({ minLength: 1, maxLength: 4096 });

export default function videoStudio(pi: any) {
  const reviews = installVideoReviewEvidence(pi);
  function register(name: string, description: string, parameters: any, handler: (params: any, cwd: string, signal?: AbortSignal, progress?: (text: string) => void) => Promise<any>, deadlineMs: number) {
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: string, params: any, signal: AbortSignal | undefined, update: ((partial: any) => void) | undefined, ctx: any) {
        const ownerManager = ctx?.sessionManager, ownerSession = ownerManager?.getSessionId?.();
        const deadline = AbortSignal.timeout(deadlineMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const progress = (text: string) => { try { update?.({ content: [{ type: "text", text }], details: { progress: text } }); } catch { /* progress is advisory */ } };
        if (name === 'narration_tts') params = selectedMediaParams(params, 'speech', ctx?.mediaModels);
        if (name === 'audio_generate') params = selectedMediaParams(params, params.kind, ctx?.mediaModels);
        if (name==='video_qa') await reviews.assertVisualReviews(params,ctx,bounded);
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded, progress);
        const reviewRouting = videoReviewRouting(result, ctx?.model?.input?.includes('image') !== false);
        if (reviewRouting) result.reviewRouting = reviewRouting;
        const content: any[] = [{ type: 'text', text: JSON.stringify(result) }];
        // Review evidence reaches vision-capable models in the tool response,
        // instead of relying on a later read that may never happen.
        if (result.contactSheet && ctx?.model?.input?.includes('image') !== false) {
          const pixels = await fs.readFile(result.contactSheet).catch(() => null);
          if (pixels && pixels.length <= 3*1024*1024) content.push({ type: 'image', mimeType: 'image/png', data: pixels.toString('base64') });
        } else if (result.contactSheet) {
          content.push({ type: 'text', text: 'The selected model has no image input. Keep this contact sheet for a configured vision reviewer or human review; technical findings do not establish visual quality.' });
        }
        const detail = result.detailFrame ?? result.stills?.[Math.floor(result.stills.length/2)]?.path;
        if (detail && ctx?.model?.input?.includes('image') !== false) {
          const pixels=await fs.readFile(detail).catch(()=>null);
          if(pixels && pixels.length<=3*1024*1024)content.push({type:'text',text:'Full-size detail evidence for silhouette, material and glyph review:'},{type:'image',mimeType:'image/png',data:pixels.toString('base64')});
        }
        if (ctx?.sessionManager === ownerManager && ownerManager?.getSessionId?.() === ownerSession) await reviews.observe(name, params, result, ctx,ctx?.model?.input?.includes('image') ? content.filter(part=>part.type==='image').map(part=>createHash('sha256').update(Buffer.from(part.data,'base64')).digest('hex')) : []);
        return { content, details: result };
      },
    });
  }
  register("video_project",
    "The harness's film engine, one option among any you judge better for the job: cinetic's Remotion starter (one src/timeline.ts drives picture, cues and sound; three.js, @remotion/three and @react-three/fiber installed). status reports what is ready; install sets up the Python tools its render and QA scripts need; init scaffolds a film in dir (format or size, fps, bpm, pace, name, fonts) and installs its pinned dependencies; check runs TypeScript, lint-film and the beat grid. Read the cinetic guide it names before building.",
    Type.Object({ action: choices(["status", "install", "init", "check"]), dir: Type.Optional(localPath),
      format: Type.Optional(choices(["landscape", "vertical", "square"], "init: 1920x1080, 1080x1920 or 1080x1080")), size: Type.Optional(Type.String({ pattern: "^\\d{3,4}x\\d{3,4}$", description: "init: WxH, overrides format" })),
      fps: Type.Optional(Type.Integer({ minimum: 12, maximum: 60 })), bpm: Type.Optional(Type.Integer({ minimum: 40, maximum: 200 })), pace: Type.Optional(choices(["calm", "crisp"])),
      name: Type.Optional(Type.String({ maxLength: 60 })), fonts: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9-]{2,60}$" }), { maxItems: 3, description: "init: @fontsource-variable family names to vendor" })),
      force: Type.Optional(Type.Boolean({ description: "init: allow a non-empty folder" })) }),
    async (params, cwd, signal, progress) => params.action === "status" ? filmStatus(signal) : params.action === "install" ? filmInstall(signal, progress)
      : params.action === "init" ? filmInit(params, cwd, signal, progress) : filmCheck(params, cwd, signal), 1_200_000);
  register("video_render",
    "Render a film made with video_project. stills: chosen frames (or count evenly spaced, default 6) through one bundle and one browser, with a labelled contact sheet. preview: cinetic's render.sh fast check render with the soundtrack muxed and its sync and spec gates. final: the motion-blurred master (budget caps the blur cost). Returns the output, a contact sheet and render.sh's log.",
    Type.Object({ dir: localPath, mode: Type.Optional(choices(["stills", "preview", "final"])), composition: Type.Optional(Type.String({ maxLength: 60 })),
      frames: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 24 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
      audio: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "preview and final: soundtrack file inside the workspace, relative to the film folder; default public/audio/soundtrack.wav when present" })), budget: Type.Optional(Type.Number({ minimum: 1, maximum: 64 })),
      flags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12, description: "preview and final only (stills rejects them): render.sh options, one option per entry or 'option value' pairs, e.g. '--frames 0-299' or '--frames', '0-299'. Allowed: --frames A-B, --accept-fast A-B, --accept-cut A-B, --floor A-B:N, --measure ARGS (measure-speed.py options such as --max 64), --crf N, --concurrency N, --10bit, --keep, --no-check" })) }),
    filmRender, 5_500_000);
  register("video_qa",
    "Audit a rendered video. listen proves narration and mix without human ears: local speech recognition transcribes the master (word error rate against script when given: a .txt, .md or narration .json path, or the spoken text itself; the first listen sets up speech recognition), and it measures speech over music (narration+music stems, else an estimate from the master) and loudness against targetLufs; it writes <file>.listen.json. analyze covers black and frozen stretches, audio/video duration drift, mid-video silence, EBU R128 loudness/peak/range against a target (default -16 LUFS), per-scene narration audibility, project/delivery mismatch and cue/exit/transition evidence with exact endpoint frames. analyze returns a labelled evidence strip. record requires current film/reference pixels delivered to vision or inspected by image_understand/read, then stores explicit art-direction/composition/typography against the full brief and named references, playback/motion/sync and listening verdicts on its report; status rejects stale evidence after video, project, sampled pixels or local reference changes. supersede explicitly retires a rejected delivery in favor of an existing replacement, preserving the rejected file and requiring fresh review of the replacement. Records are review attestations, not automated artistic approval. Automated passes find technical defects only.",
    Type.Object({ action:Type.Optional(choices(['analyze','listen','record','status','supersede'])), script:Type.Optional(localPath), narration:Type.Optional(localPath), music:Type.Optional(localPath), model:Type.Optional(choices(['small.en','base.en','medium','large-v3-turbo'])), report:Type.Optional(localPath), replacement:Type.Optional(localPath), reason:Type.Optional(Type.String({maxLength:1200})), reviewer:Type.Optional(Type.String({minLength:1,maxLength:120})), reviews:Type.Optional(Type.Array(Type.Object({criterion:choices(['art-direction','composition','typography','motion','sync','audio']),verdict:choices(['pass','fail','unreviewed']),evidence:choices(['frames','sequence','measured','playback','listening']),note:Type.String({minLength:1,maxLength:1200}),comparedReferences:Type.Optional(Type.Array(localPath,{maxItems:8}))}),{minItems:1,maxItems:6})), path: localPath, references:Type.Optional(Type.Array(localPath,{maxItems:8})), dir: Type.Optional(localPath), targetLufs: Type.Optional(Type.Number({ minimum: -30, maximum: -8 })), checkMotion:Type.Optional(Type.Boolean({description:'Decode a bounded motion window with original timestamps; native atmosphere v2 includes this automatically'})), loop:Type.Optional(Type.Boolean({description:'Inspect the actual delivery last-to-first boundary; does not establish audio or artistic approval'})), startScene: Type.Optional(Type.Integer({ minimum: 0, maximum: 1999, description: 'Review 8 scenes per evidence strip; continue with returned nextScene for long films' })) }),
    videoQa, 3_700_000);
  register("narration_tts",
    "Narration. backend auto (default) uses ElevenLabs when ELEVENLABS_API_KEY is set, otherwise local Piper, and falls back to Piper once when ElevenLabs rejects the key, credits or rate limit; backend elevenlabs never falls back or retries a paid request. A speech model configured in /models Speech is used when selected. status lists providers; voices lists ElevenLabs voice IDs; install sets up Piper; speak returns a WAV, aligned words and SRT/VTT for text up to 120 s (one call per line or paragraph); recover reassembles saved ElevenLabs checkpoints without a paid request.",
    Type.Object({ action: Type.Optional(choices(["status", "voices", "install", "speak", "recover"])), backend: Type.Optional(choices(['auto', 'elevenlabs', 'piper'])), voiceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), language: Type.Optional(Type.String({ pattern: '^[a-z]{2}$' })), stability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), expressiveness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), text: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), outputDir: Type.Optional(localPath), dir: Type.Optional(localPath), voice: Type.Optional(choices(Object.keys(PIPER_VOICES))), style: Type.Optional(choices(Object.keys(VOICE_STYLES), "Delivery preset for Piper or ElevenLabs; explicit stability/expressiveness override cloud presets")), speed: Type.Optional(Type.Number({ minimum: 0.6, maximum: 1.5, description: "Piper 0.6..1.5; ElevenLabs 0.7..1.2" })), lexicon: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 128 }), { maxProperties: 64 })) }),
    narrationTts, 1_200_000);
  register('audio_generate', 'Generate an instrumental music bed or prompt-directed sound effect through ElevenLabs, using /models Audio defaults. Local selections use procedural audio; cloud selections use ElevenLabs. Music supports exact model and 3..600 seconds; SFX 0.5..30 seconds and loop intent. Returns decoded artifact and measured duration; use audio_mix role:music for ducking. Longer films use arranged sections. Requires private ELEVENLABS_API_KEY; no automatic paid retry or fallback.',
    Type.Object({ dir: Type.Optional(localPath), style: Type.Optional(Type.String({ maxLength: 32 })), sfxType: Type.Optional(choices([...SFX_TYPES])), bpm: Type.Optional(Type.Number({ minimum: 40, maximum: 180 })), seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })), kind: choices(['music', 'sfx']), prompt: Type.String({ minLength: 1, maxLength: 4100 }), seconds: Type.Optional(Type.Number({ minimum: 0.5, maximum: 600 })), model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), instrumental: Type.Optional(Type.Boolean()), loop: Type.Optional(Type.Boolean()), influence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), outputDir: Type.Optional(localPath) }), async (p, cwd, signal) => {
      if (p.mediaProvider === 'local') {
        const { audioSynthStandalone } = await import('./lib/video-studio.ts');
        return audioSynthStandalone(p, cwd, signal);
      }
      return audioGenerate(p, cwd, signal);
    }, 650_000);
  register('video_browser', 'Capture a real website take with human-paced pointer movement, click rings, scrolling, typing and observed targets. Supply a URL or self-contained local HTML, seconds (1..120), and ordered timed steps. Fresh sandboxed Chromium profile, bounded real-time CDP capture, constant-frame MP4, and take.json with actual click/key/target times and source-frame timestamps. device:phone records mobile layout and touch input; tap rings and highlight steps emphasize observed controls. The returned take.json carries the observed event clock: drop the take into the public/ folder of the film and time callouts and sound to those events. Split longer walkthroughs into takes. Observe selectors with browser_session first; no logged-in profile is imported.',
    Type.Object({ url: Type.Optional(Type.String({ maxLength: 2048 })), path: Type.Optional(localPath), seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 1080 })), cursor: Type.Optional(Type.Boolean()), device: Type.Optional(choices(['desktop','phone'])), accent: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })), outputDir: Type.Optional(localPath), steps: Type.Optional(Type.Array(Type.Object({ action: choices(['move', 'click', 'tap', 'highlight', 'scroll', 'type', 'press', 'mark', 'wait_text']), at: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), duration: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })), selector: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), dx: Type.Optional(Type.Number()), dy: Type.Optional(Type.Number()), text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })), key: Type.Optional(Type.String({ maxLength: 100, description: 'press: key name, e.g. Enter; text is also accepted' })) }), { maxItems: 100 })) }), videoBrowser, 400_000);
}
