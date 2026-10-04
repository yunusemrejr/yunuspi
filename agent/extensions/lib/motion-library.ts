/** The motion-approaches example library: worked, verified examples of motion
 * graphics in several approaches (vanilla HTML/CSS/JS/WebGL pages, Blender
 * scripts, HTML-plus-Blender merges, FFmpeg/libass, numpy). The catalog is read
 * from each example's own header comment, so a description cannot drift from the
 * file it describes. Search ranks by the words of the task; copy places an
 * example where the video project already looks for it. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectDir, projectWritePath } from "./video-studio.ts";

const SKILL = fileURLToPath(new URL("../../skills/motion-approaches/", import.meta.url));
const ROOT = path.join(SKILL, "assets", "examples");
export const MOTION_APPROACHES = ["html", "blender", "merge", "ffmpeg", "python"] as const;
export type MotionApproach = (typeof MOTION_APPROACHES)[number];
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "make", "video", "motion", "graphics", "scene", "using", "use", "want", "need", "like"]);

export type MotionExample = { id: string; approach: MotionApproach; file: string; title: string; summary: string; concepts: string[]; use: string[]; tags: string; bytes: number };

/** The leading comment of an example, whichever language it is written in. */
function headerBlock(source: string, file: string): string {
  if (file.endsWith(".html")) return /<!--([\s\S]*?)-->/.exec(source)?.[1] ?? "";
  if (file.endsWith(".py")) return /^(?:#!.*\n)?\s*"""([\s\S]*?)"""/.exec(source)?.[1] ?? "";
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    lines.push(line.replace(/^\/\/ ?/, ""));
  }
  return lines.join("\n");
}

export function parseExample(file: string, source: string): Omit<MotionExample, "bytes"> {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const block = headerBlock(source, file), lines = block.split("\n");
  const keyword = /^(APPROACH|CONCEPTS|USE|TAGS)\b\s*(.*)$/;
  const concepts: string[] = [];
  const use: string[] = [];
  let summary = "", tags = "";
  for (const raw of lines) {
    const line = raw.trim();
    const key = keyword.exec(line);
    const numbered = /^(?:CONCEPTS\s+)?(\d+)\)\s*(.*)$/.exec(line);
    if (key?.[1] === "APPROACH") summary = key[2];
    else if (key?.[1] === "USE") use.push(key[2]);
    else if (key?.[1] === "TAGS") tags = key[2];
    else if (numbered) concepts.push(numbered[2]);
    else if (concepts.length && line && !/^[A-Z]{3,}\b/.test(line) && /^\s{4,}\S/.test(raw)) concepts[concepts.length - 1] += ` ${line}`;
    else if (!concepts.length && /^\s{2,}\S/.test(raw)) use.push(line);          // indented command lines above the concepts
  }
  const first = lines.map((l) => l.trim()).find((l) => l && !keyword.test(l)) ?? "";
  const title = file.endsWith(".html") ? (/<title>([^<]*)<\/title>/.exec(source)?.[1] ?? rel) : first.replace(/\.$/, "");
  return { id: rel.replace(/\.[^.]+$/, ""), approach: rel.split("/")[0] as MotionApproach, file: rel, title: title || rel, summary: summary || first || title, concepts, use: use.filter(Boolean), tags };
}

let cached: Promise<MotionExample[]> | undefined;
export function motionCatalog(): Promise<MotionExample[]> {
  cached ??= (async () => {
    const found: MotionExample[] = [];
    for (const approach of MOTION_APPROACHES) {
      for (const name of (await fs.readdir(path.join(ROOT, approach)).catch(() => [])).sort()) {
        if (!/\.(html|py|mjs)$/.test(name)) continue;
        const file = path.join(ROOT, approach, name), source = await fs.readFile(file, "utf8");
        found.push({ ...parseExample(file, source), bytes: Buffer.byteLength(source) });
      }
    }
    return found;
  })();
  return cached;
}

const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "");
const tokens = (text: string) => Array.from(new Set((text.toLowerCase().match(/[a-z0-9]{3,}|\b[23]d\b/g) ?? []).filter((t) => !STOP.has(t)).map(stem)));

/** Examples ranked by how many of the task's words their id, title, summary and concepts contain. */
export async function searchMotion(query: string, approach?: MotionApproach, limit = 5) {
  const want = tokens(query);
  const scored = (await motionCatalog()).filter((example) => !approach || example.approach === approach).map((example) => {
    const id = tokens(`${example.id} ${example.title}`), summary = tokens(`${example.summary} ${example.tags}`), concepts = tokens(example.concepts.join(" "));
    const score = want.reduce((sum, token) => sum + (id.includes(token) ? 3 : 0) + (summary.includes(token) ? 2 : 0) + (concepts.includes(token) ? 1 : 0), 0);
    return { example, score };
  });
  const hits = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return { matches: hits.map(({ example, score }) => ({ ...brief(example), score })), none: hits.length === 0 ? scored.map(({ example }) => `${example.id}: ${example.title}`) : undefined };
}

const brief = (example: Omit<MotionExample, "bytes">) => ({ id: example.id, approach: example.approach, title: example.title, summary: example.summary, concepts: example.concepts.map((c) => (c.length > 150 ? `${c.slice(0, 147)}...` : c)), use: example.use.slice(0, 3) });

export async function motionExample(id: string, withSource: boolean) {
  const example = (await motionCatalog()).find((entry) => entry.id === id || entry.file === id);
  if (!example) throw new Error(`No example "${id}". Search first (motion_examples action:"search"); ids look like html/webgl-domain-warp.`);
  const file = path.join(ROOT, example.file);
  return { ...brief(example), file, ...(withSource ? { source: await fs.readFile(file, "utf8") } : { bytes: example.bytes, note: "Add source:true to read the file, or action:\"copy\" to place it in a project." }) };
}

/** Where a project looks for each kind of example, and what to do with it next. */
function destination(example: MotionExample, name: string): { rel: string[]; then: string } {
  if (example.file.endsWith(".html")) return { rel: ["public", "html", `${name}.html`], then: `{"component":"HtmlScene","props":{"src":"html/${name}.html","props":{}}} in video.json; the page reads window.__PROPS__ (theme and fonts arrive automatically)` };
  if (example.approach === "blender") return { rel: ["blender", "scripts", `${name}.py`], then: `blender_run script:"blender/scripts/${name}.py" with the args its header lists, then video_shot on the saved .blend` };
  return { rel: ["scripts", `${name}${path.extname(example.file)}`], then: `run it from the project: ${example.file.endsWith(".py") ? "python3" : "node"} scripts/${name}${path.extname(example.file)} (see its header for arguments)` };
}

export async function copyMotionExample(params: any, cwd: string) {
  const dir = await projectDir(params.dir, cwd);
  const example = (await motionCatalog()).find((entry) => entry.id === params.id || entry.file === params.id);
  if (!example) throw new Error(`No example "${params.id}". Search first (motion_examples action:"search").`);
  const name = String(params.name ?? path.basename(example.file, path.extname(example.file)));
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) throw new Error("name must be lowercase kebab-case, at most 48 characters");
  const place = destination(example, name);
  const target = projectWritePath(dir, ...place.rel);
  const exists = await fs.stat(target).then(() => true, () => false);
  if (exists && params.replace !== true) throw new Error(`${place.rel.join("/")} already exists; pass replace:true or another name`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(ROOT, example.file), target);
  return { copied: place.rel.join("/"), from: example.file, then: place.then, note: "The copy is yours to edit: change its palette, type and timing to the film's look before using it; the header documents the technique and the props." };
}

/** The decision guide between approaches (references/choosing.md), for the model to read in full. */
export async function motionGuide() {
  const dir = path.join(SKILL, "references");
  const guides = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".md")).sort();
  const choosing = await fs.readFile(path.join(dir, "choosing.md"), "utf8").catch(() => "");
  return { choosing, guides: guides.map((name) => `agent/skills/motion-approaches/references/${name}`), approaches: MOTION_APPROACHES };
}
