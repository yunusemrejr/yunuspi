/** Data-only FFmpeg timeline construction. No user filters, shell or remote inputs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, outputFolder, probe, produced, requireStream, run, mediaMap } from './media-process.ts';
import { masterMedia } from './audio-studio.ts';

function fields(value: any, allowed: string[], name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unknown ${name} field: ${key}`);
}
function array(value: any, name: string, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > 8) throw Error(`${name} accepts ${min}..8 entries`);
  return value;
}
function sourceDuration(info: any, stream: any) {
  const seconds = Number(stream.duration ?? info.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw Error('Source duration is unknown; use a finalized local media file');
  return seconds;
}
export type MediaInspector = (file: string, signal?: AbortSignal) => Promise<any>;
export function cachedProbe(signal?: AbortSignal): MediaInspector {
  const files = new Map<string, Promise<any>>();
  return (file: string, active = signal) => {
    active?.throwIfAborted();
    if (!files.has(file)) files.set(file, probe(file, active));
    return files.get(file)!;
  };
}
async function audioTrack(raw: any, cwd: string, total: number, inspect: (file: string) => Promise<any>) {
  fields(raw, ['path', 'start', 'at', 'duration', 'gain', 'pan', 'fadeIn', 'fadeOut', 'highpass', 'lowpass', 'delayMs', 'role', 'loop', 'speed', 'denoise'], 'audio track');
  const file = await inputFile(raw.path, cwd), info = await inspect(file), stream = requireStream(info, 'audio');
  const start = number(raw.start, 0, 0, 86400, 'audio start'), at = number(raw.at, 0, 0, 120, 'audio at');
  const remaining = sourceDuration(info, stream) - start;
  if (raw.loop !== undefined && typeof raw.loop !== 'boolean') throw Error('loop must be boolean');
  const speed = number(raw.speed, 1, 0.5, 2, 'speed');
  const duration = number(raw.duration, Math.min(raw.loop ? total : remaining / speed, total - at), 0.01, 120, 'audio duration');
  if (remaining <= 0 || (!raw.loop && duration * speed > remaining + 0.02) || at + duration > total + 0.0001) throw Error('Audio track exceeds its source or timeline duration');
  const role = raw.role ?? 'effect';
  if (!['voice', 'music', 'effect'].includes(role)) throw Error('role must be voice, music or effect');
  const denoise = raw.denoise === undefined ? undefined : number(raw.denoise, 12, 0, 30, 'denoise');
  const highpass = raw.highpass === undefined ? undefined : number(raw.highpass, 0, 20, 5000, 'highpass');
  const lowpass = raw.lowpass === undefined ? undefined : number(raw.lowpass, 0, 200, 20000, 'lowpass');
  if (highpass !== undefined && lowpass !== undefined && highpass >= lowpass) throw Error('highpass must be below lowpass');
  return { file, stream: stream.index, start, at, duration, sourceDuration: Math.min(remaining, duration * speed), speed, loop: raw.loop ?? false, role, denoise, gain: number(raw.gain, 1, 0, 4, 'gain'), pan: number(raw.pan, 0, -1, 1, 'pan'), fadeIn: number(raw.fadeIn, 0, 0, duration, 'fadeIn'), fadeOut: number(raw.fadeOut, 0, 0, duration, 'fadeOut'), highpass, lowpass, delayMs: number(raw.delayMs, 0, 0, 500, 'delayMs') };
}
function audioFilter(track: any, input: number, label: string) {
  const chain = [`[${input}:${track.stream}]atrim=duration=${track.sourceDuration ?? track.duration}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
  if (track.loop) chain.push(`aloop=loop=-1:size=${Math.ceil(track.sourceDuration * 48000)}`, 'asetpts=N/SR/TB');
  if (track.speed !== undefined && track.speed !== 1) chain.push(`atempo=${track.speed}`);
  // Codec padding, frame rounding and time stretching can all leave a few
  // samples short. Fill that allocation before fades or sidechain mixing.
  // An infinite loop already fills the allocation; pad only finite sources.
  if (!track.loop) chain.push(`apad=whole_dur=${track.duration}`, `atrim=duration=${track.duration}`);
  if (track.denoise > 0) chain.push(`afftdn=nr=${track.denoise}:nf=-40`);
  // Balance preserves stereo content at center; it does not synthesize spatial audio.
  chain.push(`pan=stereo|c0=${track.pan > 0 ? 1 - track.pan : 1}*c0|c1=${track.pan < 0 ? 1 + track.pan : 1}*c1`, `volume=${track.gain}`);
  if (track.highpass !== undefined) chain.push(`highpass=f=${track.highpass}`);
  if (track.lowpass !== undefined) chain.push(`lowpass=f=${track.lowpass}`);
  if (track.delayMs) chain.push(`aecho=0.8:0.7:${track.delayMs}:0.25`);
  if (track.fadeIn) chain.push(`afade=t=in:st=0:d=${track.fadeIn}`);
  if (track.fadeOut) chain.push(`afade=t=out:st=${track.duration - track.fadeOut}:d=${track.fadeOut}`);
  chain.push(`atrim=duration=${track.duration}`, `adelay=${Math.round(track.at * 48000)}S:all=1`);
  return `${chain.join(',')}[${label}]`;
}
export function duckingOptions(value: any, roles: string[]) {
  const applicable = roles.includes('voice') && roles.includes('music');
  if (value === false || (value === undefined && !applicable)) return undefined;
  if (value !== undefined && value !== true) fields(value, ['thresholdDb', 'ratio', 'attackMs', 'releaseMs'], 'ducking');
  if (!applicable) throw Error('Ducking requires both voice and music tracks');
  const config = value && value !== true ? value : {};
  return { thresholdDb: number(config.thresholdDb, -30, -50, -6, 'ducking thresholdDb'), ratio: number(config.ratio, 6, 1, 20, 'ducking ratio'), attackMs: number(config.attackMs, 15, 1, 200, 'ducking attackMs'), releaseMs: number(config.releaseMs, 300, 20, 2000, 'ducking releaseMs') };
}
function mixFilter(labels: Array<{ name: string; role: string; key?: string }>, duration: number, ducking?: ReturnType<typeof duckingOptions>) {
  // Normalize packet sizes at the compressor boundary. The final trim
  // restores the exact sample count after padding the last packet.
  const sum = (names: string[], label: string) => `${names.map(name => `[${name}]`).join('')}${names.length === 1 ? 'anull' : `amix=inputs=${names.length}:duration=longest:dropout_transition=0:normalize=0`},apad,atrim=duration=${duration},asetnsamples=n=1024:p=1[${label}]`;
  const filters: string[] = [];
  let names = labels.map(label => label.name);
  if (ducking) {
    // Voice keys come from a finalized voice bus, with independent inputs
    // for key and audible signal. FFmpeg 8 can starve a live edited key branch
    // and silently produce unducked or short audio when it shares a graph.
    filters.push(sum(labels.filter(l => l.role === 'voice').map(l => l.name), 'voiceout'));
    filters.push(sum(labels.filter(l => l.role === 'voice').map(l => l.key!), 'voicekey'));
    filters.push(sum(labels.filter(l => l.role === 'music').map(l => l.name), 'musicbus'));
    filters.push(`[musicbus][voicekey]sidechaincompress=threshold=${10 ** (ducking.thresholdDb / 20)}:ratio=${ducking.ratio}:attack=${ducking.attackMs}:release=${ducking.releaseMs}:makeup=1:link=maximum:detection=rms[duckedmusic]`);
    names = ['voiceout', 'duckedmusic', ...labels.filter(l => l.role === 'effect').map(l => l.name)];
  }
  filters.push(`${names.map(name => `[${name}]`).join('')}amix=inputs=${names.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true,apad,atrim=duration=${duration}[audio]`);
  return filters.join(';');
}
async function renderVoiceBus(tracks: any[], duration: number, dir: string, signal?: AbortSignal) {
  const output = path.join(dir, 'ducking-voice.wav');
  const args = [...FFMPEG_FLAGS, '-v', 'error'];
  for (const track of tracks) args.push(...inputArgs(track.file, track.start));
  const filters = tracks.map((track, i) => audioFilter(track, i, `voice${i}`));
  filters.push(`${tracks.map((_, i) => `[voice${i}]`).join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${duration}[voice]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[voice]', '-t', String(duration), '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', output);
  await run('ffmpeg', args, signal);
  return output;
}
/** Transitions offered by video_compose. `cut` is a plain concat; the rest
 * are FFmpeg xfade names available since FFmpeg 4.4, so the same call
 * renders on Ubuntu LTS and current FFmpeg. One source of truth: the tool
 * schema in media-tools.ts and the tests import this list. */
export const VIDEO_TRANSITIONS = ['cut', 'fade', 'fadewhite', 'fadeblack', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown'] as const;
async function finish(dir: string, output: string, signal: AbortSignal | undefined, receipt: any) {
  const info = await probe(output, signal);
  const video = info.streams?.find((stream: any) => stream.codec_type === 'video');
  const actualDuration = Number(video?.duration ?? info.streams?.find((stream: any) => stream.codec_type === 'audio')?.duration ?? info.format?.duration);
  if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - receipt.duration) > (video ? 1 / receipt.fps + 0.002 : 2 / 48000)) throw Error(`Rendered duration ${actualDuration}s does not fill the ${receipt.duration}s timeline`);
  await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(output, 0), '-f', 'null', '-'], signal);
  const result = { ...receipt, actualDuration, artifact: await produced(output), output: info, decodeVerified: true, note: 'Local bounded render; inspect representative playback for framing, timing and audible quality. Stereo balance and sample-peak limiting do not establish perceptual loudness or true peak; use audio_analyze for measurements.' };
  await fs.writeFile(path.join(dir, 'timeline.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  signal?.throwIfAborted();
  return result;
}
export function loopBudget(tracks: any[]) {
  // aloop stores decoded float stereo; cap aggregate buffers at 128 MiB.
  if (tracks.filter(track => track.loop).reduce((bytes, track) => bytes + Math.ceil(track.sourceDuration * 48000) * 8, 0) > 128 * 1024 * 1024) throw Error('Loop buffers exceed 128 MiB; shorten source segments or use fewer looped tracks');
}

export async function prepareAudioMix(params: any, cwd: string, signal?: AbortSignal, inspect = cachedProbe(signal)) {
  const duration = number(params.duration, 30, 0.1, 120, 'duration');
  const tracks = await mediaMap(array(params.tracks, 'tracks'), (track, _index, active) => audioTrack(track, cwd, duration, file => inspect(file, active)), signal);
  const ducking = duckingOptions(params.ducking, tracks.map(t => t.role));
  loopBudget(tracks);
  const target = params.targetLufs === undefined ? undefined : number(params.targetLufs, -16, -36, -8, 'targetLufs');
  signal?.throwIfAborted();
  return { duration, tracks, ducking, target };
}

export async function audioMix(params: any, cwd: string, signal?: AbortSignal, inspect?: MediaInspector) {
  const { duration, tracks, ducking, target } = await prepareAudioMix(params, cwd, signal, inspect);
  const dir = await outputFolder(params.outputDir, cwd), output = path.join(dir, 'mix.wav');
  try {
    const voiceBus = ducking ? await renderVoiceBus(tracks.filter(track => track.role === 'voice'), duration, dir, signal) : undefined;
    const args = [...FFMPEG_FLAGS, '-v', 'error'];
    for (const track of tracks) args.push(...inputArgs(track.file, track.start));
    const filters: string[] = [], labels: Array<{ name: string; role: string; key?: string }> = [];
    for (const [i, track] of tracks.entries()) if (!ducking || track.role !== 'voice') {
      filters.push(audioFilter(track, i, `a${i}`)); labels.push({ name: `a${i}`, role: track.role });
    }
    if (voiceBus) {
      args.push(...inputArgs(voiceBus, 0), ...inputArgs(voiceBus, 0));
      filters.push(`[${tracks.length}:0]anull[voicedelivery]`, `[${tracks.length + 1}:0]anull[voicekeysource]`);
      labels.push({ name: 'voicedelivery', role: 'voice', key: 'voicekeysource' });
    }
    filters.push(mixFilter(labels, duration, ducking));
    args.push('-filter_complex', filters.join(';'), '-map', '[audio]', '-t', String(duration), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', output);
    await run('ffmpeg', args, signal);
    if (voiceBus) await fs.rm(voiceBus);
    const loudness = target === undefined ? undefined : await masterMedia(output, target, signal);
    return await finish(dir, output, signal, { operation: 'audio_mix', duration, tracks, ducking: ducking ?? false, ...(loudness ? { loudness } : {}), limiter: 'sample peak 0.95, latency compensated', sampleRate: 48000 });
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

export async function prepareVideoCompose(params: any, cwd: string, signal?: AbortSignal, inspect = cachedProbe(signal)) {
  const width = integer(params.width, 1280, 64, 1920, 'width'), height = integer(params.height, 720, 64, 1080, 'height'), fps = integer(params.fps, 24, 1, 60, 'fps');
  if (width % 2 || height % 2) throw Error('width and height must be even');
  const transition = params.transition ?? 'cut';
  if (!(VIDEO_TRANSITIONS as readonly string[]).includes(transition)) throw Error(`transition must be one of ${VIDEO_TRANSITIONS.join(', ')}`);
  const overlap = transition === 'cut' ? 0 : number(params.transitionDuration, 0.5, 1 / fps, 3, 'transitionDuration');
  if (params.includeClipAudio !== undefined && typeof params.includeClipAudio !== 'boolean') throw Error('includeClipAudio must be boolean');
  const clips = []; let requestedDuration = 0;
  for (const raw of array(params.clips, 'clips')) {
    fields(raw, ['path', 'start', 'duration'], 'clip');
    const file = await inputFile(raw.path, cwd), info = await inspect(file), stream = requireStream(info, 'video');
    if (stream.width > 8192 || stream.height > 8192 || stream.width * stream.height > 33_554_432) throw Error('Source video dimensions exceed decoder work budget');
    if (['smpte2084', 'arib-std-b67'].includes(stream.color_transfer)) throw Error('HDR source requires explicit tone mapping before SDR composition');
    const start = number(raw.start, 0, 0, 86400, 'clip start'), length = number(raw.duration, undefined as any, 1 / fps, 120, 'clip duration');
    if (start + length > sourceDuration(info, stream) + 0.02) throw Error('Clip exceeds source duration');
    if (overlap * 2 > length) throw Error('Transition cannot exceed half any clip duration');
    const requestedAt = clips.length ? requestedDuration - overlap : 0;
    requestedDuration = requestedAt + length;
    // Quantize absolute boundaries, not each duration independently: eight
    // fractional clips must not accumulate rounding and lose the final clip.
    const startFrame = Math.round(requestedAt * fps), endFrame = Math.round(requestedDuration * fps);
    const frames = endFrame - startFrame;
    const previous = clips.at(-1);
    const overlapFrames = previous ? previous.endFrame - startFrame : 0;
    if (frames < 1 || (previous && transition !== 'cut' && (overlapFrames < 1 || overlapFrames * 2 > Math.min(previous.frames, frames)))) {
      throw Error('Frame-rounded transition cannot exceed half either clip; increase clip duration or reduce transitionDuration');
    }
    clips.push({ file, stream: stream.index, start, requestedDuration: length, requestedAt, duration: frames / fps, at: startFrame / fps, frames, endFrame, transitionDuration: overlapFrames / fps, audio: info.streams?.find((s: any) => s.codec_type === 'audio')?.index });
  }
  const duration = clips.at(-1)!.endFrame / fps;
  if (duration > 120 || Math.ceil(duration * fps) * width * height > 1_500_000_000) throw Error('Timeline exceeds duration/pixel work budget; reduce duration, fps or resolution');
  // User audio is expressed in the requested timeline. Final mixing trims or
  // pads the sub-frame difference after video boundary quantization.
  const extraTracks = await mediaMap(array(params.audio ?? [], 'audio', 0), (track, _index, active) => audioTrack(track, cwd, requestedDuration, file => inspect(file, active)), signal);
  const clipRoles = params.includeClipAudio !== false ? clips.filter(clip => clip.audio !== undefined).map(() => 'voice') : [];
  const ducking = duckingOptions(params.ducking, [...clipRoles, ...extraTracks.map(t => t.role)]);
  loopBudget(extraTracks);
  const target = params.targetLufs === undefined ? undefined : number(params.targetLufs, -16, -36, -8, 'targetLufs');
  if (target !== undefined && !clipRoles.length && !extraTracks.length) throw Error('Loudness normalization requires audio');
  signal?.throwIfAborted();
  return { width, height, fps, transition, overlap, clips, duration, requestedDuration, extraTracks, clipRoles, ducking, target };
}

export async function videoCompose(params: any, cwd: string, signal?: AbortSignal, inspect?: MediaInspector) {
  const { width, height, fps, transition, overlap, clips, duration, requestedDuration, extraTracks, ducking, target } = await prepareVideoCompose(params, cwd, signal, inspect);
  const dir = await outputFolder(params.outputDir, cwd), output = path.join(dir, 'timeline.mp4');
  try {
    const clipVoice = params.includeClipAudio !== false ? clips.flatMap((clip, i) => clip.audio === undefined ? [] : [{ ...clip, stream: clip.audio, sourceDuration: clip.requestedDuration, gain: 1, pan: 0, fadeIn: clip.transitionDuration, fadeOut: clips[i + 1]?.transitionDuration ?? 0 }]) : [];
    const voiceBus = ducking ? await renderVoiceBus([...clipVoice, ...extraTracks.filter(track => track.role === 'voice')], duration, dir, signal) : undefined;
    const args = [...FFMPEG_FLAGS, '-v', 'error'], filters: string[] = [], audioLabels: Array<{ name: string; role: string; key?: string }> = [];
    for (const clip of clips) args.push(...inputArgs(clip.file, clip.start));
    for (const track of extraTracks) args.push(...inputArgs(track.file, track.start));
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Use bounded display-aspect math supported by FFmpeg 6.1 as well as newer
      // builds; reset_sar was added later. Normalize pixels before letterboxing.
      filters.push(`[${i}:${clip.stream}]trim=duration=${clip.requestedDuration},setpts=PTS-STARTPTS,scale=w='max(2,trunc(min(${width},${height}*dar)/2)*2)':h='max(2,trunc(min(${height},${width}/dar)/2)*2)',setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},tpad=stop_mode=clone:stop_duration=${clip.duration},trim=end_frame=${clip.frames},format=yuv420p,settb=AVTB[v${i}]`);
      if (!ducking && params.includeClipAudio !== false && clip.audio !== undefined) {
        const track = { ...clip, stream: clip.audio, sourceDuration: clip.requestedDuration, gain: 1, pan: 0, fadeIn: clip.transitionDuration, fadeOut: clips[i + 1]?.transitionDuration ?? 0 };
        audioLabels.push({ name: `ca${i}`, role: 'voice', key: `ck${i}` }); filters.push(audioFilter(track, i, `ca${i}`));
      }
    }
    let video = 'v0';
    if (clips.length > 1 && transition === 'cut') {
      filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[video]`); video = 'video';
    } else for (let i = 1; i < clips.length; i++) {
      filters.push(`[${video}][v${i}]xfade=transition=${transition}:duration=${clips[i].transitionDuration}:offset=${clips[i].at}[x${i}]`); video = `x${i}`;
    }
    for (let i = 0; i < extraTracks.length; i++) {
      if (ducking && extraTracks[i].role === 'voice') continue;
      audioLabels.push({ name: `a${i}`, role: extraTracks[i].role, key: `ak${i}` }); filters.push(audioFilter(extraTracks[i], clips.length + i, `a${i}`));
    }
    if (voiceBus) {
      args.push(...inputArgs(voiceBus, 0), ...inputArgs(voiceBus, 0));
      filters.push(`[${clips.length + extraTracks.length}:0]anull[voicedelivery]`, `[${clips.length + extraTracks.length + 1}:0]anull[voicekeysource]`);
      audioLabels.push({ name: 'voicedelivery', role: 'voice', key: 'voicekeysource' });
    }
    if (audioLabels.length) filters.push(mixFilter(audioLabels, duration, ducking));
    args.push('-filter_complex', filters.join(';'), '-map', `[${video}]`);
    if (audioLabels.length) args.push('-map', '[audio]', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k');
    args.push('-t', String(duration), '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-map_chapters', '-1', output);
    await run('ffmpeg', args, signal);
    if (voiceBus) await fs.rm(voiceBus);
    const loudness = target === undefined ? undefined : await masterMedia(output, target, signal);
    return await finish(dir, output, signal, { operation: 'video_compose', width, height, fps, duration, requestedDuration, transition, transitionDuration: overlap, clips, audio: extraTracks, ducking: ducking ?? false, ...(loudness ? { loudness } : {}), includeClipAudio: params.includeClipAudio !== false, timing: 'Absolute clip boundaries round to the nearest output frame; each clip is trimmed or holds its last frame to fill that allocation. Per-clip at/duration/transitionDuration are the rendered timing; requestedAt/requestedDuration retain input timing.' });
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
