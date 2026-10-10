/** Data-only FFmpeg timeline construction. No user filters, shell or remote inputs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_FLAGS, inputArgs, inputFile, number, outputFolder, probe, produced, requireStream, run, mediaMap } from './media-process.ts';
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
