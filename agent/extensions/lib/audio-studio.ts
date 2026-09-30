/** Shared measured mastering. The receipt measures the delivered encoding,
 * rather than reporting the requested LUFS as if it had been observed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FFMPEG_FLAGS, inputArgs, run } from './media-process.ts';

export type AudioMeasurement = { integratedLufs: number | null; truePeakDbtp: number | null; loudnessRangeLu: number | null };
export function loudnessReport(stderr: string) {
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
  if (!json) throw Error('Loudness measurement produced no result');
  const raw = JSON.parse(json);
  const finite = (value: unknown) => typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  const measurement: AudioMeasurement = { integratedLufs: finite(raw.input_i), truePeakDbtp: finite(raw.input_tp), loudnessRangeLu: finite(raw.input_lra) };
  return { raw, measurement };
}

export async function measureAudio(file: string, target = -16, signal?: AbortSignal) {
  const result = await run('ffmpeg', [...FFMPEG_FLAGS, '-loglevel', 'info', ...inputArgs(file, 0), '-map', '0:a:0', '-vn', '-af', `loudnorm=I=${target}:TP=-2:LRA=11:print_format=json`, '-f', 'null', '-'], signal, 600_000);
  return loudnessReport(result.stderr);
}

export async function masterMedia(file: string, target: number, signal?: AbortSignal) {
  const { raw, measurement: before } = await measureAudio(file, target, signal);
  // Silence has -inf LUFS. Feeding it into measured_I creates invalid filters;
  // preserving silence is valid, and the receipt makes the skip observable.
  if (['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].some(key => !Number.isFinite(Number(raw[key])))) {
    return { targetLufs: target, normalized: false, before, after: before, skipped: 'silent or undefined loudness' };
  }
  const ext = path.extname(file).toLowerCase(), video = ext === '.mp4';
  const output = path.join(path.dirname(file), `master-${randomBytes(8).toString('hex')}${ext}`);
  const filter = `loudnorm=I=${target}:TP=-2:LRA=11:measured_I=${Number(raw.input_i)}:measured_TP=${Number(raw.input_tp)}:measured_LRA=${Number(raw.input_lra)}:measured_thresh=${Number(raw.input_thresh)}:offset=${Number(raw.target_offset)}:linear=true`;
  try {
    await run('ffmpeg', [...FFMPEG_FLAGS, '-loglevel', 'error', ...inputArgs(file, 0), ...(video ? ['-map', '0:v:0', '-c:v', 'copy'] : ['-vn']), '-map', '0:a:0', '-af', filter, '-c:a', video ? 'aac' : 'pcm_s16le', '-ar', '48000', ...(video ? ['-b:a', '192k', '-movflags', '+faststart'] : []), '-map_metadata', '-1', '-map_chapters', '-1', output], signal, 600_000);
    const { measurement: after } = await measureAudio(output, target, signal);
    signal?.throwIfAborted();
    await fs.rename(output, file);
    return { targetLufs: target, normalized: true, before, after, ...(after.integratedLufs === null || Math.abs(after.integratedLufs - target) > 1 ? { warning: 'Delivered loudness differs from the target; inspect the measurements before delivery' } : {}) };
  } finally { await fs.rm(output, { force: true }); }
}
