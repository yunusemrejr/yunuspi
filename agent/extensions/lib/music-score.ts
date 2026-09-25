import fs from "node:fs/promises";
import path from "node:path";
import { integer, number, outputFolder, produced } from "./media-process.ts";

const PPQ = 480, RATE = 44100;
/** Band-limited oscillator: harmonics stop below Nyquist, so square and saw
 * stay clean at high pitches. Sine and triangle match the original audition
 * exactly. Pure. */
export function oscillator(waveform: string, phase: number, freq: number): number {
  if (waveform === "triangle") {
    let wave = 0;
    for (let h = 1; h <= 15 && h * freq < RATE / 2; h += 2) wave += (h % 4 === 1 ? 1 : -1) * Math.sin(h * phase) / (h * h);
    return wave * 8 / (Math.PI * Math.PI);
  }
  if (waveform === "square") {
    let wave = 0;
    for (let h = 1; h <= 15 && h * freq < RATE / 2; h += 2) wave += Math.sin(h * phase) / h;
    return wave * 4 / Math.PI;
  }
  if (waveform === "saw") {
    let wave = 0;
    for (let h = 1; h <= 15 && h * freq < RATE / 2; h++) wave += (h % 2 === 1 ? 1 : -1) * Math.sin(h * phase) / h;
    return wave * 2 / Math.PI;
  }
  return Math.sin(phase);
}
function vlq(n: number): number[] {
  const out = [n & 127];
  while ((n = Math.floor(n / 128)) > 0) out.unshift((n & 127) | 128);
  return out;
}
function chunk(tag: string, bytes: number[] | Buffer) {
  const header = Buffer.alloc(8); header.write(tag); header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, Buffer.from(bytes)]);
}
function track(events: { tick: number; order: number; bytes: number[] }[], end: number) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let previous = 0; const bytes: number[] = [];
  for (const e of events) { bytes.push(...vlq(e.tick - previous), ...e.bytes); previous = e.tick; }
  bytes.push(...vlq(Math.max(0, end - previous)), 255, 47, 0);
  return chunk("MTrk", bytes);
}
export function validateScore(input: any) {
  if (!input || typeof input !== "object") throw new Error("score must be an object");
  const bpm = number(input.bpm, 120, 30, 300, "bpm");
  const beats = number(input.beats, 16, 1, 256, "beats");
  const seconds = beats * 60 / bpm;
  if (seconds > 120) throw new Error("Score preview is limited to 120 seconds");
  const numerator = integer(input.numerator, 4, 1, 16, "numerator");
  const denominator = integer(input.denominator, 4, 2, 16, "denominator");
  if (![2, 4, 8, 16].includes(denominator)) throw new Error("denominator must be 2, 4, 8 or 16");
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 8) throw new Error("Provide 1..8 tracks");
  const stereo = input.stereo ?? false;
  if (typeof stereo !== "boolean") throw new Error("stereo must be true or false");
  let count = 0, noteSeconds = 0;
  const tracks = input.tracks.map((t: any, channel: number) => {
    if (!t || typeof t !== "object" || !Array.isArray(t.notes) || !t.notes.length) throw new Error("Each track needs notes");
    count += t.notes.length; if (count > 1024) throw new Error("Score is limited to 1024 notes");
    const name = typeof t.name === "string" ? t.name.slice(0, 64) : `Track ${channel + 1}`;
    const program = integer(t.program, 0, 0, 127, "program");
    const waveform = t.waveform ?? "sine";
    if (!["sine", "triangle", "square", "saw"].includes(waveform)) throw new Error("waveform must be sine, triangle, square or saw");
    const pan = number(t.pan, 0, -1, 1, "pan");
    const notes = t.notes.map((n: any) => {
      if (!n || typeof n !== "object") throw new Error("Each note must be an object");
      const pitch = integer(n.pitch, 60, 0, 127, "pitch");
      const start = number(n.start, 0, 0, beats, "note start");
      const duration = number(n.duration, 1, 1 / PPQ, beats, "note duration");
      const velocity = integer(n.velocity, 90, 1, 127, "velocity");
      if (start + duration > beats + 1e-8) throw new Error("Note extends beyond score beats");
      const tick = Math.round(start * PPQ), end = Math.round((start + duration) * PPQ);
      if (end <= tick) throw new Error("Note duration rounds to zero MIDI ticks");
      noteSeconds += (end - tick) / PPQ * 60 / bpm;
      return { pitch, start: tick / PPQ, duration: (end - tick) / PPQ, velocity };
    });
    // Same-pitch overlap on one channel has ambiguous note-off semantics.
    for (let pitch = 0; pitch < 128; pitch++) {
      const lane = notes.filter((n: any) => n.pitch === pitch).sort((a: any, b: any) => a.start - b.start);
      for (let i = 1; i < lane.length; i++) if (lane[i].start < lane[i - 1].start + lane[i - 1].duration - 1e-8) throw new Error("Overlapping same-pitch notes need separate tracks");
    }
    return { name, program, waveform, pan, notes };
  });
  if (noteSeconds > 1200) throw new Error("Score exceeds the preview work limit");
  return { bpm, beats, numerator, denominator, seconds, stereo, tracks };
}
export async function composeMusic(params: any, cwd: string, signal?: AbortSignal) {
  const score = validateScore(params.score);
  signal?.throwIfAborted();
  const tempo = Math.round(60000000 / score.bpm), end = Math.round(score.beats * PPQ);
  const conductor = track([
    { tick: 0, order: 0, bytes: [255, 81, 3, tempo >> 16 & 255, tempo >> 8 & 255, tempo & 255] },
    { tick: 0, order: 1, bytes: [255, 88, 4, score.numerator, Math.log2(score.denominator), 24, 8] },
  ], end);
  const tracks = score.tracks.map((t: any, ch: number) => {
    const name = [...Buffer.from(t.name, "utf8")];
    const events = [{ tick: 0, order: -2, bytes: [255, 3, ...vlq(name.length), ...name] }, { tick: 0, order: -1, bytes: [192 | ch, t.program] }];
    for (const n of t.notes) {
      events.push({ tick: Math.round(n.start * PPQ), order: 1, bytes: [144 | ch, n.pitch, n.velocity] });
      events.push({ tick: Math.round((n.start + n.duration) * PPQ), order: 0, bytes: [128 | ch, n.pitch, 0] });
    }
    return track(events, end);
  });
  const header = Buffer.alloc(6); header.writeUInt16BE(1); header.writeUInt16BE(tracks.length + 1, 2); header.writeUInt16BE(PPQ, 4);
  const midi = Buffer.concat([chunk("MThd", header), conductor, ...tracks]);
  // An intentionally simple audition synth. MIDI program changes remain in the MIDI.
  const frames = Math.ceil(score.seconds * RATE);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (const t of score.tracks) for (const n of t.notes) {
    signal?.throwIfAborted();
    const from = Math.round(n.start * 60 / score.bpm * RATE);
    const length = Math.round(n.duration * 60 / score.bpm * RATE);
    const freq = 440 * 2 ** ((n.pitch - 69) / 12);
    // Constant-power pan; mono mixes keep the original center sum exactly.
    const angle = (t.pan + 1) * Math.PI / 4;
    const gl = Math.cos(angle), gr = Math.sin(angle);
    if (freq < RATE / 2) for (let i = 0; i < length && from + i < frames; i++) {
      const wave = oscillator(t.waveform, 2 * Math.PI * freq * i / RATE, freq);
      const envelope = Math.min(1, i / (RATE * 0.008), (length - 1 - i) / (RATE * 0.025));
      const sample = wave * Math.max(0, envelope) * n.velocity / 127 * 0.18;
      left[from + i] += sample * (score.stereo ? gl : 1);
      if (score.stereo) right[from + i] += sample * gr;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const mix = score.stereo ? [left, right] : [left];
  let peak = 0; for (const channel of mix) for (const v of channel) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0.89 ? 0.89 / peak : 1;
  const channels = mix.length, block = channels * 2;
  const wav = Buffer.alloc(44 + frames * block);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * block, 28); wav.writeUInt16LE(block, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * block, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) wav.writeInt16LE(Math.round(mix[c][i] * gain * 32767), 44 + (i * channels + c) * 2);
  signal?.throwIfAborted();
  const dir = await outputFolder(params.outputDir, cwd);
  try {
    await fs.writeFile(path.join(dir, "score.mid"), midi, { flag: "wx" });
    await fs.writeFile(path.join(dir, "preview.wav"), wav, { flag: "wx" });
    await fs.writeFile(path.join(dir, "score.json"), JSON.stringify(score, null, 2) + "\n", { flag: "wx" });
    return { files: await Promise.all(["score.mid", "preview.wav", "score.json"].map(f => produced(path.join(dir, f)))), seconds: score.seconds, bpm: score.bpm, channels, previewGain: gain, note: "Editable MIDI and score; WAV is a sine/triangle/square/saw audition (mono unless stereo:true), not a General MIDI instrument rendering. Beat units are quarter notes." };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
