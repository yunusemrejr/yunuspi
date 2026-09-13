// Automatic compaction policy: use 80% of the selected model's full context
// window. Legacy absolute caps, output reserves and recovery reasons must not
// trigger earlier automatic summaries. Manual compaction remains explicit.
// This version-sensitive patch owns SDK/CLI parity, valid summary commits,
// bounded retained tails and post-compaction usage accounting. Historical
// anchors below exist only to upgrade already-installed releases safely.
// CLI: node compaction-early.mjs [--fix] (default: report only).
import * as fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import * as path from "node:path";

const MARKER = "PI_COMPACT_CAP";
// Historical migration constant only; no longer an automatic context cap.
export const DEFAULT_MAX_CONTEXT_TOKENS = 256_000;

function piCoreDir() {
    if (process.env.PI_HARNESS_PATCH_TEST_CORE)
        return process.env.PI_HARNESS_PATCH_TEST_CORE;
    try {
        return path.join(
            execSync("npm root -g", { encoding: "utf-8" }).trim(),
            "@earendil-works",
            "pi-coding-agent",
        );
    } catch {
        return null;
    }
}

/** Locate the bundle chunk containing an anchor (or the applied marker) by
 *  content — Vite rehashes chunk filenames per build, so a hash-name lookup
 *  breaks every update. Scans all chunks for either the anchor or the marker
 *  already applied (ANY patch revision). Returns the matching chunk path. */
function findBundleChunkContaining(anchor, replacement) {
    const dir = path.join(piCoreDir() || "", "dist", "bundle", "chunks");
    try {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
            const p = path.join(dir, f);
            let src;
            try {
                src = fs.readFileSync(p, "utf8");
            } catch {
                continue;
            }
            if (src.includes(anchor) || src.includes(replacement)) {
                return p;
            }
        }
    } catch {
        /* no chunks dir */
    }
    return null;
}

// ---------------------------------------------------------------------------
// Target 1: SDK dist/core/compaction/compaction.js (readable source)
// ---------------------------------------------------------------------------

const SDK_COMPACT_ANCHOR = [
    "export function shouldCompact(contextTokens, contextWindow, settings) {",
    "    if (!settings.enabled)",
    "        return false;",
    "    return contextTokens > contextWindow - settings.reserveTokens;",
    "}",
].join("\n");

const SDK_COMPACT_PREVIOUS = [
    "export function shouldCompact(contextTokens, contextWindow, settings) {",
    "    if (!settings.enabled) return false;",
    "    // " +
        MARKER +
        " (local patch; re-applied by verify-harness.mjs [8a]): cap the",
    "    // compaction threshold by an absolute token budget, not just",
    "    // window-minus-reserve. Large-context models (1M+) otherwise never",
    "    // compact, so tool-heavy sessions transport 190k+ tokens per tool",
    "    // continuation. Default 256k keeps enough recent state for coding",
    "    // quality (keepRecentTokens still applies) while cutting per-call",
    "    // transport ~40%. Optimizes MODEL TRAFFIC, not window overflow.",
    "    const cap =",
    "        typeof settings.maxContextTokens === 'number' && settings.maxContextTokens > 0",
    "            ? settings.maxContextTokens",
    "            : " + DEFAULT_MAX_CONTEXT_TOKENS + ";",
    "    return contextTokens > Math.min(contextWindow - settings.reserveTokens, cap);",
    "}",
].join("\n");

// The repair timer can apply an in-progress revision; keep its exact upgrade path.
const SDK_COMPACT_HEADROOM_PREVIOUS = SDK_COMPACT_PREVIOUS.replace(
    "return contextTokens > Math.min(contextWindow - settings.reserveTokens, cap);",
    "const output = Math.max(settings.reserveTokens ?? 16384, Math.min(32768, contextWindow / 4));\n    const safety = Math.max(8192, Math.ceil(contextTokens * 0.05));\n    return contextTokens > Math.floor(0.85 * Math.max(0, Math.min(cap, contextWindow - output - safety))); /* PI_COMPACT_HEADROOM */",
);

const SDK_COMPACT_WINDOW_PREVIOUS = "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled) return false;\n    /* PI_COMPACT_CAP: PI_COMPACT_HEADROOM \u2014 automatic before payload-risk warnings. */\n\n    const cap =\n        Number.isFinite(settings.maxContextTokens) &&\n        settings.maxContextTokens > 0\n            ? settings.maxContextTokens\n            : 256000;\n    const output = Math.max(\n        settings.reserveTokens ?? 16384,\n        Math.min(32768, contextWindow / 4),\n    );\n    const floor = Math.min(\n        8192,\n        Math.max(128, Math.floor(contextWindow / 8)),\n    );\n    const safety = Math.max(floor, Math.ceil(contextTokens * 0.05));\n    return contextTokens > Math.floor(\n        0.85 * Math.max(0, Math.min(cap, contextWindow - output - safety)),\n    );\n}";

/** Full model window only; output/tail sizing cannot advance this threshold. */
export function automaticCompactionThreshold(contextTokens, contextWindow, settings) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Infinity;
    return Math.ceil(contextWindow * 0.8);
}
/** Preserve useful recent work while leaving room for a summary and continuation. */
export function compactionSettingsForWindow(contextWindow, settings) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return settings;
    const budget = contextWindow;
    const reserve = Number.isFinite(settings.reserveTokens) && settings.reserveTokens > 0
        ? settings.reserveTokens : 16384;
    const recent = Number.isFinite(settings.keepRecentTokens) && settings.keepRecentTokens >= 0
        ? settings.keepRecentTokens : 20000;
    return {
        ...settings,
        reserveTokens: Math.min(reserve, Math.max(128, Math.floor(budget / 8))),
        keepRecentTokens: Math.min(recent, Math.max(256, Math.floor(budget / 8))),
    };
}
// Embed this same decision in both deployed owners; no runtime cross-package import.
const thresholdSource = automaticCompactionThreshold.toString();
const decisionBody = thresholdSource
    .slice(thresholdSource.indexOf("{") + 1, -1)
    .replace(
        /\bDEFAULT_MAX_CONTEXT_TOKENS\b/g,
        String(DEFAULT_MAX_CONTEXT_TOKENS),
    )
    .replace("return Infinity", "return false")
    .replace("return Math.ceil", "return Number.isFinite(contextTokens) && contextTokens >= Math.ceil");
const SDK_COMPACT_REPLACEMENT = `export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    /* ${MARKER}: PI_COMPACT_FULL_WINDOW_80 — no early automatic triggers. */
${decisionBody}}`;


const SDK_COMPACT_BUDGET_PREVIOUS = "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled) return false;\n    /* PI_COMPACT_CAP: PI_COMPACT_HEADROOM — automatic before payload-risk warnings. */\n\n    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;\n    const cap =\n        Number.isFinite(settings.maxContextTokens) &&\n        settings.maxContextTokens > 0\n            ? settings.maxContextTokens\n            : 256000;\n    const reserve = Number.isFinite(settings.reserveTokens) && settings.reserveTokens > 0\n        ? settings.reserveTokens : 16384;\n    const output = Math.min(\n        Math.max(reserve, Math.min(32768, contextWindow / 4)),\n        Math.max(128, Math.floor(contextWindow / 4)),\n    );\n    const floor = Math.min(\n        8192,\n        Math.max(128, Math.floor(contextWindow / 8)),\n    );\n    const safety = Math.max(floor, Math.ceil(contextTokens * 0.05));\n    return contextTokens > Math.floor(\n        0.85 * Math.max(0, Math.min(cap, contextWindow - output - safety)),\n    );\n}";
const PREPARATION_BUDGET_PREVIOUS = "function compactionSettingsForWindow(contextWindow, settings) {\n    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return settings;\n    const cap = Number.isFinite(settings.maxContextTokens) && settings.maxContextTokens > 0\n        ? settings.maxContextTokens : 256000;\n    const budget = Math.min(contextWindow, cap);\n    const reserve = Number.isFinite(settings.reserveTokens) && settings.reserveTokens > 0\n        ? settings.reserveTokens : 16384;\n    const recent = Number.isFinite(settings.keepRecentTokens) && settings.keepRecentTokens >= 0\n        ? settings.keepRecentTokens : 20000;\n    return {\n        ...settings,\n        reserveTokens: Math.min(reserve, Math.max(128, Math.floor(budget / 8))),\n        keepRecentTokens: Math.min(recent, Math.max(256, Math.floor(budget / 8))),\n    };\n}";
// Exact pre-formatting revision deployed on 2026-09-07. Formatting the
// generator changes Function.toString(), so retain this known upgrade anchor.
const SDK_COMPACT_FORMAT_PREVIOUS = "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled) return false;\n    /* PI_COMPACT_CAP: PI_COMPACT_HEADROOM \u2014 automatic before payload-risk warnings. */\n\n    const cap = Number.isFinite(settings.maxContextTokens) && settings.maxContextTokens > 0\n        ? settings.maxContextTokens : 256000;\n    const output = Math.max(settings.reserveTokens ?? 16384, Math.min(32768, contextWindow / 4));\n    const floor = Math.min(8192, Math.max(128, Math.floor(contextWindow / 8)));\n    const safety = Math.max(floor, Math.ceil(contextTokens * 0.05));\n    return contextTokens > Math.floor(0.85 * Math.max(0, Math.min(cap, contextWindow - output - safety)));\n}";

// ---------------------------------------------------------------------------
// Target 3: SDK dist/core/settings-manager.js (readable source)
// ---------------------------------------------------------------------------

const SDK_SETTINGS_ANCHOR = [
    "        return {",
    "            enabled: this.getCompactionEnabled(),",
    "            reserveTokens: this.getCompactionReserveTokens(),",
    "            keepRecentTokens: this.getCompactionKeepRecentTokens(),",
    "        };",
].join("\n");

const SDK_SETTINGS_REPLACEMENT = [
    "        return {",
    "            enabled: this.getCompactionEnabled(),",
    "            reserveTokens: this.getCompactionReserveTokens(),",
    "            keepRecentTokens: this.getCompactionKeepRecentTokens(),",
    "            // " +
        MARKER +
        ": legacy setting retained for compatibility; automatic compaction ignores this cap.",
    "            maxContextTokens: this.settings.compaction?.maxContextTokens,",
    "        };",
].join("\n");

const SDK_SETTINGS_PREVIOUS = SDK_SETTINGS_REPLACEMENT.replace(
    ": legacy setting retained for compatibility; automatic compaction ignores this cap.",
    ": absolute compaction budget; undefined falls back to the default in shouldCompact.",
);

// ---------------------------------------------------------------------------
// Targets 2 + 4: bundle chunk (minified; runtime path for the `pi` binary)
// ---------------------------------------------------------------------------

const BUNDLE_COMPACT_ANCHOR =
    "function shouldCompact(contextTokens,contextWindow,settings2){return settings2.enabled?contextTokens>contextWindow-settings2.reserveTokens:!1}";

const BUNDLE_COMPACT_PREVIOUS =
    "function shouldCompact(contextTokens,contextWindow,settings2){if(!settings2.enabled)return!1;/*" +
    MARKER +
    '*/const cap=typeof settings2.maxContextTokens=="number"&&settings2.maxContextTokens>0?settings2.maxContextTokens:' +
    "256e3" +
    ";return contextTokens>Math.min(contextWindow-settings2.reserveTokens,cap)}";

const BUNDLE_COMPACT_HEADROOM_PREVIOUS = BUNDLE_COMPACT_PREVIOUS.replace(
    "return contextTokens>Math.min(contextWindow-settings2.reserveTokens,cap)",
    "const output=Math.max(settings2.reserveTokens??16384,Math.min(32768,contextWindow/4)),safety=Math.max(8192,Math.ceil(contextTokens*.05));return contextTokens>Math.floor(.85*Math.max(0,Math.min(cap,contextWindow-output-safety)))/*PI_COMPACT_HEADROOM*/",
);
const BUNDLE_COMPACT_REPLACEMENT = SDK_COMPACT_REPLACEMENT.replace(
    "export function shouldCompact(contextTokens, contextWindow, settings)",
    "function shouldCompact(contextTokens,contextWindow,settings2)",
).replace(/\bsettings\b/g, "settings2");

const BUNDLE_COMPACT_BUDGET_PREVIOUS = SDK_COMPACT_BUDGET_PREVIOUS.replace(
    "export function shouldCompact(contextTokens, contextWindow, settings)",
    "function shouldCompact(contextTokens,contextWindow,settings2)",
).replace(/\bsettings\b/g, "settings2");

const BUNDLE_COMPACT_WINDOW_PREVIOUS = SDK_COMPACT_WINDOW_PREVIOUS.replace(
    "export function shouldCompact(contextTokens, contextWindow, settings)",
    "function shouldCompact(contextTokens,contextWindow,settings2)",
).replace(/\bsettings\b/g, "settings2");

const BUNDLE_COMPACT_FORMAT_PREVIOUS = SDK_COMPACT_FORMAT_PREVIOUS.replace(
    "export function shouldCompact(contextTokens, contextWindow, settings)",
    "function shouldCompact(contextTokens,contextWindow,settings2)",
).replace(/\bsettings\b/g, "settings2");

const BUNDLE_SETTINGS_ANCHOR =
    "getCompactionSettings(){return{enabled:this.getCompactionEnabled(),reserveTokens:this.getCompactionReserveTokens(),keepRecentTokens:this.getCompactionKeepRecentTokens()}";

const BUNDLE_SETTINGS_REPLACEMENT =
    "getCompactionSettings(){return{enabled:this.getCompactionEnabled(),reserveTokens:this.getCompactionReserveTokens(),keepRecentTokens:this.getCompactionKeepRecentTokens(),maxContextTokens:this.settings?.compaction?.maxContextTokens}";

// ---------------------------------------------------------------------------
// Target table
// ---------------------------------------------------------------------------

function makeStaticTarget(
    name,
    file,
    anchor,
    replacement,
    notes,
    previous = [],
) {
    // WHY per-target content matching: each target may be the SDK file (a
    // stable absolute path) or a hash-renamed bundle chunk (resolved by
    // content scan). `file` is already the concrete path.
    return {
        name,
        file,
        notes,
        exists: () => fs.existsSync(file),
        // WHY check the replacement text (not just MARKER): two bundle targets
        // share one chunk, so a marker-only check would let the second target
        // report "applied" the moment the first writes the marker, skipping its
        // own edit. Each target must verify its own replacement is present.
        isApplied: () => {
            try {
                return fs.readFileSync(file, "utf8").includes(replacement);
            } catch {
                return false;
            }
        },
        apply: () => {
            const src = fs.readFileSync(file, "utf8");
            if (src.includes(replacement)) return;
            const matched = [...previous, anchor].sort((a,b)=>b.length-a.length).find((value) =>
                src.includes(value),
            );
            if (matched) {
                if (src.split(matched).length !== 2)
                    throw new Error(`ambiguous patch anchor in ${file}`);
                const temp = `${file}.compact-${process.pid}`;
                fs.writeFileSync(temp, src.replace(matched, replacement), {
                    mode: fs.statSync(file).mode,
                });
                fs.renameSync(temp, file);
                return;
            }
            throw new Error(
                `anchor mismatch in ${file} — upstream refactor, patch needs updating`,
            );
        },
    };
}

/** Resolve a bundle target: find the chunk by content (anchor OR applied
 *  marker). Returns null if no chunk contains either. */
function bundleTarget(name, anchor, replacement) {
    const compact = name.includes("shouldCompact");
    let previous = compact
        ? [BUNDLE_COMPACT_BUDGET_PREVIOUS, BUNDLE_COMPACT_PREVIOUS, BUNDLE_COMPACT_HEADROOM_PREVIOUS, BUNDLE_COMPACT_FORMAT_PREVIOUS, BUNDLE_COMPACT_WINDOW_PREVIOUS]
        : [];
    const chunk = findBundleChunkContaining(
        compact ? "function shouldCompact(" : anchor,
        replacement,
    );
    if (!chunk)
        throw new Error(
            `${name}: required runtime target missing — upstream layout changed`,
        );
    if (compact) {
        const signature = fs
            .readFileSync(chunk, "utf8")
            .match(/function shouldCompact\((\w+),(\w+),(\w+)\)/);
        if (!signature)
            throw new Error(`${name}: unsupported function signature`);
        const names = {
            contextTokens: signature[1],
            contextWindow: signature[2],
            settings2: signature[3],
        };
        const rename = (text) =>
            text.replace(
                /\b(contextTokens|contextWindow|settings2)\b/g,
                (key) => names[key],
            );
        anchor = rename(anchor);
        replacement = rename(replacement);
        previous = previous.map(rename);
    }
    return makeStaticTarget(
        name,
        chunk,
        anchor,
        replacement,
        undefined,
        previous,
    );
}

// Retained assistant messages keep their original usage for billing. That usage
// describes the old request, not the smaller context after compaction. The
// between-tool-turn check also calls this estimator, so fixing only the terminal
// _checkCompaction guard leaves a second compaction trigger using stale totals.
const USAGE_SDK_ANCHOR = `function getLastAssistantUsageInfo(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const usage = getAssistantUsage(messages[i]);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}`;
const USAGE_BUNDLE_ANCHOR = "function getLastAssistantUsageInfo(messages){for(let i=messages.length-1;i>=0;i--){let usage=getAssistantUsage(messages[i]);if(usage)return{usage,index:i}}}";
const USAGE_REPLACEMENT = `function getLastAssistantUsageInfo(messages) {
    /* PI_COMPACTION_USAGE_BOUNDARY */
    let boundary = -Infinity;
    for (const message of messages) {
        if (message.role === "compactionSummary")
            boundary = Number.isFinite(message.timestamp) ? Math.max(boundary, message.timestamp) : Infinity;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (boundary !== -Infinity && !(Number.isFinite(message.timestamp) && message.timestamp > boundary)) continue;
        const usage = getAssistantUsage(message);
        if (usage) return { usage, index: i };
    }
    return undefined;
}`;

/** Validate both native and extension summaries before changing the durable branch. */
export function patchCompactionCommit(source) {
    const calls = [...source.matchAll(/this\.sessionManager\.appendCompaction\(([^;]+?)\);/g)];
    if (calls.length !== 2) throw new Error("compaction commit: expected manual and automatic owners");
    let next = source;
    for (const call of calls.reverse()) {
        const args = call[1].split(",").map(value => value.trim());
        if (args.length !== 6 || args.some(value => !/^[\w$]+$/.test(value))) throw new Error("compaction commit: arguments drift");
        const [summary, boundary, tokens] = args;
        const guard = `/* PI_COMPACTION_COMMIT_GUARD */if(typeof ${summary}!=="string"||!${summary}.trim()||!Number.isFinite(${tokens})||${tokens}<0||typeof ${boundary}!=="string"||!this.sessionManager.getBranch().some(entry=>entry.id===${boundary}))throw new Error("Invalid compaction result; keeping existing history");`;
        const prefix = source.slice(0, call.index);
        if (prefix.endsWith(guard)) continue;
        if (prefix.slice(-600).includes("PI_COMPACTION_COMMIT_GUARD")) throw new Error("compaction commit guard drift");
        next = next.slice(0, call.index) + guard + next.slice(call.index);
    }
    if ((next.match(/PI_COMPACTION_COMMIT_GUARD/g) ?? []).length !== 2) throw new Error("compaction commit guard count drift");
    return next;
}
function commitGuardTarget(name, file) {
    if (!file) throw new Error(`${name}: missing owner`);
    return {
        name, file, exists: () => fs.existsSync(file),
        isApplied() { try { const source=fs.readFileSync(file,"utf8"); return patchCompactionCommit(source)===source; } catch { return false; } },
        apply() {
            const source=fs.readFileSync(file,"utf8"), next=patchCompactionCommit(source);
            if(source===next) return;
            execFileSync(process.execPath,["--input-type=module","--check"],{input:next,stdio:["pipe","pipe","pipe"]});
            const temp=`${file}.compact-${process.pid}`;
            try { fs.writeFileSync(temp,next,{mode:fs.statSync(file).mode}); fs.renameSync(temp,file); }
            finally { fs.rmSync(temp,{force:true}); }
        },
    };
}

function summaryGuardTarget(name, file) {
    if (!file) throw new Error(`${name}: summary owner missing`);
    const source = fs.readFileSync(file, "utf8");
    const matches = [
        ...source.matchAll(
            /function getSummarizationFailure\(([\w$]+),\s*([\w$]+)\)\s*\{/g,
        ),
    ];
    if (matches.length !== 1)
        throw new Error(`${name}: summary signature drift`);
    const [anchor, response, label] = matches[0];
    const replacement =
        anchor +
        `/* PI_SUMMARY_CONTENT_GUARD */
if (${response}.stopReason === "aborted") return ${label} + " failed: summary aborted; keeping existing history";
if (${response}.stopReason !== "error" && ${response}.stopReason !== "length" &&
    (!Array.isArray(${response}.content) || !${response}.content.some(p => p?.type === "text" && typeof p.text === "string" && p.text.trim())))
    return ${label} + " failed: empty summary; keeping existing history";
`;
    return makeStaticTarget(name, file, anchor, replacement);
}

function preparationWindowTarget(name, file) {
    const source = fs.readFileSync(file, "utf8");
    const signatures = [...source.matchAll(/function prepareCompaction\(([\w$]+),\s*([\w$]+)(?:,\s*contextWindow)?\)\s*\{/g)];
    if (signatures.length !== 1) throw new Error(`${name}: preparation signature drift`);
    const [, entries, settings] = signatures[0];
    const original = signatures[0][0].replace(/,\s*contextWindow/, "");
    const helper = compactionSettingsForWindow.toString().replace(/\bDEFAULT_MAX_CONTEXT_TOKENS\b/g, String(DEFAULT_MAX_CONTEXT_TOKENS));
    const replacement = original.replace(/\)\s*\{$/, ", contextWindow) {") +
        `/* PI_COMPACT_WINDOW_SETTINGS */\n${settings} = (${helper})(contextWindow, ${settings});\n`;
    const previous = [helper,PREPARATION_BUDGET_PREVIOUS].flatMap(text=>[
        text, text.replace("settings.keepRecentTokens >= 0","settings.keepRecentTokens > 0"),
    ]).flatMap(text=>[
        text,text.replace("keepRecentTokens: Math.min(recent, Math.max(256, Math.floor(budget / 8)))","keepRecentTokens: Math.min(recent, Math.max(256, Math.floor(budget / 4)))"),
    ]).map(text=>replacement.replace(helper,text));
    if(source.includes('PI_COMPACT_WINDOW_SETTINGS') && !previous.some(value=>source.includes(value)))
        throw new Error(`${name}: unknown preparation wrapper revision`);
    return makeStaticTarget(name,file,original,replacement,undefined,previous);
}

function preparationCallTarget(name, file) {
    if (!file || !fs.existsSync(file)) throw new Error(`${name}: session owner missing`);
    const transform = source => {
        // Normalize the exact current wrapper for strict idempotence/upgrade checks.
        const wrapper = /\(prepareCompaction\(([\w$]+),([\w$]+),this\.model\?\.contextWindow\)\/\* PI_COMPACT_WINDOW_CALL \*\/ \|\| prepareCompaction\(\1,\{\.\.\.\2,keepRecentTokens:0\},this\.model\?\.contextWindow\)\)\/\* PI_COMPACT_AUTO_TAIL \*\//g;
        let normalized = source.replace(wrapper, (_all, entries, settings) =>
            `prepareCompaction(${entries},${settings},this.model?.contextWindow)/* PI_COMPACT_WINDOW_CALL */`);
        if (normalized.includes('PI_COMPACT_AUTO_TAIL')) throw new Error(`${name}: automatic tail wrapper drift`);
        const patched = [...normalized.matchAll(/prepareCompaction\([\w$]+,\s*[\w$]+,this\.model\?\.contextWindow\)\/\* PI_COMPACT_WINDOW_CALL \*\//g)];
        const calls = [...normalized.matchAll(/(?<!function )prepareCompaction\(([\w$]+),\s*([\w$]+)\)/g)];
        if (patched.length !== 2 || calls.length !== 0) {
            if (calls.length !== 2 || patched.length) throw new Error(`${name}: expected two manual/automatic preparation calls`);
            normalized = normalized.replace(/(?<!function )prepareCompaction\(([\w$]+),\s*([\w$]+)\)/g,
                (_call, entries, settings) => `prepareCompaction(${entries},${settings},this.model?.contextWindow)/* PI_COMPACT_WINDOW_CALL */`);
        }
        const start = normalized.indexOf('async _runAutoCompaction(');
        if (start < 0) throw new Error(`${name}: automatic owner missing`);
        const head = normalized.slice(0,start), tail = normalized.slice(start);
        const match = tail.match(/prepareCompaction\(([\w$]+),([\w$]+),this\.model\?\.contextWindow\)\/\* PI_COMPACT_WINDOW_CALL \*\//);
        if (!match) throw new Error(`${name}: automatic preparation missing`);
        const [call, entries, settings] = match;
        return head + tail.replace(call, `(${call} || prepareCompaction(${entries},{...${settings},keepRecentTokens:0},this.model?.contextWindow))/* PI_COMPACT_AUTO_TAIL */`);
    };
    return {
        name, file, exists: () => fs.existsSync(file),
        isApplied: () => {
            try { const source = fs.readFileSync(file, "utf8"); return transform(source) === source; }
            catch { return false; }
        },
        apply: () => {
            const source = fs.readFileSync(file, "utf8"), next = transform(source);
            if (next === source) return;
            const temp = `${file}.compact-${process.pid}`;
            fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode });
            fs.renameSync(temp, file);
        },
    };
}

// Gate every automatic path before auth, hooks, retry flags or context mutation.
// Output-length/provider errors alone cannot spend a summary call below 80%.
export function patchAutomaticWindowGates(source) {
    let next = source;
    for (const [method, marker] of [["_checkCompaction", "PI_AUTO_WINDOW_CHECK"], ["_runAutoCompaction", "PI_AUTO_WINDOW_RUN"]]) {
        const guard = `/* ${marker} */if(!this.model||!shouldCompact(estimateContextTokens(this.agent.state.messages).tokens,this.model.contextWindow,this.settingsManager.getCompactionSettings()))return false;`;
        if (next.includes(guard)) {
            if (next.split(guard).length !== 2) throw new Error(`${method}: duplicate window gate`);
            continue;
        }
        if (next.includes(marker)) throw new Error(`${method}: unknown window gate revision`);
        const pattern = new RegExp(`async ${method}\\([^)]*\\)\\s*\\{`, "g");
        const matches = [...next.matchAll(pattern)];
        if (matches.length !== 1) throw new Error(`${method}: automatic owner drift`);
        next = next.replace(matches[0][0], matches[0][0] + guard);
    }
    // Failed/truncated replies stay visible until a valid summary is committed.
    // The existing success path removes retriable replies before continuing.
    const sdk = `            const messages = this.agent.state.messages;
            if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
                this.agent.state.messages = messages.slice(0, -1);
            }
            return await this._runAutoCompaction("overflow", willRetry);`;
    const bundle = 'let messages=this.agent.state.messages;return messages.length>0&&messages[messages.length-1].role==="assistant"&&(this.agent.state.messages=messages.slice(0,-1)),await this._runAutoCompaction("overflow",willRetry)';
    const preserved = '/* PI_AUTO_PRESERVE_FAILURE */return await this._runAutoCompaction("overflow",willRetry);';
    if (!next.includes(preserved)) {
        const anchor = [sdk,bundle].find(value=>next.includes(value));
        if (!anchor || next.split(anchor).length !== 2 || next.includes('PI_AUTO_PRESERVE_FAILURE')) throw new Error('automatic overflow mutation owner drift');
        next = next.replace(anchor,preserved);
    }
    return next;
}
function automaticWindowTarget(name, file) {
    if (!file || !fs.existsSync(file)) throw new Error(`${name}: session owner missing`);
    return {
        name, file, exists:()=>fs.existsSync(file),
        isApplied:()=>{try{const source=fs.readFileSync(file,'utf8');return patchAutomaticWindowGates(source)===source;}catch{return false;}},
        apply:()=>{
            const source=fs.readFileSync(file,'utf8'), next=patchAutomaticWindowGates(source);
            if(next===source)return;
            const temp=`${file}.compact-${process.pid}`;
            fs.writeFileSync(temp,next,{mode:fs.statSync(file).mode});fs.renameSync(temp,file);
        },
    };
}

export function targets() {
    const core = piCoreDir();
    const sdkCompact = core
        ? path.join(core, "dist", "core", "compaction", "compaction.js")
        : null;
    const sdkSettings = core
        ? path.join(core, "dist", "core", "settings-manager.js")
        : null;
    if (
        !sdkCompact ||
        !fs.existsSync(sdkCompact) ||
        !sdkSettings ||
        !fs.existsSync(sdkSettings)
    ) {
        throw new Error(
            "compaction: required SDK target missing — upstream layout changed",
        );
    }
    const out = [];
    if (sdkCompact && fs.existsSync(sdkCompact)) {
        out.push(
            makeStaticTarget(
                "sdk: shouldCompact cap",
                sdkCompact,
                SDK_COMPACT_ANCHOR,
                SDK_COMPACT_REPLACEMENT,
                undefined,
                [SDK_COMPACT_BUDGET_PREVIOUS, SDK_COMPACT_PREVIOUS, SDK_COMPACT_HEADROOM_PREVIOUS, SDK_COMPACT_FORMAT_PREVIOUS, SDK_COMPACT_WINDOW_PREVIOUS],
            ),
        );
    }
    if (sdkSettings && fs.existsSync(sdkSettings)) {
        out.push(
            makeStaticTarget(
                "sdk: getCompactionSettings maxContextTokens passthrough",
                sdkSettings,
                SDK_SETTINGS_ANCHOR,
                SDK_SETTINGS_REPLACEMENT,
                undefined,
                [SDK_SETTINGS_PREVIOUS],
            ),
        );
    }
    const bundleCompact = bundleTarget(
        "bundle: shouldCompact cap",
        BUNDLE_COMPACT_ANCHOR,
        BUNDLE_COMPACT_REPLACEMENT,
    );
    if (bundleCompact) out.push(bundleCompact);
    const bundleSettings = bundleTarget(
        "bundle: getCompactionSettings maxContextTokens passthrough",
        BUNDLE_SETTINGS_ANCHOR,
        BUNDLE_SETTINGS_REPLACEMENT,
    );
    if (bundleSettings) out.push(bundleSettings);
    out.push(
        summaryGuardTarget("sdk: nonempty complete summary guard", sdkCompact),
    );
    out.push(
        summaryGuardTarget(
            "bundle: nonempty complete summary guard",
            findBundleChunkContaining(
                "function getSummarizationFailure(",
                "PI_SUMMARY_CONTENT_GUARD",
            ),
        ),
    );
    out.push(
        preparationWindowTarget("sdk: bounded compaction preparation", sdkCompact),
        preparationWindowTarget("bundle: bounded compaction preparation", bundleCompact.file),
        preparationCallTarget("sdk: model window at compaction preparation", path.join(core, "dist", "core", "agent-session.js")),
        preparationCallTarget("bundle: model window at compaction preparation", findBundleChunkContaining("_runAutoCompaction(", "PI_COMPACT_WINDOW_CALL")),
    );
    out.push(
        commitGuardTarget("sdk: validate compaction commit", path.join(core, "dist", "core", "agent-session.js")),
        commitGuardTarget("bundle: validate compaction commit", findBundleChunkContaining("_runAutoCompaction(", "PI_COMPACT_WINDOW_CALL")),
    );
    out.push(
        makeStaticTarget("sdk: post-compaction usage accounting", sdkCompact, USAGE_SDK_ANCHOR, USAGE_REPLACEMENT, undefined, [USAGE_BUNDLE_ANCHOR]),
        makeStaticTarget("bundle: post-compaction usage accounting", bundleCompact.file, USAGE_BUNDLE_ANCHOR, USAGE_REPLACEMENT, undefined, [USAGE_SDK_ANCHOR]),
    );
    out.push(
        automaticWindowTarget("sdk: automatic full-window gates", path.join(core,"dist","core","agent-session.js")),
        automaticWindowTarget("bundle: automatic full-window gates", findBundleChunkContaining("async _checkCompaction(","PI_AUTO_WINDOW_CHECK")),
    );
    return out;
}

// ---------------------------------------------------------------------------
// CLI (only when run directly — verify-harness imports targets() and must not
// be killed by our process.exit)
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("compaction-early.mjs")) {
    const FIX = process.argv.includes("--fix");
    let failures = 0;
    for (const t of targets()) {
        if (t.isApplied()) {
            console.log(`  ✓ ${t.name}: patch present`);
        } else if (!t.exists()) {
            console.log(`  · ${t.name}: target file missing — skipped`);
        } else if (FIX) {
            try {
                t.apply();
                console.log(`  ✓ ${t.name}: patch applied`);
            } catch (e) {
                failures++;
                console.log(`  ✗ ${t.name}: apply failed — ${e.message}`);
            }
        } else {
            failures++;
            console.log(`  ✗ ${t.name}: patch MISSING — run with --fix`);
        }
    }
    console.log(
        failures === 0 ? `RESULT: PASS` : `RESULT: ${failures} issue(s) found`,
    );
    process.exit(failures === 0 ? 0 : 1);
}
