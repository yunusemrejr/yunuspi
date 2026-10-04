#!/usr/bin/env node
// Kinetic typography with no browser: an ASS subtitle script (libass) burned over a generated gradient field.
//
//   node ass-kinetic.mjs --text "Measure what the *water* does" --out kinetic.mp4 [--seconds 5] [--font "Archivo Black"] [--bg "#10181c" --bg2 "#1d3b45"] [--ink "#eef2f0" --accent "#e9a63d"]
//
// CONCEPTS  1) ASS override tags animate text natively: \t(t1,t2,...) interpolates scale, rotation, blur and colour between times
//           2) \move and \fad give slide and fade; \clip with \t reveals a line through a moving window (a mask wipe)
//           3) one event per word, each with its own start time, gives the stagger; the delay follows syllable weight like a reading rhythm.
//              Every event holds the whole row with the other words transparent, so libass does the layout and no width is guessed
//           4) \blur and \bord shape edges so text has body without a glow; \an5 pins anchors so scaling happens around the word's centre
//           5) rendering is libass inside FFmpeg: fast, deterministic, and runs anywhere FFmpeg runs, with fonts taken from fontconfig
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const a = Object.fromEntries(process.argv.slice(2).reduce((o, x, i, all) => (x.startsWith("--") ? [...o, [x.slice(2), all[i + 1]]] : o), []));
if (!a.text || !a.out) throw new Error('usage: ass-kinetic.mjs --text "words with *focus*" --out OUT.mp4 [--seconds 5] [--font NAME] [--bg #hex --bg2 #hex --ink #hex --accent #hex]');
const seconds = Number(a.seconds ?? 5), W = 1280, H = 720, font = a.font ?? "DejaVu Sans", ink = a.ink ?? "#f1f4e6", accent = a.accent ?? "#d6e35a", bg = a.bg ?? "#0d1512", bg2 = a.bg2 ?? "#1c3326";
const bgr = hex => { const n = parseInt(hex.slice(1), 16); return `&H${[n & 255, (n >> 8) & 255, n >> 16].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase()}&`; };   // ASS colours are BGR
const stamp = s => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const words = a.text.split(" "), syllables = w => Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
const size = 104, lines = words.join(" ").length * size * 0.62 > W * 0.9 ? 2 : 1, per = Math.ceil(words.length / lines);
// libass lays each row out, so spacing is always right for the font in use. Each word is its own event holding the WHOLE row, with every
// other word made transparent: the visible word sits exactly where it belongs, and animating it never reflows its neighbours.
// Squash-and-stretch uses \fscy (vertical only), which changes no advance widths, so nothing shifts sideways.
let clock = 0.3; const events = [];
for (let l = 0; l < lines; l++) {
  const row = words.slice(l * per, (l + 1) * per), y = H / 2 + (l - (lines - 1) / 2) * size * 1.25;
  row.forEach((word, i) => {
    const focus = word.startsWith("*") || word.endsWith("*"), t0 = clock, t1 = seconds - 0.5;
    const text = row.map((w, j) => (j === i ? `{\\alpha&H00&${focus ? `\\1c${bgr(accent)}\\t(500,900,\\bord6)` : ""}}${w.replaceAll("*", "")}` : `{\\alpha&HFF&\\bord0}${w.replaceAll("*", "")}`)).join(" ");
    events.push(`Dialogue: 0,${stamp(t0)},${stamp(t1)},Word,,0,0,0,,{\\an5\\move(${W / 2},${y + 40},${W / 2},${y},0,380)\\fad(180,260)\\fscy70\\t(0,260,\\fscy112)\\t(260,420,\\fscy100)}${text}`);
    clock += 0.1 + 0.05 * syllables(word.replaceAll("*", ""));
  });
}
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Word,${font},${size},${bgr(ink)},&H000000FF,${bgr(bg)},&H00000000,-1,0,0,0,100,100,-1,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join("\n")}\n`;
const file = path.join(os.tmpdir(), `kinetic-${process.pid}.ass`); fs.writeFileSync(file, ass);
try {
  execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=${bg}:c1=${bg2}:x0=0:y0=0:x1=${W}:y1=${H}:d=${seconds}:r=30`, "-vf", `subtitles=${file}:fontsdir=/usr/share/fonts,format=yuv420p`, "-t", String(seconds), "-c:v", "libx264", "-crf", "18", a.out], { stdio: "inherit" });
} finally { fs.rmSync(file, { force: true }); }
console.log(JSON.stringify({ out: a.out, seconds, words: words.length, lines }));
