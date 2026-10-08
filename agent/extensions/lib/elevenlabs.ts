/** Fixed-host ElevenLabs transport. No SDK, shell secrets, paid retries or
 * silent provider substitution. Timings describe provider alignment, not ASR. */
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
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
  if (!key) throw Object.assign(new Error('ElevenLabs is not configured; set ELEVENLABS_API_KEY or explicitly use backend:piper for speech'), { submissionNotSent: true });
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
  if (bounded.aborted) throw Object.assign(new Error('ElevenLabs request cancelled before submission'), { submissionNotSent: true });
  const multipart = body instanceof FormData;
  const response = await fetch(API + endpoint, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: bounded,
    headers: { 'xi-api-key': key, ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`ElevenLabs returned HTTP ${response.status}; no automatic retry or fallback was attempted`), { providerStatus: response.status }); }
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
    if (end < max / 3) {
      const boundary = [...prefix.matchAll(/\s+/gu)].at(-1);
      end = boundary ? boundary.index! + boundary[0].length : 0;
    }
    if (!end) throw Error('A spoken token exceeds chunkChars; increase chunkChars or divide the script at a word boundary');
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
  let previous = 0, previousEnd = 0;
  const offsets = new Uint32Array(chars.length + 1);
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].length || !Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i] < 0 || ends[i] < starts[i] || starts[i] < previous - 0.02 || ends[i] < previousEnd - 0.02) throw Error('Invalid provider character timings');
    previous = starts[i]; previousEnd = ends[i]; offsets[i + 1] = offsets[i] + chars[i].length;
  }
  const words: Array<{ w: string; s: number; e: number }> = [];
  let i = 0;
  for (const token of text.matchAll(/\S+/gu)) {
    while (i < chars.length && offsets[i] < token.index) i++;
    let j = i;
    const end = token.index + token[0].length;
    while (j < chars.length && offsets[j] < end) j++;
    if (offsets[i] !== token.index || offsets[j] !== end) throw Error('Provider character boundaries do not cover the requested words');
    const w = token[0];
    const s = starts[i], e = ends[j - 1];
    if (!(e > s) || words.length && s < words.at(-1)!.e - 0.02) throw Error('Provider returned invalid or overlapping word spans');
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
  const styles: Record<string, { stability: number; expressiveness: number }> = {
    documentary: { stability: .5, expressiveness: 0 }, calm: { stability: .7, expressiveness: .1 },
    energetic: { stability: .35, expressiveness: .45 }, intimate: { stability: .6, expressiveness: .2 },
  };
  if (params.style !== undefined && !Object.hasOwn(styles, params.style)) throw Error('style must be documentary, calm, energetic or intimate');
  const style = styles[params.style ?? 'documentary'];
  const voice_settings: any = { stability: number(params.stability, style.stability, 0, 1, 'stability'), similarity_boost: number(params.similarity, 0.75, 0, 1, 'similarity'), style: number(params.expressiveness, style.expressiveness, 0, 1, 'expressiveness'), speed: number(params.speed, 1, 0.7, 1.2, 'speed'), use_speaker_boost: true };
  return { voiceId, body: { text, model_id: model, voice_settings, ...(params.language ? { language_code: params.language } : {}), ...(params.previousText ? { previous_text: params.previousText } : {}), ...(params.nextText ? { next_text: params.nextText } : {}) } };
}

/** dir is a fresh standalone directory or a caller-owned project cache. A
 * receipt is committed only after decoding; completed paid chunks survive a
 * project interruption and are reused only with identical inputs and bytes. */
export async function elevenSpeech(params: any, dir: string, signal?: AbortSignal, progress?: (text: string) => void, env: Env = process.env) {
  const parts = splitSpeech(params.text, params.chunkChars ?? 2000);
  if (parts.some(part => !part.trim())) throw Error('Every speech chunk must contain words; remove long runs of leading or trailing whitespace');
  speechRequest(params, parts[0], env);
  if (!keyOf(env)) throw Error('ElevenLabs is not configured; set ELEVENLABS_API_KEY or explicitly use backend:piper');
  await fs.mkdir(dir, { recursive: true });
  const release = await acquireCatalogCacheLock(path.join(dir, 'speech'), signal);
  try {
    if (params.cacheOnly !== true) {
      const request = speechRequest(params, parts[0], env), settings = request.body.voice_settings;
      await atomicSpeechFile(path.join(dir, 'speech-request.json'), JSON.stringify({ version: 1, account: digest(keyOf(env)!), params: { text: params.text, chunkChars: params.chunkChars ?? 2000, voiceId: request.voiceId, model: request.body.model_id, speed: settings.speed, stability: settings.stability, similarity: settings.similarity_boost, expressiveness: settings.style, language: params.language, previousText: params.previousText, nextText: params.nextText } }) + '\n');
    }
    return await speechChunks(params, dir, signal, progress, env);
  }
  catch (error) { throw await retainedSpeechError(dir, error) ?? error; }
  finally { release(); }
}

/** Recovery never invokes a provider, including for a missing cache chunk.
 * The exact saved request preserves neighbouring text and voice settings. */
export async function elevenRecover(dir: string, signal?: AbortSignal, progress?: (text: string) => void, env: Env = process.env) {
  const file = path.join(dir, 'speech-request.json');
  if ((await fs.stat(file)).size > 1024 * 1024) throw Error('Saved speech request exceeds 1 MiB');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  if (saved.version !== 1 || saved.account !== digest(keyOf(env) || '') || !saved.params || typeof saved.params !== 'object') throw Error('Saved speech request does not match the current provider account');
  return { ...await elevenSpeech({ ...saved.params, cacheOnly: true }, dir, signal, progress, env), recovery: 'cached responses only; no provider request' };
}

/** Callers can preserve a fresh production folder after synthesis or a later
 * mastering failure. A tagged error carries the exact recoverable cache. */
export async function retainedSpeechError(dir: string, cause: unknown): Promise<Error | undefined> {
  const files = await fs.readdir(dir).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return []; });
  if (!files.some(file => /^speech-[a-f0-9]{64}\.(?:mp3|wav|response\.json|submission\.json)$/.test(file))) return undefined;
  if (cause instanceof Error && (cause as any).retainedSpeechCache === dir) return cause;
  const unknown = files.some(file => file.endsWith('.submission.json') && !files.includes(file.replace('.submission.json', '.response.json')) && !files.includes(file.replace('.submission.json', '.json')));
  return Object.assign(new Error(`${cause instanceof Error ? cause.message : String(cause)}; narration checkpoints retained at ${dir}${unknown ? '; inspect the saved submission and provider history before requesting regeneration' : ' for recovery without another paid request'}`, { cause }), { retainedSpeechCache: dir, ...(unknown ? { submissionOutcomeUnknown: true } : {}) });
}
async function speechChunks(params: any, dir: string, signal?: AbortSignal, progress?: (text: string) => void, env: Env = process.env) {
  const chunks = splitSpeech(params.text, params.chunkChars ?? 2000), outputs: string[] = [], words: Array<{ w: string; s: number; e: number }> = [], receipts: any[] = [];
  const temporary: string[] = [];
  let offset = 0;
  await fs.mkdir(dir, { recursive: true });
  try {
    for (let i = 0; i < chunks.length; i++) {
      signal?.throwIfAborted(); progress?.(`Narration part ${i + 1}/${chunks.length}`);
      const { voiceId, body } = speechRequest({ ...params, previousText: i ? chunks[i - 1].slice(-700) : params.previousText, nextText: i + 1 < chunks.length ? chunks[i + 1].slice(0, 700) : params.nextText }, chunks[i], env);
      const key = digest(JSON.stringify({ voiceId, body, account: digest(keyOf(env) || '') }));
      const audio = path.join(dir, `speech-${key}.mp3`), receiptPath = path.join(dir, `speech-${key}.json`), responsePath = path.join(dir, `speech-${key}.response.json`), submissionPath = path.join(dir, `speech-${key}.submission.json`);
      let receipt: any;
      if (await speechFileExists(receiptPath)) {
        if ((await fs.stat(receiptPath)).size > 4 * 1024 * 1024) throw Error('Cached speech receipt exceeds its byte budget');
        try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      const validWords = receipt && Number.isFinite(receipt.seconds) && receipt.seconds > 0 && Array.isArray(receipt.words) && receipt.words.length && receipt.words.map((w: any) => w?.w).join(' ') === chunks[i].trim().replace(/\s+/gu, ' ') && receipt.words.every((w: any, n: number) => typeof w?.w === 'string' && Number.isFinite(w.s) && Number.isFinite(w.e) && w.s >= 0 && w.e > w.s && w.e <= receipt.seconds + 0.05 && (!n || w.s >= receipt.words[n - 1].e - 0.02));
      const reused = Boolean(validWords && await speechFileExists(audio) && (await fs.stat(audio)).size <= 64 * 1024 * 1024 && digest(await fs.readFile(audio)) === receipt.sha256);
      let recovered = false;
      if (!reused) {
        const pending = await fs.stat(responsePath).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        if (pending) {
          if (!pending.isFile() || pending.size > 64 * 1024 * 1024 + 4096) throw Error('Saved speech response exceeds its byte budget');
          recovered = true;
        } else {
          if (await speechFileExists(submissionPath)) throw Error('Narration submission outcome is unknown; no repeat paid request was issued');
          if (params.cacheOnly === true) throw Error('A required speech checkpoint is missing or corrupt; recovery never submits paid work');
          // An incomplete old checkpoint cannot prove what was paid for. Do
          // not turn corruption or a missing receipt into another paid request.
          if (await speechFileExists(audio) || await speechFileExists(receiptPath)) throw Error('Cached speech checkpoint is incomplete or corrupt; clear this exact cache entry before requesting paid regeneration');
          signal?.throwIfAborted();
          await atomicSpeechFile(submissionPath, JSON.stringify({ status: 'submitting', voiceId, model: body.model_id, requestedCharacters: chunks[i].length, submittedAt: new Date().toISOString() }) + '\n');
          let result;
          try { result = await request(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, body, signal, env); }
          catch (error: any) {
            if (error.providerStatus || error.submissionNotSent) await fs.rm(submissionPath, { force: true });
            else await atomicSpeechFile(submissionPath, JSON.stringify({ status: 'unknown', voiceId, model: body.model_id, requestedCharacters: chunks[i].length, recordedAt: new Date().toISOString() }) + '\n');
            throw error;
          }
          const header = JSON.stringify({ requestId: result.requestId, characterCost: result.characterCost });
          // Commit the paid response before alignment parsing, decoding or any
          // cancellable validation. A restart validates it without repaying.
          await atomicSpeechFile(responsePath, Buffer.concat([Buffer.from(header.slice(0, -1) + ',"response":'), result.bytes, Buffer.from('}\n')]));
        }
        const saved = JSON.parse(await fs.readFile(responsePath, 'utf8')), json = saved.response;
        const aligned = characterWords(json.alignment, chunks[i]);
        if (typeof json.audio_base64 !== 'string' || !json.audio_base64.length || !/^[a-zA-Z0-9+/=\r\n]+$/.test(json.audio_base64)) throw Error('Invalid ElevenLabs audio payload');
        const bytes = Buffer.from(json.audio_base64, 'base64');
        await atomicSpeechFile(audio, bytes);
        receipt = { words: aligned, voiceId, model: body.model_id, sha256: digest(bytes), requestId: saved.requestId, characterCost: saved.characterCost, requestedCharacters: chunks[i].length };
      }
      // Use decoded PCM length, not MP3 container padding, at every seam.
      const pcm = path.join(dir, `pcm-${key}.wav`);
      temporary.push(pcm);
      await fs.rm(pcm, { force: true });
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(audio, 0), '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', pcm], signal);
      const decoded = Number((await probe(pcm, signal)).format?.duration);
      if (!Number.isFinite(decoded) || decoded <= 0 || receipt.words.at(-1).e > decoded + 0.05) throw Error('Speech word timing exceeds decoded PCM duration');
      receipt.seconds = decoded;
      if (!reused) await atomicSpeechFile(receiptPath, JSON.stringify(receipt) + '\n');
      await fs.rm(responsePath, { force: true });
      await fs.rm(submissionPath, { force: true });
      words.push(...receipt.words.map((w: any) => ({ ...w, s: w.s + offset, e: w.e + offset })));
      receipts.push({ requestId: receipt.requestId, characterCost: receipt.characterCost, requestedCharacters: receipt.requestedCharacters, reused: reused || recovered, ...(recovered ? { recovered: true } : {}) });
      offset += decoded; outputs.push(pcm);
    }
    const output = path.join(dir, `speech-${digest(outputs.join('|') + randomBytes(8).toString('hex'))}.wav`);
    temporary.push(output);
    // Fixed generated basenames and safe concat demuxer: caller paths never
    // enter the list. Decode PCM seams and encode speech only once downstream.
    const list = path.join(dir, 'speech-parts.txt');
    temporary.push(list);
    if (outputs.length === 1) await fs.rename(outputs[0], output);
    else {
      await atomicSpeechFile(list, outputs.map(p => `file '${path.basename(p)}'`).join('\n') + '\n');
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-c:a', 'pcm_s16le', output], signal, 300_000);
    }
    const seconds = Number((await probe(output, signal)).format?.duration);
    if (words.at(-1)!.e > seconds + 0.05) throw Error('Joined word timing exceeds decoded narration');
    signal?.throwIfAborted();
    temporary.splice(temporary.indexOf(output), 1);
    return { raw: output, seconds, words, provider: 'elevenlabs', timing: 'provider-character-alignment', receipts, voiceId: params.voiceId ?? elevenStatus(env).voiceId, model: params.model ?? elevenStatus(env).model };
  } finally { await Promise.all(temporary.map(file => fs.rm(file, { force: true }))); }
}

async function atomicSpeechFile(file: string, bytes: string | Buffer) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function speechFileExists(file: string) {
  try { await fs.stat(file); return true; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return false; }
}

export async function writeSpeechCaptions(dir: string, text: string, seconds: number, words: Array<{ w: string; s: number; e: number }>) {
  const track = captionChunks(text, seconds, 7, 42, words);
  const srt = path.join(dir, 'captions.srt'), vtt = path.join(dir, 'captions.vtt');
  await atomicSpeechFile(srt, toSrt(track)); await atomicSpeechFile(vtt, toVtt(track));
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
  if (!keyOf(env)) throw Object.assign(new Error('Audio was not submitted: ElevenLabs is not configured. Inspect music_compose for local music or audio_synth for local procedural sounds; preserve the selected hosted route if required.'), { submissionNotSent: true });
  const dir = await outputFolder(params.outputDir, cwd), file = path.join(dir, 'generated.mp3');
  let saved = false;
  let pending: any = { provider: 'elevenlabs', kind: params.kind, model: body.model_id, requestedSeconds: seconds, decodeVerified: false, status: 'submitting', prompt: params.prompt, submittedAt: new Date().toISOString() };
  let submitted = false;
  try {
    // Validate the output destination before paying, and commit received
    // bytes before cancellable validation. Failed validation retains them.
    signal?.throwIfAborted();
    await atomicSpeechFile(path.join(dir, 'generation.json'), JSON.stringify(pending, null, 2) + '\n');
    let response;
    try {
      submitted = true;
      response = await request(music ? '/music' : '/sound-generation?output_format=mp3_44100_128', body, signal, env);
    } catch (error: any) {
      if (error.providerStatus || error.submissionNotSent) submitted = false;
      throw error;
    }
    await atomicSpeechFile(file, response.bytes); saved = true;
    pending = { provider: 'elevenlabs', kind: params.kind, model: body.model_id, requestedSeconds: seconds, requestId: response.requestId, songId: response.songId, characterCost: response.characterCost, sourceSha256: digest(response.bytes), decodeVerified: false, status: 'pending_validation', prompt: params.prompt };
    await atomicSpeechFile(path.join(dir, 'generation.json'), JSON.stringify(pending, null, 2) + '\n');
    const info = await probe(file, signal), stream = requireStream(info, 'audio'), actualSeconds = Number(stream.duration ?? info.format?.duration);
    if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) throw Error('Generated audio has no finite positive duration');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(file, 0), '-f', 'null', '-'], signal);
    const result = { artifact: await produced(file), provider: 'elevenlabs', kind: params.kind, model: body.model_id, seconds: actualSeconds, requestedSeconds: seconds, requestId: response.requestId, songId: response.songId, characterCost: response.characterCost, decodeVerified: true,
      note: 'Generated duration is measured, not assumed. Use role:music in audio_mix for narration ducking. Listen for arrangement, seams and a clean ending; an instrumental flag is not a license determination.' };
    await atomicSpeechFile(path.join(dir, 'generation.json'), JSON.stringify({ ...result, sourceSha256: pending.sourceSha256, status: 'completed', prompt: params.prompt }, null, 2) + '\n'); return result;
  } catch (error) {
    if (saved) {
      await atomicSpeechFile(path.join(dir, 'generation.json'), JSON.stringify({ ...pending, status: signal?.aborted ? 'cancelled_validation' : 'failed_validation', artifact: { path: file }, decodeVerified: false }, null, 2) + '\n').catch(() => {});
      throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; generated audio retained for local validation at ${file}; no paid retry was attempted`, { cause: error }), { retainedAudioArtifact: file });
    }
    if (submitted) {
      await atomicSpeechFile(path.join(dir, 'generation.json'), JSON.stringify({ ...pending, status: 'unknown' }, null, 2) + '\n').catch(() => {});
      throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; audio submission outcome is unknown; inspect ${path.join(dir, 'generation.json')} and provider history before requesting regeneration`, { cause: error }), { retainedAudioSubmission: path.join(dir, 'generation.json') });
    }
    await fs.rm(dir, { recursive: true, force: true }); throw error;
  }
}
