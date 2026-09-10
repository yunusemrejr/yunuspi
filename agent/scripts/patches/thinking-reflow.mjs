// Thinking display repair v4. Raw provider deltas and persisted reasoning
// must remain lossless: normalization belongs only to the TUI renderer.
// Retain exact v3.1 anchors to remove the old accumulation rewrite safely.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const THINKING_MARKER = "function normalizeThinkingStream";

// Canonical v3.1 normalizer — the live chunk's copy must stay byte-identical
// to this (String.raw keeps the \n escapes literal, matching the minified
// bundle style).
const NORMALIZER = String.raw`function normalizeThinkingStream(raw){if(!raw.includes("\n"))return raw;let lines=raw.split("\n").filter(l=>l.length>0);if(lines.length<4)return raw;let single=0,spaceLead=0,spaceOnly=0,total=0;for(let line of lines){let trimmed=line.trim();if(!trimmed){spaceOnly++;continue}if(!trimmed.includes(" "))single++;if(/^ /.test(line))spaceLead++;total+=trimmed.length}let nonEmpty=lines.length-spaceOnly;if(spaceOnly*4>=lines.length){if(!nonEmpty)return"";if(single/nonEmpty>=.35&&total/nonEmpty<=20)return lines.filter(l=>l.trim().length>0).join(spaceLead/nonEmpty>=.25?"":" ")}if(nonEmpty<4||single/nonEmpty<.35||total/nonEmpty>20)return raw;let nlCount=0,totalRuns=0,heavyRuns=0;for(let idx=0;idx<raw.length;idx++){if(raw[idx]==="\n"){nlCount++;continue}if(nlCount>0){totalRuns++;if(nlCount>=3)heavyRuns++;nlCount=0}}if(nlCount>0){totalRuns++;if(nlCount>=3)heavyRuns++}if(spaceLead/lines.length<.25&&heavyRuns/totalRuns<.1)return raw;let sep=spaceLead/nonEmpty>=.25?"":" ";let out="",nlRun=0;for(let idx=0;idx<raw.length;idx++){if(raw[idx]==="\n"){nlRun++;continue}if(nlRun>0){if(sep&&out&&raw[idx]!==" ")out+=sep;nlRun=0}out+=raw[idx]}return out}`;

const A1 =
  'var OPENAI_COMPLETIONS_REASONING_FIELDS=["reasoning","reasoning_content","reasoning_text"];function isOpenAICompletionsReasoningField(field){return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field)}';
const HELPER =
  'var OPENAI_COMPLETIONS_REASONING_FIELDS=["reasoning","reasoning_content","reasoning_text"];\n' +
  "/* pi-harness local patch v3.1 (re-applied by verify-harness.mjs): some OpenRouter providers (Z.AI/GLM, stealth)\n" +
  ' * stream the `reasoning` field as one token per line — or worse, as multi-newline or whitespace-only " \\n\\n" runs —\n' +
  " * which renders as one word per line (or thousands of empty markdown paragraphs) in the TUI. Re-rendering 16k\n" +
  " * empty paragraphs on every delta/refocus is what freezes long sessions. Detected corrupt streams are reflowed to\n" +
  " * one prose blob (wrong mid-sentence gaps are the complaint; a wall of prose is readable); whitespace junk is\n" +
  " * dropped. Real GLM streams mix multi-token lines and often lose their leading spaces, so detection keys on:\n" +
  " * >=35% single-token lines, short average line length, and either the leading-space BPE convention or heavy (3+\n" +
  " * newline) separator gaps. Genuine prose, code and lists fail every gate and pass untouched. */\n" +
  NORMALIZER +
  "function isOpenAICompletionsReasoningField(field){return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field)}";
const A2 = "let textBlock=null,thinkingBlock=null,hasFinishReason=!1";
const B2 =
  'let textBlock=null,thinkingBlock=null,thinkingRaw="",hasFinishReason=!1';
const A3 =
  'block.thinking+=delta,stream2.push({type:"thinking_delta",contentIndex:getContentIndex(block),delta,partial:output})';
const B3 =
  "thinkingRaw+=delta;let thinkingNorm=normalizeThinkingStream(thinkingRaw),thinkingDelta=thinkingNorm.slice(block.thinking.length);" +
  'block.thinking=thinkingNorm,stream2.push({type:"thinking_delta",contentIndex:getContentIndex(block),delta:thinkingDelta,partial:output})';

const DISPLAY_MARKER = '/* PI_THINKING_DISPLAY_V4 */';
const DISPLAY_ANCHOR = 'thinkingContent.thinking.trim()';
const DISPLAY_REPLACEMENT = 'normalizeThinkingStream(thinkingContent.thinking).trim()';
// Structured markdown must not be mistaken for damaged prose token lines.
const DISPLAY_NORMALIZER = NORMALIZER.replace('if(!raw.includes', String.raw`if(/(^|\n)(?:\s*` + '```' + String.raw`|\s*~~~|\s*(?:[-*+]|\d+\.)\s| {4}\S|\t\S)/.test(raw))return raw;if(!raw.includes`);
export function patchProviderSource(source) {
  let next = source;
  if (next.includes(B3)) {
    if (next.split(B3).length !== 2 || !next.includes(HELPER) || !next.includes(B2))
      throw new Error('Thinking stream legacy patch is ambiguous or incomplete');
    next = next.replace(B3, A3).replace(B2, A2).replace(HELPER, A1);
  }
  if (next.split(A3).length !== 2 || next.includes(THINKING_MARKER) || /thinkingRaw|thinkingNorm|thinkingDelta/.test(next))
    throw new Error('Thinking stream anchor drift; raw accumulation not established');
  return next;
}
export function patchRendererSource(source) {
  if (source.includes(DISPLAY_MARKER)) {
    if (source.split(DISPLAY_REPLACEMENT).length !== 2 || !source.includes(DISPLAY_NORMALIZER) || source.includes(DISPLAY_ANCHOR))
      throw new Error('Thinking renderer patch is incomplete or changed');
    return source;
  }
  if (source.split(DISPLAY_ANCHOR).length !== 2 || source.includes(THINKING_MARKER))
    throw new Error('Thinking renderer anchor drift');
  return DISPLAY_MARKER + '\n' + DISPLAY_NORMALIZER + '\n' + source.replace(DISPLAY_ANCHOR, DISPLAY_REPLACEMENT);
}
function makeTarget(name, file, patch) {
  return {
    name, file,
    exists: () => fs.existsSync(file),
    isApplied() {
      try { const source = fs.readFileSync(file, 'utf8'); return patch(source) === source; }
      catch { return false; }
    },
    apply() {
      const source = fs.readFileSync(file, 'utf8');
      const next = patch(source);
      if (source === next) return;
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
      const temp = `${file}.thinking-${process.pid}`;
      fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode });
      fs.renameSync(temp, file);
    },
  };
}
export function targets() {
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    '@earendil-works/pi-coding-agent',
  );
  const chunks = path.join(core, 'dist/bundle/chunks');
  const files = fs.readdirSync(chunks).filter(f => f.endsWith('.js')).map(f => path.join(chunks, f));
  const locate = (label, predicate) => {
    const found = files.filter(f => predicate(fs.readFileSync(f, 'utf8')));
    if (found.length !== 1) throw new Error(`Thinking ${label}: expected one runtime owner, found ${found.length}`);
    return found[0];
  };
  const provider = locate('provider', s => s.includes('OPENAI_COMPLETIONS_REASONING_FIELDS'));
  const renderer = locate('renderer', s => s.includes(DISPLAY_ANCHOR) || s.includes(DISPLAY_REPLACEMENT));
  const sdk = path.join(core, 'dist/modes/interactive/components/assistant-message.js');
  if (!fs.existsSync(sdk)) throw new Error('Thinking SDK renderer missing');
  // Install presentation support before removing the old provider rewrite.
  return [
    makeTarget('sdk: thinking display v4', sdk, patchRendererSource),
    makeTarget('bundle: thinking display v4', renderer, patchRendererSource),
    makeTarget('bundle: lossless thinking stream v4', provider, patchProviderSource),
  ];
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let failures = 0;
  for (const target of targets()) {
    try {
      if (!target.isApplied() && process.argv.includes('--fix')) target.apply();
      if (!target.isApplied()) throw new Error('patch missing; run with --fix');
      console.log(`PASS ${target.name}`);
    } catch (error) { failures++; console.error(`FAIL ${target.name}: ${error.message}`); }
  }
  process.exitCode = failures ? 1 : 0;
}
