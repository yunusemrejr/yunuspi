// Narration captions without a speech aligner. Words are timed by syllable
// weight across the measured narration length, with pauses at punctuation,
// then grouped into short chunks a viewer can read at a glance. Pure and
// deterministic: the same text and length always give the same captions, so
// stills, previews, the final render and the SRT/VTT sidecars agree.

export type CaptionWord = { word: string; start: number; end: number };
export type CaptionChunk = { text: string; start: number; end: number; words: CaptionWord[] };

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return /\d/.test(word) ? Math.max(1, word.replace(/\D/g, "").length) : 1;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, trimmed.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

/** Seconds a narration of this text roughly takes at documentary pace. */
export function estimateSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / 2.6) * 10) / 10);
}

/** Start and end seconds (relative to the narration start) for each word. */
export function timeWords(text: string, seconds: number): CaptionWord[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || !(seconds > 0)) return [];
  const units = words.map((word) => {
    const speak = syllables(word) + 0.5;
    const pause = /[.!?…]["')\]]*$/.test(word) ? 2.4 : /[,;:—–-]["')\]]*$/.test(word) ? 1.2 : 0;
    return { word, speak, pause };
  });
  const total = units.reduce((sum, u, i) => sum + u.speak + (i < units.length - 1 ? u.pause : 0), 0);
  const scale = seconds / total;
  let t = 0;
  return units.map((u, i) => {
    const start = t;
    const end = t + u.speak * scale;
    t = end + (i < units.length - 1 ? u.pause * scale : 0);
    return { word: u.word, start: round(start), end: round(end) };
  });
}

/** Group timed words into chunks of at most `maxWords` words and `maxChars`
 * characters, breaking early at sentence ends and at clause breaks once a
 * chunk has three words. Each chunk stays up until the next begins. */
export function captionChunks(text: string, seconds: number, maxWords = 7, maxChars = 42): CaptionChunk[] {
  const words = timeWords(text, seconds);
  const chunks: CaptionChunk[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push({ text: current.map((w) => w.word).join(" "), start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
  };
  for (const word of words) {
    const length = current.map((w) => w.word).join(" ").length + word.word.length + 1;
    if (current.length >= maxWords || (current.length && length > maxChars)) flush();
    current.push(word);
    if (/[.!?…]["')\]]*$/.test(word.word) || (current.length >= 3 && /[,;:]["')\]]*$/.test(word.word))) flush();
  }
  flush();
  // Hold each chunk until the next one starts (short gaps read as flicker).
  for (let i = 0; i < chunks.length - 1; i++) if (chunks[i + 1].start - chunks[i].end < 0.6) chunks[i].end = chunks[i + 1].start;
  return chunks;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const stamp = (seconds: number, separator: string) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(f).padStart(3, "0")}`;
};
/** Sidecar subtitles from absolute-time chunks. */
export function toSrt(chunks: Array<{ text: string; start: number; end: number }>): string {
  return chunks.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
}
export function toVtt(chunks: Array<{ text: string; start: number; end: number }>): string {
  return `WEBVTT\n\n${chunks.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`;
}
