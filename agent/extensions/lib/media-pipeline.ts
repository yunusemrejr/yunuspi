/** Reusable data-only media production. Select the stages from the requested
 * artifacts; render video/audio once, then reuse their probe/decode receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateScore, composeMusic } from './music-score.ts';
import { audioMix, videoCompose, prepareAudioMix, prepareVideoCompose, cachedProbe, duckingOptions, loopBudget } from './media-timeline.ts';
import { measureAudio } from './audio-studio.ts';
import { sceneRender } from './scene-studio.ts';
import { inputFile, number, outputFolder } from './media-process.ts';
import { validateScene, SCENE_LIMITS } from '../../scripts/scene-model.mjs';

export function planMediaPipeline(params: any) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('pipeline must be an object');
  const allowed = ['clips', 'animation', 'score', 'scoreGain', 'tracks', 'duration', 'transition', 'transitionDuration', 'includeClipAudio', 'ducking', 'targetLufs', 'width', 'height', 'fps', 'outputDir'];
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw Error(`Unknown pipeline field: ${key}`);
  if (params.clips !== undefined && (!Array.isArray(params.clips) || !params.clips.length || params.clips.length > 8)) throw Error('clips accepts 1..8 entries');
  if (params.tracks !== undefined && (!Array.isArray(params.tracks) || params.tracks.length > 8)) throw Error('tracks accepts 0..8 entries');
  if (params.animation !== undefined && params.clips !== undefined) throw Error('Provide animation or clips, not both');
  const mode = params.animation !== undefined ? 'animation' : params.clips !== undefined ? 'video' : 'audio';
  if (mode === 'audio' && !params.score && !params.tracks?.length) throw Error('Audio pipeline needs a score or tracks');
  if ((params.tracks?.length ?? 0) + (params.score ? 1 : 0) > 8) throw Error('The score and tracks together accept at most 8 tracks');
  // Validate score/target before creating any output or running synthesis.
  if (params.score !== undefined) validateScore(params.score);
  if (params.scoreGain !== undefined && params.score === undefined) throw Error('scoreGain requires a score');
  if (params.scoreGain !== undefined) number(params.scoreGain, 0.3, 0, 4, 'scoreGain');
  if (params.targetLufs !== undefined) number(params.targetLufs, -16, -36, -8, 'targetLufs');
  if (params.duration !== undefined) {
    number(params.duration, 30, 0.1, 120, 'duration');
    if (mode !== 'audio') throw Error('duration is for audio pipelines; clips or animation define video duration');
  }
  if (mode !== 'video' && ['transition', 'transitionDuration', 'includeClipAudio'].some(key => params[key] !== undefined)) throw Error('Clip transition/audio options require clips');
  if (mode === 'audio' && ['width', 'height', 'fps'].some(key => params[key] !== undefined)) throw Error('Resolution options require clips or animation');
  const hasAudio = mode === 'audio' || Boolean(params.score || params.tracks?.length) || (mode === 'video' && params.includeClipAudio !== false);
  if (params.targetLufs !== undefined && !hasAudio) throw Error('Loudness normalization requires audio');
  if (params.ducking !== undefined && params.ducking !== false && !hasAudio) throw Error('Ducking requires both voice and music tracks');
  return { mode, stages: [...(params.score ? ['compose_score'] : []), ...(mode !== 'video' && hasAudio ? ['mix_audio'] : []), ...(mode === 'video' ? ['compose_video'] : mode === 'animation' ? ['render_animation'] : []), ...(hasAudio ? ['measure_delivery_audio'] : [])], hasAudio };
}

export async function mediaPipeline(params: any, cwd: string, signal?: AbortSignal) {
  const started = performance.now(), plan = planMediaPipeline(params);
  signal?.throwIfAborted();
  let animation: any;
  if (params.animation !== undefined) {
    const file = await inputFile(params.animation, cwd);
    if ((await fs.stat(file)).size > SCENE_LIMITS.jsonBytes) throw Error('Scene JSON exceeds 256 KiB');
    animation = validateScene({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...(params.width === undefined ? {} : { width: params.width }), ...(params.height === undefined ? {} : { height: params.height }), ...(params.fps === undefined ? {} : { fps: params.fps }) });
  }
  // Resolve every source and edit option before synthesizing or allocating
  // output. The same call-local probe promises serve preflight and rendering.
  const inspect = cachedProbe(signal);
  const duration = animation ? Math.ceil(animation.duration * animation.fps) / animation.fps : params.duration ?? (params.score ? validateScore(params.score).seconds : 30);
  const sourceOptions = { tracks: params.tracks ?? [], duration, ducking: false };
  const prepared = plan.mode === 'video'
    ? await prepareVideoCompose({ clips: params.clips, audio: params.tracks, transition: params.transition, transitionDuration: params.transitionDuration, includeClipAudio: params.includeClipAudio, width: params.width, height: params.height, fps: params.fps, ducking: false }, cwd, signal, inspect)
    : (params.tracks?.length ? await prepareAudioMix(sourceOptions, cwd, signal, inspect) : undefined);
  if (plan.mode !== 'video' && plan.hasAudio) number(duration, 30, 0.1, 120, 'duration');
  const roles = [...(prepared && 'extraTracks' in prepared ? [...prepared.clipRoles, ...prepared.extraTracks.map(track => track.role)] : prepared?.tracks.map(track => track.role) ?? []), ...(params.score ? ['music'] : [])];
  if (params.score) loopBudget([
    ...(prepared && 'extraTracks' in prepared ? prepared.extraTracks : prepared?.tracks ?? []),
    { loop: true, sourceDuration: Math.min(validateScore(params.score).seconds, prepared && 'requestedDuration' in prepared ? prepared.requestedDuration : duration) },
  ]);
  duckingOptions(params.ducking, roles);
  if (params.targetLufs !== undefined && !roles.length) throw Error('Loudness normalization requires audio');
  signal?.throwIfAborted();
  const dir = await outputFolder(params.outputDir, cwd);
  const stages: Array<{ name: string; elapsedMs: number }> = [];
  const stage = async (name: string, work: () => Promise<any>) => {
    signal?.throwIfAborted();
    const at = performance.now(), result = await work();
    stages.push({ name, elapsedMs: Math.round(performance.now() - at) });
    return result;
  };
  try {
    const tracks = [...(params.tracks ?? [])];
    let score: any;
    if (params.score) {
      score = await stage('compose_score', () => composeMusic({ score: params.score, outputDir: dir }, cwd, signal));
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
        rendered = await stage('render_animation', () => sceneRender({ path: params.animation, mode: 'video', audio: mixed?.artifact.path, width: params.width, height: params.height, fps: params.fps, outputDir: dir }, cwd, signal));
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
    const result = { pipeline: plan.mode, artifact, duration: rendered.duration, decodeVerified: rendered.decodeVerified === true, ducking: rendered.ducking ?? false, ...(score ? { score: { files: score.files, seconds: score.seconds, bpm: score.bpm } } : {}), ...(measurements ? { audio: measurements } : {}), ...(mastering ? { mastering } : {}), ...(rendered.samples ? { samples: rendered.samples, poster: rendered.poster } : {}), automatedChecks: { decode: rendered.decodeVerified === true, loudnessWithinTarget: params.targetLufs === undefined || !measurements ? null : measurements.integratedLufs !== null && Math.abs(measurements.integratedLufs - params.targetLufs) <= 1, truePeakWithinCeiling: !measurements || measurements.truePeakDbtp === null ? null : measurements.truePeakDbtp <= -1 }, stages, elapsedMs: Math.round(performance.now() - started), review: 'Inspect representative frames and motion for video; listen to the final mix. Decode and loudness measurements establish technical output, not artistic quality.' };
    await fs.writeFile(path.join(dir, 'pipeline.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    signal?.throwIfAborted();
    return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
