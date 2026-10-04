#!/usr/bin/env node
// Final composite without a framework: an HTML-rendered (or any) background video, a Blender RGBA sequence over it, a grade, audio.
//
//   node composite.mjs --bg motion.mp4 --shot public/shots/gauge --out comp.mp4 [--audio mix.wav] [--fps 30] [--x 0.5 --y 0.5 --scale 1] [--grade warm|cool|none]
//
// TAGS      grade composite overlay alpha background video blend frame rate ffmpeg hybrid
// CONCEPTS  1) overlay with format=auto keeps the sequence's straight alpha, so soft shadows composite correctly
//           2) a low-fps render is brought to the film rate by blending neighbours (minterpolate mi_mode=blend), not by repeating frames
//           3) a shot that does not loop holds its last frame (tpad) while the background keeps running
//           4) the grade is one curves/eq pass over the finished picture, so 2D and 3D layers share it
//           5) audio is mapped explicitly and the output is cut to the video's duration; nothing is re-timed by accident
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith("--") ? [...out, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : out), []));
if (!args.bg || !args.shot || !args.out) throw new Error("usage: composite.mjs --bg VIDEO --shot SHOT_DIR --out OUT.mp4 [--audio FILE] [--fps 30] [--x 0.5 --y 0.5 --scale 1] [--grade warm|cool|none]");
const shot = JSON.parse(fs.readFileSync(path.join(args.shot, "shot.json"), "utf8"));
const fps = Number(args.fps ?? 30), x = Number(args.x ?? 0.5), y = Number(args.y ?? 0.5), scale = Number(args.scale ?? 1);
const grade = { warm: "eq=contrast=1.04:saturation=1.05,colorbalance=rs=0.02:bs=-0.02", cool: "eq=contrast=1.04:saturation=1.03,colorbalance=rs=-0.02:bs=0.03", none: "null" }[args.grade ?? "none"];
const lift = fps > shot.fps ? `minterpolate=fps=${fps}:mi_mode=blend,` : "";
const filter = [
  `[1:v]format=rgba,${lift}${shot.loop ? "" : "tpad=stop=-1:stop_mode=clone,"}scale=iw*${scale}:ih*${scale}[fg]`,
  `[0:v][fg]overlay=x=(W-w)*${x}:y=(H-h)*${y}:format=auto:shortest=1,${grade},format=yuv420p[v]`,
].join(";");
const input = ["-i", args.bg, "-framerate", String(shot.fps), ...(shot.loop ? ["-stream_loop", "-1"] : []), "-i", path.join(args.shot, shot.pattern)];
const audio = args.audio ? ["-i", args.audio] : [];
const map = ["-map", "[v]", ...(args.audio ? ["-map", `${audio.length ? 2 : 1}:a`, "-c:a", "aac", "-b:a", "192k"] : [])];
execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", ...input, ...audio, "-filter_complex", filter, ...map, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-shortest", args.out], { stdio: "inherit" });
console.log(JSON.stringify({ out: args.out, fps, shot: path.basename(args.shot), shotFps: shot.fps, blended: Boolean(lift), graded: args.grade ?? "none" }));
