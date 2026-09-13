import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";

const exec = promisify(execFile);
// Container-only demuxers: no playlists, concat scripts or remote protocols.
export const INPUT_FLAGS = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,wav,mp3,flac,ogg,aac,aiff,flv,mpeg,mpegts"];
export const FFMPEG_FLAGS = ["-hide_banner", "-nostdin", "-n", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"];

export function number(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const n = number(value, fallback, min, max, name);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}
export function textPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("Use a local filesystem path, not a URL or protocol");
  return value;
}
export async function inputFile(value: unknown, cwd: string): Promise<string> {
  const file = canonicalMutationPath(textPath(value), cwd);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("Input must be a regular local file");
  return file;
}
export async function outputFolder(value: unknown, cwd: string): Promise<string> {
  const root = await fs.realpath(cwd);
  const parent = canonicalMutationPath(textPath(value ?? "."), root);
  if (!containsPath(root, parent)) throw new Error("Output directory must be inside the current workspace");
  const output = path.join(parent, `media-${randomBytes(8).toString("hex")}`);
  const denial = selfMutationDenial(output, root);
  if (denial) throw new Error(denial);
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Output directory must already exist");
  // Unique directory and no-overwrite FFmpeg semantics preserve all source files.
  await fs.mkdir(output, { mode: 0o700 });
  return output;
}
export async function run(binary: string, args: string[], signal?: AbortSignal, timeout = 120000) {
  signal?.throwIfAborted();
  try {
    const result = await exec(binary, args, { encoding: "utf8", signal, timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" } });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    if (signal?.aborted) throw new Error("Media operation cancelled");
    if (error.code === "ENOENT") throw new Error(`${binary} is not installed or not on PATH`);
    if (error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`${binary} exceeded its time/output bound`);
    throw new Error(`${binary} failed: ${String(error.stderr || error.message).slice(-3000)}`);
  }
}
export async function probe(file: string, signal?: AbortSignal): Promise<any> {
  const { stdout } = await run("ffprobe", ["-v", "error", ...INPUT_FLAGS, "-show_entries", "format=format_name,duration,start_time,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,display_aspect_ratio,r_frame_rate,avg_frame_rate,time_base,start_time,duration,sample_rate,channels,channel_layout,color_space,color_transfer,color_primaries:stream_disposition=attached_pic:stream_side_data=rotation", "-of", "json", file], signal, 20000);
  return JSON.parse(stdout);
}
export function requireStream(info: any, type: string) {
  const stream = info.streams?.find((s: any) => s.codec_type === type && !s.disposition?.attached_pic);
  if (!stream) throw new Error(`Input has no ${type} stream`);
  return stream;
}
export function windowParams(params: any) {
  return { start: number(params.start, 0, 0, 86400, "start"), duration: number(params.duration, 30, 0.05, 600, "duration") };
}
export function inputArgs(file: string, start: number) { return [...INPUT_FLAGS, "-ss", String(start), "-i", file]; }
export async function produced(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw new Error("Renderer produced no media");
  return { path: file, bytes: stat.size };
}
