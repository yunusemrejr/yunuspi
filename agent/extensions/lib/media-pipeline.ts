/** Reusable data-only media production. Select the stages from the requested
 * artifacts; render video/audio once, then reuse their probe/decode receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { composeMusic, planScoreRender } from './music-score.ts';
import { audioMix, videoCompose, prepareAudioMix, prepareVideoCompose, cachedProbe, duckingOptions, loopBudget } from './media-timeline.ts';
import { measureAudio } from './audio-studio.ts';
import { sceneRender, readSceneJson } from './scene-studio.ts';
import { prepareSvgSource, svgRender } from './svg-render.ts';
import { planNarration, narrationSpeak } from './video-studio.ts';
import { retainedSpeechError } from './elevenlabs.ts';
import { inputFile, number, outputFolder } from './media-process.ts';
import { validateScene, SCENE_LIMITS } from '../../scripts/scene-model.mjs';

export function planMediaPipeline(params: any) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('pipeline must be an object');
  const allowed = ['clips', 'animation', 'animationTracks', 'narration', 'score', 'scoreRender', 'scoreGain', 'tracks', 'duration', 'transition', 'transitionDuration', 'includeClipAudio', 'ducking', 'targetLufs', 'width', 'height', 'fps', 'outputDir'];
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw Error(`Unknown pipeline field: ${key}`);
  if (params.clips !== undefined && (!Array.isArray(params.clips) || !params.clips.length || params.clips.length > 8)) throw Error('clips accepts 1..8 entries');
  if (params.tracks !== undefined && (!Array.isArray(params.tracks) || params.tracks.length > 8)) throw Error('tracks accepts 0..8 entries');
  if (params.animation !== undefined && params.clips !== undefined) throw Error('Provide animation or clips, not both');
  const mode = params.animation !== undefined ? 'animation' : params.clips !== undefined ? 'video' : 'audio';
  const svg = typeof params.animation === 'string' && /\.svg$/i.test(params.animation);
  if (params.animationTracks !== undefined && !svg) throw Error('animationTracks requires an SVG animation');
  if (params.narration !== undefined) { if (!params.narration || typeof params.narration !== 'object' || Array.isArray(params.narration)) throw Error('narration must be an object'); planNarration(params.narration); }
  if (mode === 'audio' && !params.score && !params.tracks?.length && !params.narration) throw Error('Audio pipeline needs a score or tracks or narration');
  if ((params.tracks?.length ?? 0) + (params.score ? 1 : 0) + (params.narration ? 1 : 0) > 8) throw Error('The score and tracks together, including narration, accept at most 8 tracks');
  // Validate score/target before creating any output or running synthesis.
  if (params.scoreRender !== undefined) {
    if (!params.score || !params.scoreRender || typeof params.scoreRender !== 'object' || Array.isArray(params.scoreRender)) throw Error('scoreRender requires a score and renderer options');
    for (const key of Object.keys(params.scoreRender)) if (!['backend', 'soundfont', 'releaseTail'].includes(key)) throw Error(`Unknown scoreRender field: ${key}`);
    if (params.scoreRender.backend && !['auto', 'soundfont', 'oscillator'].includes(params.scoreRender.backend)) throw Error('Invalid scoreRender backend');
    if (params.scoreRender.releaseTail !== undefined) number(params.scoreRender.releaseTail, 1.5, 0, 5, 'releaseTail');
  }
  if (params.score !== undefined) planScoreRender({ ...params.scoreRender, score: params.score });
  if (params.scoreGain !== undefined && params.score === undefined) throw Error('scoreGain requires a score');
  if (params.scoreGain !== undefined) number(params.scoreGain, 0.3, 0, 4, 'scoreGain');
  if (params.targetLufs !== undefined) number(params.targetLufs, -16, -36, -8, 'targetLufs');
  if (params.duration !== undefined) {
    number(params.duration, 30, 0.1, 120, 'duration');
    if (mode !== 'audio' && !svg) throw Error('duration is for audio pipelines or SVG; clips or scene JSON define video duration');
    if (svg && params.duration > 30) throw Error('SVG animation duration is bounded to 30 seconds');
  }
  if (mode !== 'video' && ['transition', 'transitionDuration', 'includeClipAudio'].some(key => params[key] !== undefined)) throw Error('Clip transition/audio options require clips');
  if (mode === 'audio' && ['width', 'height', 'fps'].some(key => params[key] !== undefined)) throw Error('Resolution options require clips or animation');
  const hasAudio = mode === 'audio' || Boolean(params.score || params.narration || params.tracks?.length) || (mode === 'video' && params.includeClipAudio !== false);
  if (params.targetLufs !== undefined && !hasAudio) throw Error('Loudness normalization requires audio');
  if (params.ducking !== undefined && params.ducking !== false && !hasAudio) throw Error('Ducking requires both voice and music tracks');
  return { mode, ...(svg ? { svg: true } : {}), stages: [...(params.narration ? ['synthesize_narration'] : []), ...(params.score ? ['compose_score'] : []), ...(mode !== 'video' && hasAudio ? ['mix_audio'] : []), ...(mode === 'video' ? ['compose_video'] : mode === 'animation' ? ['render_animation'] : []), ...(hasAudio ? ['measure_delivery_audio'] : [])], hasAudio };
}

export async function mediaPipeline(params: any, cwd: string, signal?: AbortSignal) {
  const started = performance.now(), plan = planMediaPipeline(params);
  const scorePlan = params.score === undefined ? undefined : planScoreRender({ ...params.scoreRender, score: params.score });
  const scoreRender = scorePlan ? { backend: scorePlan.backend, soundfont: scorePlan.soundfont, releaseTail: scorePlan.releaseTail } : undefined;
  if (scorePlan?.backend === 'soundfont') {
    const bank = await inputFile(scorePlan.soundfont, cwd);
    if (!/\.sf[23]$/i.test(bank) || (await fs.stat(bank)).size > 512*1024*1024) throw Error('Use a local SF2/SF3 SoundFont up to 512 MiB');
    scoreRender!.soundfont = bank;
  }
  signal?.throwIfAborted();
  let animation: any, svgSource: any, animationFile: string | undefined, animationSnapshot: string | undefined;
  if (params.animation !== undefined) {
    const file = await inputFile(params.animation, cwd);
    animationFile = file;
    if (plan.svg) { svgSource = await prepareSvgSource({ path: file, mode: 'video', tracks: params.animationTracks, width: params.width, height: params.height, fps: params.fps, duration: params.duration }, cwd); animation = svgSource.plan; }
    else {
      animation = validateScene({ ...await readSceneJson(file), ...(params.width === undefined ? {} : { width: params.width }), ...(params.height === undefined ? {} : { height: params.height }), ...(params.fps === undefined ? {} : { fps: params.fps }) });
      animationSnapshot = JSON.stringify(animation);
      if (Buffer.byteLength(animationSnapshot) > SCENE_LIMITS.jsonBytes) throw Error('Validated scene snapshot exceeds 256 KiB');
    }
  }
  // Resolve every source and edit option before synthesizing or allocating
  // output. The same call-local probe promises serve preflight and rendering.
  const inspect = cachedProbe(signal);
  const duration = animation ? Math.ceil(animation.duration * animation.fps) / animation.fps : params.duration ?? scorePlan?.score.seconds ?? 30;
  const sourceOptions = { tracks: params.tracks ?? [], duration, ducking: false };
  const prepared = plan.mode === 'video'
    ? await prepareVideoCompose({ clips: params.clips, audio: params.tracks, transition: params.transition, transitionDuration: params.transitionDuration, includeClipAudio: params.includeClipAudio, width: params.width, height: params.height, fps: params.fps, ducking: false }, cwd, signal, inspect)
    : (params.tracks?.length ? await prepareAudioMix(sourceOptions, cwd, signal, inspect) : undefined);
  if (plan.mode !== 'video' && plan.hasAudio) number(duration, 30, 0.1, 120, 'duration');
  const roles = [...(prepared && 'extraTracks' in prepared ? [...prepared.clipRoles, ...prepared.extraTracks.map(track => track.role)] : prepared?.tracks.map(track => track.role) ?? []), ...(params.score ? ['music'] : []), ...(params.narration ? ['voice'] : [])];
  if (params.score) loopBudget([
    ...(prepared && 'extraTracks' in prepared ? prepared.extraTracks : prepared?.tracks ?? []),
    { loop: true, sourceDuration: Math.min(scorePlan!.score.seconds, prepared && 'requestedDuration' in prepared ? prepared.requestedDuration : duration) },
  ]);
  duckingOptions(params.ducking, roles);
  if (params.targetLufs !== undefined && !roles.length) throw Error('Loudness normalization requires audio');
  signal?.throwIfAborted();
  const dir = await outputFolder(params.outputDir, cwd);
  const stages: Array<{ name: string; elapsedMs: number }> = [];
  let narration: any;
  const stage = async (name: string, work: () => Promise<any>) => {
    signal?.throwIfAborted();
    const at = performance.now(), result = await work();
    stages.push({ name, elapsedMs: Math.round(performance.now() - at) });
    return result;
  };
  try {
    // Render exactly the scene that established the audio clock. A concurrent
    // edit while narration/music runs must not change geometry or duration.
    const sceneSnapshot = animationSnapshot === undefined ? undefined : path.join(dir, 'animation.scene.json');
    if (sceneSnapshot) await fs.writeFile(sceneSnapshot, animationSnapshot!, { flag: 'wx', mode: 0o600 });
    const tracks = [...(params.tracks ?? [])];
    let score: any;
    if (params.narration) {
      narration = await stage('synthesize_narration', () => narrationSpeak({ ...params.narration, outputDir: dir }, cwd, signal));
      const deliveryDuration = prepared && 'requestedDuration' in prepared ? prepared.requestedDuration : duration;
      if (narration.seconds > deliveryDuration + 0.05) throw Error(`Narration lasts ${narration.seconds}s and exceeds the ${deliveryDuration}s timeline; shorten text or extend the timeline`);
      tracks.push({ path: narration.artifact.path, role: 'voice' });
    }
    if (params.score) {
      score = await stage('compose_score', () => composeMusic({ ...scoreRender, score: params.score, outputDir: dir }, cwd, signal));
      tracks.push({ path: score.files.find((file: any) => file.path.endsWith('.wav')).path, role: 'music', gain: params.scoreGain ?? 0.3, loop: true });
    }
    const mixOptions = { tracks, ducking: params.ducking, targetLufs: params.targetLufs, outputDir: dir };
    let rendered: any, artifact: any, mastering: any;
    if (plan.mode === 'video') {
      rendered = await stage('compose_video', () => videoCompose({ clips: params.clips, transition: params.transition, transitionDuration: params.transitionDuration, includeClipAudio: params.includeClipAudio, audio: tracks, ducking: params.ducking, targetLufs: params.targetLufs, width: params.width, height: params.height, fps: params.fps, outputDir: dir }, cwd, signal, inspect));
      artifact = rendered.artifact;
    } else {
      let mixed: any;
      if (tracks.length) mixed = await stage('mix_audio', () => audioMix({ ...mixOptions, duration }, cwd, signal, inspect));
      if (plan.mode === 'animation') {
        rendered = await stage('render_animation', () => plan.svg ? svgRender({ svg: svgSource.xml, tracks: svgSource.tracks, mode: 'video', duration: animation.duration, audio: mixed?.artifact.path, width: animation.width, height: animation.height, fps: animation.fps, outputDir: dir }, cwd, signal) : sceneRender({ path: sceneSnapshot, mode: 'video', audio: mixed?.artifact.path, outputDir: dir }, cwd, signal));
        artifact = rendered.video;
        rendered.ducking = mixed?.ducking ?? false;
        mastering = mixed?.loudness;
      } else { rendered = mixed; artifact = mixed.artifact; }
    }
    const hasAudio = rendered.output.streams?.some((stream: any) => stream.codec_type === 'audio') ?? false;
    // A mastered file already carries measurements of its delivery encoding.
    // Animation adds AAC encoding after mixing, so measure that final file.
    const measurements = hasAudio ? await stage('measure_delivery_audio', async () => plan.mode !== 'animation' && rendered.loudness ? rendered.loudness.after : (await measureAudio(artifact.path, params.targetLufs ?? -16, signal)).measurement) : undefined;
    if (mastering) mastering = { ...mastering, after: measurements, note: 'WAV normalized before animation rendering; after values measure the final AAC encoding' };
    else mastering = rendered.loudness;
    const visual = plan.mode === 'animation' ? {
      source: animationFile, snapshot: sceneSnapshot ?? rendered.source,
      sourceHash: createHash('sha256').update(animationSnapshot ?? svgSource.xml).digest('hex'),
      ...(rendered.contactSheet ? { contactSheet: rendered.contactSheet } : {}),
      ...(rendered.tracks ? { tracks: rendered.tracks } : {}),
      ...(rendered.diagnostics ? { diagnostics: rendered.diagnostics, diagnosticsTruncated: rendered.diagnosticsTruncated, omittedDiagnosticObservations: rendered.omittedDiagnosticObservations } : {}),
      ...(rendered.motion ? { motion: rendered.motion } : {}),
    } : undefined;
    const result = { pipeline: plan.mode, artifact, duration: rendered.duration, decodeVerified: rendered.decodeVerified === true, ducking: rendered.ducking ?? false, ...(narration ? { narration } : {}), ...(score ? { score: { files: score.files, seconds: score.seconds, bpm: score.bpm } } : {}), ...(measurements ? { audio: measurements } : {}), ...(mastering ? { mastering } : {}), ...(visual ? { visual } : {}), ...(rendered.samples ? { samples: rendered.samples, poster: rendered.poster } : {}), automatedChecks: { decode: rendered.decodeVerified === true, loudnessWithinTarget: params.targetLufs === undefined || !measurements ? null : measurements.integratedLufs !== null && Math.abs(measurements.integratedLufs - params.targetLufs) <= 1, truePeakWithinCeiling: !measurements || measurements.truePeakDbtp === null ? null : measurements.truePeakDbtp <= -1 }, stages, elapsedMs: Math.round(performance.now() - started), review: 'Inspect representative frames and motion for video; listen to the final mix. Decode and loudness measurements establish technical output, not artistic quality.' };
    await fs.writeFile(path.join(dir, 'pipeline.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    const tagged = error instanceof Error && typeof (error as any).retainedSpeechCache === 'string' ? error : undefined;
    const retained = tagged ?? (narration?.provider === 'elevenlabs' && narration.artifact?.path ? await retainedSpeechError(path.dirname(narration.artifact.path), error) : undefined);
    if (retained) {
      const recovery = path.join(dir, 'pipeline-recovery.json');
      const receipt = { pipeline: plan.mode, completedStages: stages, error: error instanceof Error ? error.message : String(error), retainedSpeechCache: (retained as any).retainedSpeechCache,
        submissionOutcomeUnknown: (retained as any).submissionOutcomeUnknown === true,
        ...(narration ? { narration: { artifact: narration.artifact, seconds: narration.seconds, captions: narration.captions }, reuse: "Use the retained narration artifact as a role:voice track and omit narration when rerunning the pipeline; this avoids another paid speech request." }
          : { recovery: { tool: 'narration_tts', arguments: { action: 'recover', dir: (retained as any).retainedSpeechCache } }, reuse: "Run narration_tts action:recover on the retained cache; this cannot submit paid work. For an unknown submission outcome, inspect the checkpoint and provider history before regeneration." }) };
      let receiptWritten = false;
      try { await fs.writeFile(recovery, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); receiptWritten = true; }
      catch { /* Preserve paid checkpoints even if the recovery receipt cannot be written. */ }
      throw Object.assign(new Error(`${retained.message}; pipeline retained at ${dir}.${receiptWritten ? ` Recovery receipt: ${recovery}` : ' Could not write a recovery receipt; inspect the retained speech cache.'}`, { cause: retained }), { retainedSpeechCache: (retained as any).retainedSpeechCache, ...(receiptWritten ? { pipelineRecovery: recovery } : {}), ...((retained as any).submissionOutcomeUnknown ? { submissionOutcomeUnknown: true } : {}) });
    }
    await fs.rm(dir, { recursive: true, force: true }); throw error;
  }
}
