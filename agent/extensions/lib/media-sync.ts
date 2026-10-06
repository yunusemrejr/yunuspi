/** Frame/sample boundaries share a half-open clock [start,end). This audit
 * reports evidence and never fixes overruns by cutting spoken words. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { inputFile, number, probe } from './media-process.ts';

const norm = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
export function wordTarget(words: any[], value: string) {
  const match = /^(.*?)(?:#([1-9]\d*))?$/.exec(value);
  if (!match) return undefined;
  const wanted = norm(match[1]), occurrence = Number(match[2] ?? 1);
  return words.filter(w => typeof w?.w === 'string' && norm(w.w) === wanted)[occurrence - 1];
}

export function auditMediaSync(spec: any, measurements: Record<string, number> = {}, toleranceFrames = 2) {
  const fps = number(spec?.fps, 30, 1, 60, 'fps');
  if (!Number.isInteger(fps)) throw Error('fps must be an integer');
  if (!Array.isArray(spec?.scenes) || !spec.scenes.length) throw Error('scenes must be nonempty');
  number(toleranceFrames, 2, 0, 30, 'toleranceFrames');
  const issues: any[] = [], scenes: any[] = [];
  let frame = 0;
  for (const scene of spec.scenes) {
    const seconds = number(scene.seconds, 0, 0.01, 86400, 'scene.seconds'), frames = Math.max(1, Math.round(seconds * fps));
    const start = frame / fps, end = (frame + frames) / fps;
    const words = scene.narrationWords ?? [], offset = number(scene.narrationOffset, 0, 0, 86400, 'narrationOffset');
    const measured = measurements[scene.id], declared = scene.narrationSeconds;
    const audioSeconds = measured ?? declared;
    const problem = (severity: string, code: string, detail: any = {}) => issues.push({ severity, code, scene: scene.id, ...detail });
    if (!Array.isArray(words)) throw Error('narrationWords must be an array');
    const text = typeof scene.narration === 'string' ? scene.narration.trim().split(/\s+/u).filter(Boolean) : [];
    const coverage = text.length ? text.length === words.length && text.every((token: string, i: number) => norm(token) === norm(words[i]?.w ?? '')) : null;
    if (text.length && !words.length) problem('warn', 'missing-word-alignment');
    else if (coverage === false) problem('error', 'text-word-mismatch');
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (typeof w?.w !== 'string' || !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e <= w.s || i && w.s < words[i - 1].e - 0.002) { problem('error', 'invalid-word-span', { word: i }); continue; }
      if (Number.isFinite(audioSeconds) && w.e > audioSeconds + 0.02) problem('error', 'word-outside-audio', { word: i, seconds: w.e });
    }
    if (measured !== undefined && Number.isFinite(declared) && Math.abs(measured - declared) > 1 / fps) problem('error', 'stale-audio-duration', { declared, measured });
    if (scene.narrationAudio && !Number.isFinite(audioSeconds)) problem('error', 'unmeasured-narration');
    const voiceEnd = Number.isFinite(audioSeconds) ? start + offset + audioSeconds : null;
    if (voiceEnd !== null && voiceEnd > end + 0.002) problem('error', 'narration-crosses-cut', { overrunSeconds: voiceEnd - end, overrunFrames: Math.ceil((voiceEnd - end) * fps) });
    const cues = Object.entries(scene.cues ?? {}).map(([name, time]) => {
      const cue = number(time, 0, 0, seconds, `cue.${name}`), cueFrame = frame + Math.round(cue * fps);
      const target = scene.cueWords?.[name], word = typeof target === 'string' ? wordTarget(words, target) : undefined;
      if (cueFrame >= frame + frames) problem('error', 'cue-outside-frames', { cue: name });
      if (target && !word) problem('error', 'cue-word-unresolved', { cue: name, target });
      const spokenSeconds = word ? start + offset + word.s : null;
      const lead = scene.cueLead ?? 0.08;
      const deltaFrames = spokenSeconds === null ? null : cueFrame - Math.round((spokenSeconds - lead) * fps);
      if (deltaFrames !== null && Math.abs(deltaFrames) > toleranceFrames) problem('error', 'cue-speech-drift', { cue: name, deltaFrames, intendedLeadSeconds: lead });
      return { name, seconds: start + cue, frame: cueFrame, quantizedSeconds: cueFrame / fps, target: target ?? null, spokenSeconds, deltaFrames };
    });
    scenes.push({ id: scene.id, startFrame: frame, endFrameExclusive: frame + frames, startSeconds: start, endSeconds: end, narrationStartSeconds: start + offset,
      narrationEndSeconds: voiceEnd, lastWordEndSeconds: words.length ? start + offset + words.at(-1).e : null, tailSeconds: voiceEnd === null ? null : end - voiceEnd, textMatches: coverage,
      wordFrames: words.filter((w: any) => Number.isFinite(w.s) && Number.isFinite(w.e)).map((w: any) => ({ w: w.w, startFrame: Math.floor((start + offset + w.s) * fps), endFrameExclusive: Math.ceil((start + offset + w.e) * fps) })), cues });
    frame += frames;
  }
  return { fps, totalFrames: frame, seconds: frame / fps, ok: !issues.some(i => i.severity === 'error'), issues, scenes,
    clock: 'Scene durations round independently to frames; word coverage uses floor(start) and ceil(end). Provider alignment is not independent transcription.' };
}

export function musicGrid(params: any) {
  const bpm = number(params.bpm, 100, 20, 300, 'bpm'), offset = number(params.offset, 0, 0, 86400, 'offset');
  const beatsPerBar = number(params.beatsPerBar, 4, 1, 12, 'beatsPerBar');
  if (!Number.isInteger(beatsPerBar)) throw Error('beatsPerBar must be an integer');
  if (!Array.isArray(params.times) || params.times.length > 2000) throw Error('times must be an array of at most 2000 cue times');
  const interval = 60 / bpm * (params.unit === 'bar' ? beatsPerBar : params.unit === 'half' ? 0.5 : 1);
  return { bpm, offset, beatsPerBar, interval, cues: params.times.map((t: unknown) => {
    const time = number(t, 0, 0, 86400, 'cue time'), index = Math.max(0, Math.round((time - offset) / interval)), snapped = offset + index * interval;
    return { time, snapped, deltaSeconds: snapped - time, index };
  }), note: 'Grid uses the supplied musical tempo and downbeat. It does not infer a tempo or move speech cues automatically.' };
}

export async function mediaSync(params: any, cwd: string, signal?: AbortSignal) {
  if (params.action === 'music_grid') return musicGrid(params);
  if (params.action !== undefined && params.action !== 'check') throw Error('Unsupported media_sync action');
  let spec = params.timeline;
  let dir: string | undefined;
  if (params.dir) {
    const file = await inputFile(path.join(params.dir, 'video.json'), cwd); dir = path.dirname(file);
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw Error('Timeline exceeds 8 MiB');
    spec = JSON.parse(await fs.readFile(file, 'utf8'));
  }
  if (!spec) throw Error('Provide dir or timeline');
  const measurements: Record<string, number> = {};
  if (dir) for (const scene of spec.scenes ?? []) {
    signal?.throwIfAborted();
    if (scene.narrationAudio) {
      if (typeof scene.narrationAudio !== 'string' || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]+:/i.test(scene.narrationAudio)) throw Error('Narration audio must be relative to public/');
      const info = await probe(await inputFile(path.join(dir, 'public', scene.narrationAudio), cwd), signal);
      const seconds = Number(info.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) throw Error('Narration duration could not be measured');
      measurements[scene.id] = seconds;
    }
  }
  const result: any = auditMediaSync(spec, measurements, params.toleranceFrames ?? 2);
  if (params.path) {
    const info = await probe(await inputFile(params.path, cwd), signal);
    const streamEnd = (s: any) => Number(s.start_time ?? 0) + Number(s.duration);
    const video = info.streams?.find((s: any) => s.codec_type === 'video'), audio = info.streams?.find((s: any) => s.codec_type === 'audio');
    const videoEnd = video && streamEnd(video), audioEnd = audio && streamEnd(audio);
    result.delivery = { videoEndSeconds: Number.isFinite(videoEnd) ? videoEnd : null, audioEndSeconds: Number.isFinite(audioEnd) ? audioEnd : null,
      avDeltaFrames: Number.isFinite(videoEnd) && Number.isFinite(audioEnd) ? (audioEnd - videoEnd) * result.fps : null,
      timelineDeltaFrames: Number.isFinite(videoEnd) ? (videoEnd - result.seconds) * result.fps : null };
    if (result.delivery.timelineDeltaFrames !== null && Math.abs(result.delivery.timelineDeltaFrames) > 1 || result.delivery.avDeltaFrames !== null && Math.abs(result.delivery.avDeltaFrames) > 2) {
      result.issues.push({ severity: 'error', code: 'delivery-boundary-drift', ...result.delivery }); result.ok = false;
    }
  }
  return result;
}
