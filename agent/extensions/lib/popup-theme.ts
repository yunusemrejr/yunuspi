/**
 * Visual system for the harness's own report windows (/used, /errors,
 * /commands, /sys-prompt, /models).
 *
 * These are diagnostic readouts an engineer scans for numbers and drills into
 * for evidence, so the system is a ledger rather than a dashboard: type and
 * hairlines carry hierarchy, figures are tabular and right-aligned, and color
 * is spent only on state (ok / attention / failed) and on the token bars that
 * encode real quantities. Neutrals lean cool-green so the pages sit next to a
 * terminal without glaring. Light and dark follow the OS.
 *
 * The text font stacks deliberately contain no emoji family: with an emoji
 * font in the middle of the stack, Linux machines without the first-listed
 * fonts render ordinary digits and spaces from the emoji font's wide glyphs.
 */

export const POPUP_FONT_SANS = 'system-ui,"Segoe UI","Noto Sans","DejaVu Sans",Roboto,"Helvetica Neue",Arial,sans-serif';
export const POPUP_FONT_MONO = 'ui-monospace,"Cascadia Mono","SF Mono","JetBrains Mono",Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace';

const TOKENS_LIGHT = "--bg:#f3f6f6;--panel:#fbfcfc;--sunk:#e9eeee;--ink:#14191c;--ink2:#46525a;--ink3:#5b6870;--rule:#d5dddf;--rule2:#e3e9ea;--accent:#09638f;--focus:#09638f;--ok:#16704a;--warn:#895500;--bad:#b0261c;--c-fresh:#c47a00;--c-read:#09638f;--c-write:#7a8791;";
const TOKENS_DARK = "--bg:#0f1417;--panel:#151b1f;--sunk:#0b0f11;--ink:#e5ebee;--ink2:#aeb9bf;--ink3:#8995a0;--rule:#27323a;--rule2:#1e272d;--accent:#6ec3ee;--focus:#6ec3ee;--ok:#62d19c;--warn:#e5b34f;--bad:#ff8c82;--c-fresh:#e5b34f;--c-read:#6ec3ee;--c-write:#6c7983;";

export const POPUP_CSS = [
  `:root{color-scheme:light dark;${TOKENS_LIGHT}--sans:${POPUP_FONT_SANS};--mono:${POPUP_FONT_MONO}}`,
  `@media(prefers-color-scheme:dark){:root{${TOKENS_DARK}}}`,
  "*{box-sizing:border-box}",
  "html{-webkit-text-size-adjust:100%}",
  "body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans);font-variant-numeric:tabular-nums;text-align:left;word-spacing:normal;letter-spacing:normal;text-rendering:optimizeLegibility}",
  "main{max-width:980px;margin:0 auto;padding:32px 24px 56px}",
  "h1{font-size:23px;line-height:1.2;font-weight:650;letter-spacing:-.01em;margin:0 0 6px}",
  "h2{font-size:12px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;margin:28px 0 8px;color:var(--ink2)}",
  "h3{font-size:12px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;margin:16px 0 6px;color:var(--ink3)}",
  "p.sub{margin:0 0 14px;color:var(--ink2);font-size:13px;max-width:78ch}",
  "p.note{margin:8px 0 10px;color:var(--ink2);font-size:12.5px;max-width:84ch}",
  "code,kbd,pre{font-family:var(--mono)}",
  "code{font-size:12.5px}",
  "ul{list-style:none;margin:0;padding:0}",
  "li{padding:6px 0;border-bottom:1px solid var(--rule2);display:flex;gap:12px;align-items:baseline}",
  "li:last-child{border-bottom:0}",
  "code.row{flex:1;min-width:0;overflow-wrap:anywhere}",
  "b.count{color:var(--accent);white-space:nowrap}",
  "span.dim{color:var(--ink3);font-size:12px}",
  ".empty{color:var(--ink3);padding:6px 0;font-size:13px}",
  /* key figures: a readout row divided by hairlines, not a card grid */
  ".overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:18px 0 8px;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}",
  ".stat{padding:12px 16px 12px 0;min-width:0}",
  ".stat+.stat{padding-left:16px;border-left:1px solid var(--rule2)}",
  ".stat strong{display:block;font-size:26px;line-height:1.1;font-weight:600;letter-spacing:-.015em;overflow-wrap:anywhere}",
  ".stat span{display:block;color:var(--ink3);font-size:12px;margin-top:4px}",
  ".stat.ok strong{color:var(--ok)}.stat.warn strong{color:var(--warn)}.stat.bad strong{color:var(--bad)}",
  /* sections: flat ledger rows */
  "details.group{border-bottom:1px solid var(--rule)}",
  "details.group:first-of-type{border-top:0}",
  "details.group>summary{display:flex;align-items:baseline;gap:12px;cursor:pointer;padding:13px 2px;list-style:none;user-select:none}",
  "details.group>summary::-webkit-details-marker,details.item>summary::-webkit-details-marker,.usage-component>summary::-webkit-details-marker{display:none}",
  "details.group>summary::before,details.item>summary::before,.usage-component>summary::before{content:'';flex:none;width:6px;height:6px;border-right:1.5px solid var(--ink3);border-bottom:1.5px solid var(--ink3);transform:translateY(-2px) rotate(-45deg);transition:transform .12s ease}",
  "details[open]>summary::before{transform:translateY(-3px) rotate(45deg)}",
  "details.group>summary:hover,details.item>summary:hover,.usage-component>summary:hover{background:var(--sunk)}",
  "details>summary:focus-visible{outline:2px solid var(--focus);outline-offset:-2px;border-radius:3px}",
  ".group-title{font-weight:650;white-space:nowrap}",
  ".group-meta{margin-left:auto;min-width:0;color:var(--ink2);font-size:12.5px;text-align:right;overflow-wrap:anywhere}",
  ".group-body{padding:4px 2px 18px 18px;border-left:1px solid var(--rule);margin:0 0 6px 3px}",
  "details.item{border-bottom:1px solid var(--rule2)}",
  "details.item:last-child{border-bottom:0}",
  "details.item>summary{display:flex;align-items:baseline;gap:10px;cursor:pointer;padding:8px 2px;list-style:none}",
  ".item-name{min-width:0;flex:1;font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}",
  ".item-meta{color:var(--ink3);font-size:12px;text-align:right;display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:flex-end}",
  /* state marks: a square + word, readable without color */
  ".badge{display:inline-flex;align-items:center;gap:6px;color:var(--ink2);font-size:12px;line-height:1.5;white-space:nowrap}",
  ".badge::before{content:'';width:7px;height:7px;background:var(--ink3);flex:none}",
  ".badge.current,.badge.complete,.badge.read{color:var(--ok)}.badge.current::before,.badge.complete::before,.badge.read::before{background:var(--ok)}",
  ".badge.active,.badge.partial{color:var(--warn)}.badge.active::before,.badge.partial::before{background:var(--warn)}",
  ".badge.failed{color:var(--bad)}.badge.failed::before{background:var(--bad)}",
  ".badge.info{color:var(--ink2)}.badge.info::before{background:var(--accent)}",
  ".status-line{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 10px}",
  /* controls */
  ".toolbar,.copy-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:14px 0}",
  "button,.btn{font:600 12.5px/1.4 var(--sans);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:4px;padding:6px 14px;cursor:pointer}",
  "button:hover{border-color:var(--ink3)}button:active{background:var(--sunk)}",
  "button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}",
  "button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}",
  "input[type=search]{font:13px/1.4 var(--sans);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:4px;padding:7px 10px;min-width:min(320px,100%);flex:1;max-width:420px}",
  "input[type=search]::placeholder{color:var(--ink3)}",
  /* evidence */
  ".facts-grid{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:4px 18px;margin:4px 0 12px;font-size:12.5px}",
  ".facts-grid dt{color:var(--ink3)}",
  ".facts-grid dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}",
  "pre{background:var(--sunk);border:1px solid var(--rule2);border-radius:4px;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;margin:8px 0;max-width:100%}",
  "div.chips{display:flex;flex-wrap:wrap;gap:4px 14px;margin:8px 0 14px}",
  "div.chips span{font:12px/1.5 var(--mono);color:var(--ink2)}",
  "table.facts{border-collapse:collapse;margin:8px 0 14px;font-size:13px}",
  "table.facts td{padding:2px 18px 2px 0;vertical-align:top}",
  "table.facts td:first-child{color:var(--ink3);white-space:nowrap}",
  /* token bar: one segment per real quantity, labels printed beside it */
  ".tokenbar{display:flex;height:10px;margin:10px 0 6px;background:var(--sunk);overflow:hidden;border-radius:2px}",
  ".tokenbar i{display:block;height:100%;min-width:2px}",
  ".tokenbar .fresh{background:var(--c-fresh)}.tokenbar .read{background:var(--c-read)}.tokenbar .write{background:var(--c-write)}",
  ".tokenkey{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0 0 12px;font-size:12px;color:var(--ink2)}",
  ".tokenkey span::before{content:'';display:inline-block;width:8px;height:8px;margin-right:6px;background:var(--c-write)}",
  ".tokenkey .fresh::before{background:var(--c-fresh)}.tokenkey .read::before{background:var(--c-read)}.tokenkey .write::before{background:var(--c-write)}",
  /* commands list */
  ".cmdgroup{margin:18px 0 0}",
  ".cmdgrid{display:grid;grid-template-columns:minmax(150px,max-content) minmax(0,1fr);gap:0 22px}",
  ".cmdgrid>div{display:contents}",
  ".cmdgrid dt,.cmdgrid dd{margin:0;padding:6px 0;border-bottom:1px solid var(--rule2)}",
  ".cmdgrid dt{font:600 12.5px/1.5 var(--mono)}",
  ".cmdgrid dd{color:var(--ink2);font-size:13px}",
  "[hidden]{display:none!important}",
  /* system prompt outline */
  "nav.outline{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 12px;font-size:12.5px}",
  "nav.outline a{color:var(--accent);text-decoration:none}nav.outline a:hover{text-decoration:underline}",
  "pre .hd{font-weight:700;color:var(--accent)}",
  /* used report */
  ".used-report{font-family:var(--sans);text-align:left}",
  ".usage-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 6px}",
  ".usage-snapshot{font-size:12px;color:var(--ink3);text-align:right}",
  ".used-report h1{font-size:25px}",
  ".usage-eyebrow{display:none}",
  ".usage-mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:2px 18px;margin:8px 0 12px}",
  ".usage-kpi{min-width:0;padding:6px 0;border-top:1px solid var(--rule2)}",
  ".usage-kpi strong{display:block;font-size:20px;line-height:1.2;font-weight:600}",
  ".usage-kpi span,.usage-kpi small{display:block;font-size:12px;line-height:1.4;color:var(--ink3);margin-top:2px}",
  ".usage-components{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}",
  ".usage-component{border-top:1px solid var(--rule2);min-width:0}",
  ".usage-component>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;min-height:50px;padding:8px 2px}",
  ".usage-component summary b{font-size:13px;font-weight:650}",
  ".usage-component summary small{display:block;font-size:12px;color:var(--ink3)}",
  ".usage-component-value{margin-left:auto;text-align:right;font-size:12px;color:var(--ink2)}",
  ".usage-component .usage-mini-grid{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ".usage-component .usage-kpi strong{font-size:17px}",
  ".usage-component .facts-grid{grid-template-columns:150px minmax(0,1fr)}",
  ".usage-note{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:80ch;margin:8px 0 14px}",
  ".used-report time{color:var(--ink3);font-size:12px;white-space:nowrap}",
  ".usage-history{border-top:1px solid var(--rule2);margin-top:14px}",
  ".usage-history summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:12.5px}",
  ".usage-history ol{list-style:none;padding:0;margin:0}",
  ".usage-history li{display:grid;grid-template-columns:150px minmax(0,1fr);font-size:12.5px;padding:7px 0}",
  ".skill-evidence{list-style:none;padding:0 0 12px 18px;margin:0}",
  ".skill-evidence li{display:block;padding:8px 0;border-top:1px solid var(--rule2);font-size:12.5px}",
  ".skill-evidence small{display:block;color:var(--ink3);margin:3px 0}",
  ".skill-evidence code{display:block;overflow-wrap:anywhere;color:var(--ink2);font-size:12px}",
  "@media(max-width:720px){main{padding:20px 14px 40px}.usage-components{grid-template-columns:1fr}.usage-heading{align-items:flex-start;flex-direction:column;gap:6px}.usage-snapshot{text-align:left}.group-title{white-space:normal;min-width:0}.group-meta{max-width:46%;font-size:12px}.item-meta{display:none}.stat+.stat{border-left:0;padding-left:0}.overview{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding-right:10px}.usage-history li{grid-template-columns:1fr;gap:3px}.facts-grid,.used-report .facts-grid,.usage-component .facts-grid{grid-template-columns:104px minmax(0,1fr)}.cmdgrid{grid-template-columns:1fr}.cmdgrid dt{border-bottom:0;padding-bottom:0}}",
  "@media(prefers-reduced-motion:reduce){details>summary::before{transition:none}}",
].join("\n");

const escapeText = (text: string) => text.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));

/** One complete report document. `script` is trusted inline code from the caller. */
export function popupDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeText(title)}</title><style>${POPUP_CSS}</style></head><body><main>${bodyHtml}</main></body></html>`;
}

/** Tone for a cache-reuse ratio (0..100): a high reuse rate is the goal. */
export function cacheTone(percent: number | null | undefined): "ok" | "warn" | "bad" | "" {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "";
  return percent >= 90 ? "ok" : percent >= 70 ? "warn" : "bad";
}

/** Stacked bar of the prompt-token mix. Labels are printed, so color is redundant. */
export function tokenMixHtml(mix: { fresh: number; read: number; write: number }): string {
  const total = mix.fresh + mix.read + mix.write;
  if (!(total > 0)) return "";
  const share = (value: number) => (value / total) * 100;
  const label = (cls: string, text: string, value: number) => `<span class="${cls}">${text} ${value.toLocaleString("en-US")} · ${share(value).toFixed(1)}%</span>`;
  const seg = (cls: string, text: string, value: number) => (value > 0 ? `<i class="${cls}" style="width:${share(value).toFixed(3)}%" title="${text}: ${value.toLocaleString("en-US")} tokens"></i>` : "");
  return `<div class="tokenbar" role="img" aria-label="Prompt token mix">${seg("read", "cache read", mix.read)}${seg("write", "cache write", mix.write)}${seg("fresh", "uncached input", mix.fresh)}</div><div class="tokenkey">${label("read", "cache read", mix.read)}${label("write", "cache write", mix.write)}${label("fresh", "uncached input", mix.fresh)}</div>`;
}
