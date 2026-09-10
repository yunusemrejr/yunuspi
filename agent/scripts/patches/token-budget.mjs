// Token budget patch — re-applied by verify-harness.mjs (auto-discovered).
// Lives OUTSIDE node_modules so it survives `npm update`; the patched files
// (pi bundle chunks + the pi-ai SDK copies) do not.
//
// WHAT: token-budget safety for ALL providers (the canonical chokepoint is
// pi-ai's clampMaxTokensToContext in api/simple-options.js — every API driver
// funnels its per-request max_tokens through it). Stock behavior: reserve is a
// FIXED 4096 tokens (CONTEXT_SAFETY_TOKENS) against the pi-side token
// ESTIMATE, and the requested output is otherwise unbounded (a 1M-context
// model catalogs maxTokens=1M, so the request asks for "remaining window").
// When the provider's real tokenizer disagrees with the estimate by more than
// the reserve, input+output lands above the window and the provider 400s —
// observed on Friendli (GLM-5.3-Flash): a 1-token-over failure proved the
// 4096 reserve was consumed entirely by estimate error.
//
// POLICY (invariant: estimated_input + requested_output + safety_reserve
// <= context_window, enforced inside the clamp):
//   * reserve scales at 5% of estimated input, with an 8192-token floor
//     bounded to one eighth of smaller windows. This buffers tokenizer drift
//     without consuming most of a small model's context.
//   * per-response output ceiling 32768 (PI_TOKEN_BUDGET_CEILING) — a sane
//     absolute cap for this agent harness; no request ever asks for the whole
//     remaining window.
//   * insufficient reply headroom triggers native compact-and-retry locally;
//     no paid one-token request is sent merely because context is full.
// constants here are the single source of truth; the SDK copy exports them
// (bench/token-budget-test.mjs parses them back out of the deployed file).
//
// OVERFLOW RECOVERY (same concern, folded here — do not build a second retry
// path): isContextOverflow's pattern list lacked provider wordings that carry
// the HTTP status instead of the words "context window" (Friendli-style
// `<status>: <body>` 400s, e.g. "reduce the input length", "maximum context
// length"). Extended with /maximum context length/i + /context length
// exceeded/i so those 400s route into the EXISTING compact-and-retry path
// (agent-session _checkCompaction → _runAutoCompaction("overflow")).
//
// Files patched (5 targets):
//   1. pi-ai/dist/api/simple-options.js    — reserve + ceiling clamp (SDK)
//   2. bundle clamp chunk                  — same (runtime)
//   3. bundle bedrock-converse-stream.js   — inlined same functions (runtime)
//   4. pi-ai/dist/utils/overflow.js        — 400-wording patterns (SDK)
//   5. bundle main chunk                   — same (runtime)
//
// Deliberately NOT patched: agent-session's _overflowRecoveryAttempted. The
// stock one-attempt-per-recovery-cycle guard already resets on every successful
// response and on each new user message; a second compact-and-retry after a
// fresh overflow of the just-compacted context has no reason to succeed again.
//
// Idempotent: no-op when each target's replacements are present. Exits 0 on
// success/no-op, 1 on anchor mismatch (upstream refactor — patch needs updating).
// CLI: node token-budget.mjs [--fix]   (default: report only)
import * as fs from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";

const MARKER = "PI_TOKEN_BUDGET";

// ── Policy constants (single source of truth) ─────────────────────────
/** Absolute per-response output ceiling (tokens). No request asks for more. */
export const PI_TOKEN_BUDGET_CEILING = 32768;
/** Floor for the context safety reserve (tokens) — replaces the fixed-only
 *  4096 reserve (CONTEXT_SAFETY_TOKENS stays as the stock constant). */
export const PI_TOKEN_BUDGET_SCALE = 8192;

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

function readSafe(p) {
    try {
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

/** Locate bundle chunk(s) containing `needle` (applied state checked per-target) by
 *  content — Vite rehashes chunk filenames per build, so hash-name lookups break
 *  every update. Scoped needles keep sibling targets from cross-matching: a chunk
 *  carrying the clamp is not the chunk carrying the overflow patterns. */
function findBundleChunksContaining(needle) {
    const dir = path.join(piCoreDir() || "", "dist", "bundle", "chunks");
    const out = [];
    try {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
            const p = path.join(dir, f);
            const src = readSafe(p);
            if (src === null) continue;
            if (src.includes(needle)) out.push(p);
        }
    } catch {
        /* no chunks dir */
    }
    return out;
}

function snippet(src, around, len = 160) {
    if (around === undefined || around === -1) return "(needle absent)";
    const from = Math.max(0, around - 20);
    return JSON.stringify(src.slice(from, from + len));
}

/** Apply a sequence of exact swaps; every `from` must match exactly once.
 *  Throws a guided error if any anchor is missing or ambiguous. */
function applySwaps(file, src, swaps) {
    let out = src;
    for (const { from, to, label } of swaps) {
        if (out.includes(to)) continue;
        const first = out.indexOf(from);
        if (first === -1) {
            throw new Error(
                `${file}: anchor missing (${label}) — upstream refactor, patch needs updating. Near: ` +
                    snippet(out, out.indexOf(label.split("|")[0])),
            );
        }
        if (out.indexOf(from, first + 1) !== -1) {
            throw new Error(
                `${file}: anchor ambiguous (${label}) — refusing edit, add a disambiguator`,
            );
        }
        out = out.slice(0, first) + to + out.slice(first + from.length);
    }
    return out;
}

function isAppliedAll(file, needles) {
    const src = readSafe(file);
    return src !== null && needles.every((n) => src.includes(n));
}

// ── Target 1: pi-ai/dist/api/simple-options.js (SDK, readable) ────────

function simpleOptionsPath() {
    return path.join(
        piCoreDir() || "",
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "api",
        "simple-options.js",
    );
}

const SO_SAFETY_FROM = "const CONTEXT_SAFETY_TOKENS = 4096;";
const SO_SAFETY_TO = [
    `// ${MARKER} (local patch; re-applied by verify-harness.mjs): policy constants.`,
    "// PI_TOKEN_BUDGET_CEILING caps the per-response output; PI_TOKEN_BUDGET_SCALE",
    "// floors the context reserve (which also scales with the estimated input).",
    `export const PI_TOKEN_BUDGET_CEILING = ${PI_TOKEN_BUDGET_CEILING};`,
    `export const PI_TOKEN_BUDGET_SCALE = ${PI_TOKEN_BUDGET_SCALE};`,
    "const CONTEXT_SAFETY_TOKENS = 4096;",
].join("\n");

const SO_CLAMP_FROM = `export function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0)
        return Math.max(MIN_MAX_TOKENS, maxTokens);
    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}`;

const SO_CLAMP_PREV = `export function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0)
        return Math.max(MIN_MAX_TOKENS, maxTokens);
    // ${MARKER} (local patch; re-applied by verify-harness.mjs): enforce
    // estimatedInput + requestedOutput + safetyReserve <= contextWindow.
    // The reserve scales with the estimated input (tokenizer drift grows with
    // prompt size — a fixed reserve alone was eaten whole on Friendli, leaving
    // a 1-token-over 400), floored at PI_TOKEN_BUDGET_SCALE. The result is
    // additionally capped at PI_TOKEN_BUDGET_CEILING so no response ever
    // requests the whole remaining window. MIN_MAX_TOKENS floor preserved:
    // a genuinely full context still sends and relies on the overflow
    // detector + compact-and-retry.
    const estimated = estimateContextTokens(context).tokens;
    const reserve = Math.max(CONTEXT_SAFETY_TOKENS, PI_TOKEN_BUDGET_SCALE, Math.ceil(estimated * 0.05));
    const available = model.contextWindow - estimated - reserve;
    return Math.min(maxTokens, PI_TOKEN_BUDGET_CEILING, Math.max(MIN_MAX_TOKENS, available));
}`;

const SO_CLAMP_ONE_TOKEN_PREV = `export function clampMaxTokensToContext(model, context, maxTokens) {
    /* ${MARKER}: finite output ceiling; small windows retain useful headroom. */
    const declared = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : PI_TOKEN_BUDGET_CEILING;
    const requested = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : declared;
    const ceiling = Math.max(MIN_MAX_TOKENS, Math.min(requested, declared, PI_TOKEN_BUDGET_CEILING));
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return ceiling;
    const window = Math.floor(model.contextWindow);
    const estimated = estimateContextTokens(context).tokens;
    if (!Number.isFinite(estimated) || estimated < 0) return MIN_MAX_TOKENS;
    const floor = Math.min(Math.max(CONTEXT_SAFETY_TOKENS, PI_TOKEN_BUDGET_SCALE), Math.max(128, Math.floor(window / 8)));
    const reserve = Math.max(floor, Math.ceil(estimated * 0.05));
    return Math.min(ceiling, Math.max(MIN_MAX_TOKENS, window - estimated - reserve));
}`;

const SO_CLAMP_TO = SO_CLAMP_ONE_TOKEN_PREV
    .replace('if (!Number.isFinite(estimated) || estimated < 0) return MIN_MAX_TOKENS;',
        'if (!Number.isFinite(estimated) || estimated < 0) throw new Error("Cannot estimate request context; refusing an unsafe output budget.");')
    .replace('return Math.min(ceiling, Math.max(MIN_MAX_TOKENS, window - estimated - reserve));',
        `const available = window - estimated - reserve;
    // Signal Pi's existing bounded compact-and-retry before any provider request.
    // Explicit small output requests remain valid when they actually fit.
    const minimum = Math.min(ceiling, 1024, Math.max(128, Math.floor(window / 16)));
    if (available < minimum) throw new Error("Context length exceeded: insufficient reply headroom (" + available + " tokens available; " + minimum + " needed). Compact context before retrying.");
    return Math.min(ceiling, available);`);

function collapseRepeated(source, text) {
    while (source.includes(text + text))
        source = source.replaceAll(text + text, text);
    return source;
}
function writeChecked(file, source) {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: source,
        stdio: ["pipe", "pipe", "pipe"],
    });
    fs.writeFileSync(file, source);
}

function simpleOptionsTarget() {
    const file = simpleOptionsPath();
    if (!fs.existsSync(file)) return null;
    return {
        name: "sdk: pi-ai simple-options token-budget clamp",
        file,
        exists: () => fs.existsSync(file),
        isApplied: () =>
            isAppliedAll(file, [SO_CLAMP_TO, SO_SAFETY_TO]) &&
            readSafe(file).split("export const PI_TOKEN_BUDGET_CEILING =")
                .length === 2,
        apply: () => {
            const src = collapseRepeated(
                readSafe(file),
                SO_SAFETY_TO.slice(0, -SO_SAFETY_FROM.length),
            );
            const patched = applySwaps(file, src, [
                {
                    from: SO_SAFETY_FROM,
                    to: SO_SAFETY_TO,
                    label: "CONTEXT_SAFETY_TOKENS decl",
                },
                {
                    from: src.includes(SO_CLAMP_ONE_TOKEN_PREV) ? SO_CLAMP_ONE_TOKEN_PREV : src.includes(SO_CLAMP_PREV)
                        ? SO_CLAMP_PREV
                        : SO_CLAMP_FROM,
                    to: SO_CLAMP_TO,
                    label: "clampMaxTokensToContext body",
                },
            ]);
            writeChecked(file, patched);
        },
    };
}

// ── Targets 2+3: bundle chunks carrying the inlined clamp ─────────────

const B_SAFETY_FROM = "CONTEXT_SAFETY_TOKENS=4096,MIN_MAX_TOKENS=1";
const B_SAFETY_TO =
    `PI_TOKEN_BUDGET_CEILING=${PI_TOKEN_BUDGET_CEILING},PI_TOKEN_BUDGET_SCALE=${PI_TOKEN_BUDGET_SCALE},` +
    "CONTEXT_SAFETY_TOKENS=4096,MIN_MAX_TOKENS=1/*" +
    MARKER +
    "*/";

const B_CLAMP_FROM =
    "function clampMaxTokensToContext(model,context,maxTokens){if(model.contextWindow<=0)return Math.max(MIN_MAX_TOKENS,maxTokens);let available=model.contextWindow-estimateContextTokens(context).tokens-CONTEXT_SAFETY_TOKENS;return Math.min(maxTokens,Math.max(MIN_MAX_TOKENS,available))}";

const B_CLAMP_PREV =
    "function clampMaxTokensToContext(model,context,maxTokens){if(model.contextWindow<=0)return Math.max(MIN_MAX_TOKENS,maxTokens);" +
    "/*" +
    MARKER +
    " (local patch; re-applied by verify-harness.mjs): reserve scales with estimated input (tokenizer drift), floored at PI_TOKEN_BUDGET_SCALE; result capped at PI_TOKEN_BUDGET_CEILING — estimatedInput+requestedOutput+safetyReserve<=contextWindow always.*/" +
    "let estimatedTokens=estimateContextTokens(context).tokens;" +
    "let reserve=Math.max(CONTEXT_SAFETY_TOKENS,PI_TOKEN_BUDGET_SCALE,Math.ceil(estimatedTokens*.05));" +
    "let available=model.contextWindow-estimatedTokens-reserve;" +
    "return Math.min(maxTokens,PI_TOKEN_BUDGET_CEILING,Math.max(MIN_MAX_TOKENS,available))}";

// One policy body for SDK and CLI: keep their edge-case behavior identical.
const B_CLAMP_ONE_TOKEN_PREV = SO_CLAMP_ONE_TOKEN_PREV.replace(/^export /, "");
const B_CLAMP_TO = SO_CLAMP_TO.replace(/^export /, "");

function bundleClampTarget(file) {
    return {
        name: `bundle: token-budget clamp (${path.basename(file)})`,
        file,
        exists: () => fs.existsSync(file),
        isApplied: () =>
            isAppliedAll(file, [B_CLAMP_TO, B_SAFETY_TO]) &&
            readSafe(file).split(
                `PI_TOKEN_BUDGET_CEILING=${PI_TOKEN_BUDGET_CEILING},`,
            ).length === 2,
        apply: () => {
            const prefix = B_SAFETY_TO.slice(
                0,
                B_SAFETY_TO.indexOf(B_SAFETY_FROM),
            );
            const src = collapseRepeated(
                collapseRepeated(readSafe(file), prefix),
                `/*${MARKER}*/`,
            );
            const patched = applySwaps(file, src, [
                {
                    from: B_SAFETY_FROM,
                    to: B_SAFETY_TO,
                    label: "CONTEXT_SAFETY_TOKENS=4096",
                },
                {
                    from: src.includes(B_CLAMP_ONE_TOKEN_PREV) ? B_CLAMP_ONE_TOKEN_PREV : src.includes(B_CLAMP_PREV)
                        ? B_CLAMP_PREV
                        : B_CLAMP_FROM,
                    to: B_CLAMP_TO,
                    label: "clampMaxTokensToContext body",
                },
            ]);
            writeChecked(file, patched);
        },
    };
}

// ── Targets 4+5: overflow-pattern extension (400 wordings) ────────────

const OV_FRIENDLI_COMMENT = [
    "    // pi-harness local patch (re-applied by verify-harness.mjs): providers that",
    "    // report context overflow via the HTTP status + generic wording instead of",
    "    // the specific phrases above (Friendli-style `<status>: <body>` 400s).",
    "    // Routes those 400s into the existing compact-and-retry path.",
].join("\n");

const OV_SDK_FROM = "    /token limit exceeded/i,";
const OV_SDK_TO =
    OV_FRIENDLI_COMMENT +
    "\n    /maximum context length/i,\n    /context length exceeded/i,\n" +
    OV_SDK_FROM;

function overflowSdkPath() {
    return path.join(
        piCoreDir() || "",
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "utils",
        "overflow.js",
    );
}

function overflowSdkTarget() {
    const file = overflowSdkPath();
    if (!fs.existsSync(file)) return null;
    return {
        name: "sdk: pi-ai overflow patterns (400 wordings)",
        file,
        exists: () => fs.existsSync(file),
        isApplied: () => isAppliedAll(file, ["/maximum context length/i"]),
        apply: () => {
            const src = readSafe(file);
            fs.writeFileSync(
                file,
                applySwaps(file, src, [
                    {
                        from: OV_SDK_FROM,
                        to: OV_SDK_TO,
                        label: "/token limit exceeded/i",
                    },
                ]),
            );
        },
    };
}

const OV_BUNDLE_FROM =
    "/token limit exceeded/i,/^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i]";
const OV_BUNDLE_TO =
    "/token limit exceeded/i,/*" +
    MARKER +
    " (local patch): 400 wordings without the stock phrases route to compact-and-retry*/" +
    "/maximum context length/i,/context length exceeded/i," +
    "/^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i]";

function overflowBundleTarget(file) {
    return {
        name: `bundle: overflow patterns (400 wordings) (${path.basename(file)})`,
        file,
        exists: () => fs.existsSync(file),
        isApplied: () => isAppliedAll(file, ["/maximum context length/i"]),
        apply: () => {
            const src = readSafe(file);
            fs.writeFileSync(
                file,
                applySwaps(file, src, [
                    {
                        from: OV_BUNDLE_FROM,
                        to: OV_BUNDLE_TO,
                        label: "token limit exceeded",
                    },
                ]),
            );
        },
    };
}

// ── Target table ──────────────────────────────────────────────────────

export function targets() {
    const out = [];
    const so = simpleOptionsTarget();
    if (so) out.push(so);

    // Clamp chunks: every chunk carrying the inlined clamp function.
    const clampNeedle = "function clampMaxTokensToContext(";
    for (const chunk of findBundleChunksContaining(clampNeedle)) {
        // The SDK path lives under node_modules — only bundle chunks here.
        if (
            chunk.includes(
                `${path.sep}dist${path.sep}bundle${path.sep}chunks${path.sep}`,
            )
        ) {
            out.push(bundleClampTarget(chunk));
        }
    }

    const ovSdk = overflowSdkTarget();
    if (ovSdk) out.push(ovSdk);

    // Overflow-pattern bundle chunks: the main chunk carries the patterns.
    const ovNeedle = "/token limit exceeded/i";
    for (const chunk of findBundleChunksContaining(ovNeedle)) {
        if (
            chunk.includes(
                `${path.sep}dist${path.sep}bundle${path.sep}chunks${path.sep}`,
            )
        ) {
            out.push(overflowBundleTarget(chunk));
        }
    }
    // Every required role must survive discovery; SDK-only success is not
    // runtime protection. A changed copy count requires explicit review.
    if (
        !so ||
        !ovSdk ||
        out.filter((t) => t.name.startsWith("bundle: token-budget")).length !==
            2 ||
        out.filter((t) => t.name.startsWith("bundle: overflow")).length !== 1
    ) {
        throw new Error(
            "token budget: required SDK/runtime targets missing or copy count changed",
        );
    }
    return out;
}

// ── CLI (only when run directly — verify-harness imports targets() and must
// not be killed by our process.exit) ──────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("token-budget.mjs")) {
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
