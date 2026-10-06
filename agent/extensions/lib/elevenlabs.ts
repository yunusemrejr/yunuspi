/** Fixed-host ElevenLabs transport. No SDK, shell secrets, paid retries or
 * silent provider substitution. Timings describe provider alignment, not ASR. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { FFMPEG_FLAGS, inputArgs, inputFile, number, outputFolder, probe, produced, requireStream, run } from './media-process.ts';
import { captionChunks, toSrt, toVtt } from '../../skills/remotion-video/assets/template/src/captions.ts';
import { acquireCatalogCacheLock } from './catalog-cache-lock.ts';

type Env = Record<string, string | undefined>;
const API = 'https://api.elevenlabs.io/v1';
const keyOf = (env: Env) => env.ELEVENLABS_API_KEY || env.PI_ELEVENLABS_API_KEY || env.XI_API_KEY;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function elevenStatus(env: Env = process.env) {
  return { provider: 'elevenlabs', configured: Boolean(keyOf(env)), voiceId: env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb', model: env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
    setup: 'Set ELEVENLABS_API_KEY in the private environment; optionally ELEVENLABS_VOICE_ID and ELEVENLABS_TTS_MODEL. narration_tts backend:auto prefers ElevenLabs when configured. backend:piper selects local speech.',
    capabilities: ['timestamped speech', 'forced alignment', 'instrumental music', 'sound effects'], automaticRetries: 0 };
}
export function narrationBackend(params: any, env: Env = process.env): 'piper' | 'elevenlabs' {
  const backend = params.backend ?? 'auto';
  if (!['auto', 'piper', 'elevenlabs'].includes(backend)) throw Error('backend must be auto, piper or elevenlabs');
  if (backend === 'piper' && (params.voiceId || params.model)) throw Error('voiceId/model require ElevenLabs');
  if (params.voice && (backend === 'elevenlabs' || params.voiceId || params.model)) throw Error('Use voiceId for ElevenLabs; voice selects a Piper voice');
  return backend === 'auto' ? params.voice ? 'piper' : params.voiceId || params.model || keyOf(env) ? 'elevenlabs' : 'piper' : backend;
}

async function request(endpoint: string, body: any, signal: AbortSignal | undefined, env: Env, maxBytes = 64 * 1024 * 1024) {
  const key = keyOf(env);
  if (!key) throw Error('ElevenLabs is not configured; set ELEVENLABS_API_KEY or explicitly use backend:piper');
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
  bounded.throwIfAborted();
  const multipart = body instanceof FormData;
  const response = await fetch(API + endpoint, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: bounded,
    headers: { 'xi-api-key': key, ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
  if (!response.ok) { await response.body?.cancel(); throw Error(`ElevenLabs returned HTTP ${response.status}; no automatic retry or fallback was attempted`); }
  if (!response.body) throw Error('ElevenLabs returned no body');
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      bounded.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > maxBytes) throw Error('ElevenLabs response exceeds the media byte budget');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks), requestId: response.headers.get('request-id') || response.headers.get('x-request-id'), characterCost: response.headers.get('character-cost'), songId: response.headers.get('song-id') };
}

/** Split on sentence/word boundaries without dropping a single character.
 * A short final chunk still carries neighbouring text for delivery continuity. */
export function splitSpeech(text: string, max = 2000): string[] {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw Error('text must contain 1..100000 characters; use scenes for longer scripts');
  if (!Number.isInteger(max) || max < 100 || max > 5000) throw Error('chunkChars must be 100..5000');
  const chunks: string[] = [];
  while (text.length > max) {
    const prefix = text.slice(0, max), matches = [...prefix.matchAll(/[.!?。！？]\s+|\n+/gu)];
    let end = matches.at(-1) ? matches.at(-1)!.index! + matches.at(-1)![0].length : 0;
    if (end < max / 3) end = prefix.lastIndexOf(' ') + 1;
    if (end < max / 3) end = max;
    // Never split a UTF-16 surrogate pair.
    if (/^[\uDC00-\uDFFF]/.test(text.slice(end))) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

export function characterWords(alignment: any, text: string): Array<{ w: string; s: number; e: number }> {
  const chars = alignment?.characters, starts = alignment?.character_start_times_seconds, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) || chars.length !== starts.length || chars.length !== ends.length || chars.some((c: unknown) => typeof c !== 'string') || chars.join('') !== text) throw Error('Provider character alignment does not match the requested text; use forced alignment before captioning');
  let previous = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i] < 0 || ends[i] < starts[i] || starts[i] < previous - 0.02) throw Error('Invalid provider character timings');
    previous = starts[i];
  }
  const words: Array<{ w: string; s: number; e: number }> = [];
  let i = 0;
  for (const token of text.match(/\S+\s*/gu) ?? []) {
    while (i < chars.length && /^\s+$/u.test(chars[i])) i++;
    const length = token.trimEnd().length;
    let j = i, consumed = 0;
    while (j < chars.length && consumed < length) consumed += chars[j++].length;
    const w = text.slice(chars.slice(0, i).join('').length, chars.slice(0, j).join('').length);
    const s = starts[i], e = ends[j - 1];
    if (!w || !(e > s)) throw Error('Provider returned a word without a positive time span');
    words.push({ w, s, e }); i = j;
  }
  if (words.map(w => w.w).join(' ') !== text.trim().replace(/\s+/gu, ' ')) throw Error('Incomplete provider word coverage');
  return words;
}

export function speechRequest(params: any, text: string, env: Env = process.env) {
  const voiceId = params.voiceId ?? elevenStatus(env).voiceId;
  if (typeof voiceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(voiceId)) throw Error('voiceId must be an ElevenLabs voice identifier');
  const model = params.model ?? elevenStatus(env).model;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(model)) throw Error('model must be an exact ElevenLabs TTS model id');
  const voice_settings: any = { stability: number(params.stability, 0.5, 0, 1, 'stability'), similarity_boost: number(params.similarity, 0.75, 0, 1, 'similarity'), style: number(params.expressiveness, 0, 0, 1, 'expressiveness'), speed: number(params.speed, 1, 0.7, 1.2, 'speed'), use_speaker_boost: true };
  return { voiceId, body: { text, model_id: model, voice_settings, ...(params.language ? { language_code: params.language } : {}), ...(params.previousText ? { previous_text: params.previousText } : {}), ...(params.nextText ? { next_text: params.nextText } : {}) } };
}

/** dir is a fresh standalone directory or a caller-owned project cache. A
 * receipt is committed only after decoding; completed paid chunks survive a
 * project interruption and are reused only with identical inputs and bytes. */
export async function elevenSpeech(params: any, dir: string, signal?: AbortSignal, progress?: (text: string) => void, env: Env = process.env) {
  const parts = splitSpeech(params.text, params.chunkChars ?? 2000);
  speechRequest(params, parts[0], env);
  if (!keyOf(env)) throw Error('ElevenLabs is not configured; set ELEVENLABS_API_KEY or explicitly use backend:piper');
  await fs.mkdir(dir, { recursive: true });
  const release = await acquireCatalogCacheLock(path.join(dir, 'speech'), signal);
  try { return await speechChunks(params, dir, signal, progress, env); } finally { release(); }
}
async function speechChunks(params: any, dir: string, signal?: AbortSignal, progress?: (text: string) => void, env: Env = process.env) {
  const chunks = splitSpeech(params.text, params.chunkChars ?? 2000), outputs: string[] = [], words: Array<{ w: string; s: number; e: number }> = [], receipts: any[] = [];
  let offset = 0;
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted(); progress?.(`Narration part ${i + 1}/${chunks.length}`);
    const { voiceId, body } = speechRequest({ ...params, previousText: i ? chunks[i - 1].slice(-700) : params.previousText, nextText: i + 1 < chunks.length ? chunks[i + 1].slice(0, 700) : params.nextText }, chunks[i], env);
    const key = digest(JSON.stringify({ voiceId, body, account: digest(keyOf(env) || '') }));
    const audio = path.join(dir, `speech-${key}.mp3`), receiptPath = path.join(dir, `speech-${key}.json`);
    let receipt: any = await fs.readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => undefined);
    const reused = receipt && receipt.words?.map((w: any) => w.w).join(' ') === chunks[i].trim().replace(/\s+/gu, ' ') && receipt.words.every((w: any, n: number) => Number.isFinite(w.s) && Number.isFinite(w.e) && w.s >= 0 && w.e > w.s && (!n || w.s >= receipt.words[n - 1].e - 0.02)) && await fs.readFile(audio).then(b => digest(b) === receipt.sha256, () => false);
    if (!reused) {
      const result = await request(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, body, signal, env);
      const json = JSON.parse(result.bytes.toString('utf8'));
      const aligned = characterWords(json.alignment, chunks[i]);
      if (typeof json.audio_base64 !== 'string' || !json.audio_base64.length || !/^[a-zA-Z0-9+/=\r\n]+$/.test(json.audio_base64)) throw Error('Invalid ElevenLabs audio payload');
      const bytes = Buffer.from(json.audio_base64, 'base64');
      await fs.rm(audio, { force: true });
      await fs.writeFile(audio, bytes, { flag: 'wx', mode: 0o600 });
      const seconds = Number((await probe(audio, signal)).format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0 || aligned.at(-1)!.e > seconds + 0.1) throw Error('Speech timings exceed decoded audio');
      receipt = { seconds, words: aligned, voiceId, model: body.model_id, sha256: digest(bytes), requestId: result.requestId, characterCost: result.characterCost, requestedCharacters: chunks[i].length };
      await fs.writeFile(receiptPath, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    }
    outputs.push(audio); words.push(...receipt.words.map((w: any) => ({ ...w, s: w.s + offset, e: w.e + offset })));
    receipts.push({ requestId: receipt.requestId, characterCost: receipt.characterCost, requestedCharacters: receipt.requestedCharacters, reused: Boolean(reused) });
    // Use decoded PCM length, not MP3 container padding, at every seam.
    const pcm = path.join(dir, `pcm-${key}.wav`);
    await fs.rm(pcm, { force: true });
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', ...inputArgs(audio, 0), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', pcm], signal);
    const decoded = Number((await probe(pcm, signal)).format?.duration);
    if (!Number.isFinite(decoded) || decoded <= 0 || receipt.words.at(-1).e > decoded + 0.05) throw Error('Speech word timing exceeds decoded PCM duration');
    offset += decoded; outputs[outputs.length - 1] = pcm;
  }
  const output = path.join(dir, `speech-${digest(outputs.join('|'))}.wav`);
  await fs.rm(output, { force: true });
  // Fixed generated basenames and safe concat demuxer: caller paths never
  // enter the list. Decode PCM seams and encode speech only once downstream.
  const list = path.join(dir, 'speech-parts.txt');
  await fs.writeFile(list, outputs.map(p => `file '${path.basename(p)}'`).join('\n') + '\n');
  await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-c:a', 'pcm_s16le', output], signal, 300_000);
  await Promise.all(outputs.map(p => fs.rm(p, { force: true }))); await fs.rm(list, { force: true });
  const seconds = Number((await probe(output, signal)).format?.duration);
  if (words.at(-1)!.e > seconds + 0.05) throw Error('Joined word timing exceeds decoded narration');
  return { raw: output, seconds, words, provider: 'elevenlabs', timing: 'provider-character-alignment', receipts, voiceId: params.voiceId ?? elevenStatus(env).voiceId, model: params.model ?? elevenStatus(env).model };
}

export async function writeSpeechCaptions(dir: string, text: string, seconds: number, words: Array<{ w: string; s: number; e: number }>) {
  const track = captionChunks(text, seconds, 7, 42, words);
  const srt = path.join(dir, 'captions.srt'), vtt = path.join(dir, 'captions.vtt');
  await fs.writeFile(srt, toSrt(track)); await fs.writeFile(vtt, toVtt(track));
  return { srt, vtt };
}

export async function elevenVoices(signal?: AbortSignal, env: Env = process.env) {
  const result = await request('/voices', undefined, signal, env, 4 * 1024 * 1024);
  const body = JSON.parse(result.bytes.toString('utf8'));
  return { provider: 'elevenlabs', voices: (body.voices ?? []).slice(0, 100).map((v: any) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels })), truncated: (body.voices?.length ?? 0) > 100 };
}

export async function narrationAlign(params: any, cwd: string, signal?: AbortSignal, env: Env = process.env) {
  const file = await inputFile(params.path, cwd), info = await probe(file, signal); requireStream(info, 'audio');
  if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw Error('Alignment upload exceeds 32 MiB; align narration scene by scene');
  if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 100_000) throw Error('Alignment needs text of 1..100000 characters');
  const form = new FormData(); form.set('file', new Blob([await fs.readFile(file)]), path.basename(file)); form.set('text', params.text);
  const response = await request('/forced-alignment', form, signal, env);
  const json = JSON.parse(response.bytes.toString('utf8')), seconds = Number(info.format?.duration);
  const words = (json.words ?? []).map((w: any) => ({ w: w.text, s: w.start, e: w.end, loss: w.loss }));
  if (!words.length || words.some((w: any, i: number) => typeof w.w !== 'string' || !Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < 0 || w.e <= w.s || w.e > seconds + 0.05 || i > 0 && w.s < words[i - 1].e - 0.02)) throw Error('Invalid forced-alignment word spans');
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const textMatches = normalize(words.map((w: any) => w.w).join(' ')) === normalize(params.text);
  const dir = await outputFolder(params.outputDir, cwd);
  try {
    const result = { provider: 'elevenlabs', source: file, seconds, timing: 'forced-alignment', words, textMatches, loss: json.loss, requestId: response.requestId,
      captions: textMatches ? await writeSpeechCaptions(dir, words.map((w: any) => w.w).join(' '), seconds, words) : undefined,
      note: 'Alignment locates the supplied transcript in audio; it does not independently verify what was spoken. Inspect high-loss words and listen before trusting a cue.' };
    await fs.writeFile(path.join(dir, 'alignment.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

export async function audioGenerate(params: any, cwd: string, signal?: AbortSignal, env: Env = process.env) {
  const music = params.kind === 'music';
  if (!music && params.kind !== 'sfx') throw Error('kind must be music or sfx');
  if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > (music ? 4100 : 1000)) throw Error('Provide a bounded audio prompt');
  const seconds = number(params.seconds, music ? 30 : 2, music ? 3 : 0.5, music ? 600 : 30, 'seconds');
  const body = music ? { prompt: params.prompt, music_length_ms: Math.round(seconds * 1000), force_instrumental: params.instrumental !== false, model_id: params.model ?? 'music_v2' }
    : { text: params.prompt, duration_seconds: seconds, loop: params.loop === true, model_id: params.model ?? 'eleven_text_to_sound_v2', prompt_influence: number(params.influence, 0.3, 0, 1, 'influence') };
  if (music && !['music_v1', 'music_v2', 'music_v2_5'].includes(body.model_id)) throw Error('Unsupported ElevenLabs music model');
  if (!music && !['eleven_text_to_sound_v2'].includes(body.model_id)) throw Error('Unsupported ElevenLabs sound model');
  const response = await request(music ? '/music' : '/sound-generation?output_format=mp3_44100_128', body, signal, env);
  const dir = await outputFolder(params.outputDir, cwd), file = path.join(dir, 'generated.mp3');
  try {
    await fs.writeFile(file, response.bytes, { flag: 'wx', mode: 0o600 });
    const info = await probe(file, signal); requireStream(info, 'audio');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(file, 0), '-f', 'null', '-'], signal);
    const result = { artifact: await produced(file), provider: 'elevenlabs', kind: params.kind, model: body.model_id, seconds: Number(info.format?.duration), requestedSeconds: seconds, requestId: response.requestId, songId: response.songId, decodeVerified: true,
      note: 'Generated duration is measured, not assumed. Use role:music in audio_mix for narration ducking. Listen for arrangement, seams and a clean ending; an instrumental flag is not a license determination.' };
    await fs.writeFile(path.join(dir, 'generation.json'), JSON.stringify({ ...result, prompt: params.prompt }, null, 2) + '\n'); return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
