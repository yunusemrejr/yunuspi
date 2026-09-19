// Request-body limit gate patch — re-applied by verify-harness.mjs [3].
// Lives OUTSIDE node_modules so it survives `npm update`; the patched files
// (pi bundle chunks + the SDK copies) do not.
//
// WHAT: providers cap the ENCODED request body (OpenRouter/runinfra: 3.5 MB),
// which is a byte limit on the JSON body sent — separate from the model
// context window. Pi's stock compaction fires on TOKENS, so a session well
// under the token cap can still exceed the body cap: a pasted screenshot is
// ~1.3x larger once base64-encoded (a single image ~ 2.6 MB at natural size)
// and every resent earlier turn adds bytes. Symptom: opaque
// `413 {"code":"payload_too_large"}` that retries cannot fix.
//
// Two-part fix, both in this module (single owner of the 413 concern):
//
//   PI_IMAGE_BUDGET — attach-time per-image budget. Pi's image resize default
//   `DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024` is tuned for Anthropic's 5 MB
//   *message* limit, which EXCEEDS this harness's 3.5 MB *whole-request* cap.
//   An image can pass the attach-time gate at up to 4.5 MB of base64 and then
//   the provider rejects the whole request. Lowered to 1.5 MB so a single
//   image + worst-case context (<=120k-token compaction cap ~ ~0.8 MB JSON)
//   clears the cap; the existing quality/dimension descent still guarantees a
//   fit. Capability preserved — the image is still attached, just encoded
//   tighter.
//
//   PI_BODY_GATE — send-time whole-request gate at the `onPayload` closure
//   (the single pre-send chokepoint shared by every provider chunk). After
//   `before_provider_request` handlers run, serialize the final params and
//   measure UTF-8 bytes. Under the threshold: zero-overhead pass-through.
//   Over it: throw a quantified, actionable error BEFORE the HTTP call —
//   deterministic (no retry loop, no provider round-trip) and visible as the
//   turn error, instead of pi's opaque provider 413. The gate sits AFTER the
//   extension hook because `emitBeforeProviderRequest` swallows handler
//   throws, so the extension layer cannot block a request.
//
// ROBUSTNESS (why this module never needs hand-porting for formatting churn):
// a byte-exact anchor breaks on ANY upstream reformatting. This module instead
// owns each REGION semantically:
//   * image budget: matches the `DEFAULT_MAX_BYTES = <expr>` assignment with a
//     whitespace/spacing-tolerant regex and replaces the value (survives
//     comment drift, pretty/minified spacing, even an upstream 4.5->5.0 bump —
//     our cap-derived policy wins; a missing assignment is a guided failure).
//   * body gate: LOCATES the `onPayload` property, verifies the semantic seam
//     (`emitBeforeProviderRequest` call) still exists inside, then overwrites
//     the whole arrow body via a string/comment-aware balanced-brace scan.
//     Survives any interior reformatting (params, spacing, unrelated lines);
//     fails loudly ONLY if pi truly renames/removes `onPayload` or drops the
//     hook — a genuine semantic change worth a human decision, and even then
//     the error says exactly what was found instead.
//   * chunk discovery: locates the main chunk by code structure (onPayload +
//     hook), the worker by `node:worker_threads`, never by hashed filename.
// The ONLY case needing a human is a semantic seam removal, surfaced
// fail-visibly by apply() with a "found instead" diagnostic.
//
// Files patched (5 targets):
//   1. dist/utils/image-resize-core.js   — DEFAULT_MAX_BYTES (SDK path)
//   2. bundle main shared chunk          — DEFAULT_MAX_BYTES (runtime path, inlined copy)
//   3. bundle image-resize-worker chunk  — DEFAULT_MAX_BYTES (standalone resize worker)
//   4. dist/core/sdk.js                  — onPayload body gate (SDK path)
//   5. bundle main shared chunk          — onPayload body gate (runtime path)
//
// Threshold policy (user spec): gate fires strictly above
// `PROVIDER_REQUEST_BODY_CAP - GATE_SAFETY_BYTES` where
// PROVIDER_REQUEST_BODY_CAP = 3.5 * 1024 * 1024 (the provider hard limit)
// and GATE_SAFETY_BYTES = 128 * 1024 (margin for serialization edge cases so
// we never send a body the provider would reject). The per-image attach
// budget IMAGE_MAX_BYTES = 1.5 * 1024 * 1024 is derived (cap minus ~2 MB
// headroom for context + JSON) and subordinate to the cap.
//
// Idempotent: no-op when each target's own region matches its marker + value.
// apply() also MIGRATES an already-applied old version (region overwrite), so
// updating this module re-applies cleanly without a pristine restore.
// Exits 0 on success/no-op, 1 on a genuine semantic failure.
// CLI: node request-body-gate.mjs [--fix]   (default: report only)
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

const IMAGE_BUDGET_MARKER = "PI_IMAGE_BUDGET";

/** Provider hard limit on the ENCODED request body (bytes). From the observed
 *  `413 payload_too_large` message; OpenRouter/runinfra both enforce ~3.5 MB.
 *  This is the canonical value — PI_IMAGE_BUDGET derives from it. */
export const PROVIDER_REQUEST_BODY_CAP = 3.5 * 1024 * 1024; // 3,670,016
/** Margin subtracted from the cap so the gate never sends a body the provider
 *  would reject (JSON escaping / serialization edge cases). */
export const GATE_SAFETY_BYTES = 128 * 1024;
/** Gate threshold: fire strictly above this. 3,538,944 bytes ~ 3.375 MB. */
export const GATE_THRESHOLD_BYTES =
    PROVIDER_REQUEST_BODY_CAP - GATE_SAFETY_BYTES;
/** Per-image attach budget (base64 string bytes). Derived: cap minus ~2 MB of
 *  headroom for worst-case context + JSON overhead. WHY 1.5 MB not lower: it
 *  is rarely even reached (typical screenshots re-encode to 200–500 KB) but
 *  guarantees a single image + full 120k-token context stays under the cap. */
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024; // 1,572,864

// Route policy, NOT a universal model/context limit. In particular Codex uses
// Responses payloads and must not inherit another gateway's byte ceiling.
export const BODY_LIMIT_PROVIDERS = ["openrouter", "runinfra", "friendli"];
export function hasRequestBodyLimit(provider) {
    return !provider || BODY_LIMIT_PROVIDERS.includes(provider);
}
const SCOPE_GUARD = `/*PI_BODY_GATE_SCOPE*/if(_model?.provider&&!${JSON.stringify(BODY_LIMIT_PROVIDERS)}.includes(_model.provider))return gatePayload;`;

// ---------------------------------------------------------------------------
// region helpers (string/comment-aware) so braces inside literals/comments
// never corrupt the balanced-closure scan
// ---------------------------------------------------------------------------

/** Index of the `{` that opens the arrow body AFTER the `=>` token. Returns
 *  -1 if the arrow has no brace body (expression arrow — not ours). */
function findArrowBodyOpen(src, after) {
    const arrow = src.indexOf("=>", after);
    if (arrow === -1) return -1;
    let i = arrow + 2;
    while (i < src.length && /\s/.test(src[i])) i++;
    return src[i] === "{" ? i : -1;
}

/** Index of the `}` closing the brace that opened at openIdx, ignoring braces
 *  inside string literals and comments ({...} in our injected docs/comments must
 *  not affect the count). Returns -1 if unbalanced. */
function closingBrace(src, openIdx) {
    let depth = 0;
    let inStr = null; // quote char for the active string, null when outside
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if (lineComment) {
            if (c === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (c === "*" && next === "/") {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (inStr) {
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === inStr) {
                inStr = null;
            }
            continue;
        }
        if (c === "/" && next === "/") {
            lineComment = true;
            i++;
            continue;
        }
        if (c === "/" && next === "*") {
            blockComment = true;
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            inStr = c;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** First match index/range of a ReGeX or string needle in src, or null. */
function locate(src, needle) {
    if (needle instanceof RegExp) {
        needle.lastIndex = 0;
        return needle.exec(src);
    }
    const i = src.indexOf(needle);
    return i === -1 ? null : { index: i, 0: needle, length: needle.length };
}

/** how many times does the needle match (0..n). Clones with /g: a non-global
 *  `regex.exec` returns the same first match forever, so without this an
 *  apply-from-pristine would spin. Zero-width matches still advance lastIndex. */
function countMatches(src, needle) {
    if (needle instanceof RegExp) {
        const g = new RegExp(
            needle.source,
            needle.flags.includes("g") ? needle.flags : needle.flags + "g",
        );
        let n = 0;
        let m;
        while ((m = g.exec(src))) {
            n++;
            if (m[0] === "") g.lastIndex++;
        }
        return n;
    }
    return src.split(needle).length - 1;
}

function regionReplace(file, src, start, end, replacement) {
    fs.writeFileSync(file, src.slice(0, start) + replacement + src.slice(end));
}

/** Human-useful "found instead" snippet for guided diagnostics. */
function snippet(src, around, len = 160) {
    if (around === -1 || around === undefined) {
        return "(needle absent)";
    }
    const from = Math.max(0, around - 20);
    return JSON.stringify(src.slice(from, from + len));
}

// ---------------------------------------------------------------------------
// PI_IMAGE_BUDGET target logic (SDK + both bundle copies)
// ---------------------------------------------------------------------------

const BUDGET_COMMENT = [
    "// " +
        IMAGE_BUDGET_MARKER +
        " (local patch; re-applied by verify-harness.mjs): the stock default",
    "// was 4.5 MB of base64 payload, tuned for headroom below Anthropic's 5 MB",
    "// *message* limit — but this harness's providers (OpenRouter/runinfra)",
    "// cap the WHOLE encoded request body at ~3.5 MB, so an image passing the",
    "// old budget alone could exceed the cap and the provider would reject the",
    "// request with `413 payload_too_large`. Lowered to 1.5 MB base64, which",
    "// leaves ~2 MB of headroom for context + JSON at the compaction cap; the",
    "// existing quality/dimension descent still guarantees a fit. Small-image",
    "// behavior is unchanged — the budget only bounds the worst case. See",
    "// scripts/compatibility/legacy-transforms/request-body-gate.mjs (PI_BODY_GATE enforces the total).",
].join("\n");

/** regex for the assignment line in the pretty-printed SDK file; value-agnostic
 *  so a spacing/comment/even-value change upstream still applies (we own the
 *  value by policy). `[^;]+;` consumes to the semicolon. */
const RE_BUDGET_CONST = /const\s+DEFAULT_MAX_BYTES\s*=\s*[^;\n]*;?/;

/** regex for the value expression in the minified bundle (after DEFAULT_MAX_BYTES=). */
// REMOVED 2026-09-06: numeric-prefix [0-9.*]+ stopped at the first space, so a
// spaced `DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024` was replaced leaving
// ` * 1024 * 1024` behind — silently inflating the cap ~1e6x. The budget is now
// parsed as a COMPLETE arithmetic expression (whitespace/comment-tolerant) and
// requires a declaration terminator right after; trailing/unknown layouts are
// never partially consumed.

function skipBudgetTrivia(src, i) {
    for (;;) {
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src.startsWith("//", i)) {
            const nl = src.indexOf("\n", i);
            i = nl === -1 ? src.length : nl + 1;
            continue;
        }
        if (src.startsWith("/*", i)) {
            const close = src.indexOf("*/", i + 2);
            if (close === -1) return src.length;
            i = close + 2;
            continue;
        }
        return i;
    }
}

/** Strips whitespace + comments from an initializer region (for canonical
 *  value comparison). */
function stripBudgetTrivia(s) {
    return s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
}

const BUDGET_DECL_RE = /DEFAULT_MAX_BYTES\s*=/;

/** Parse the DEFAULT_MAX_BYTES initializer in a minified/pretty chunk region.
 *  Returns null when the layout is NOT a plain arithmetic constant followed by
 *  a declaration terminator (`,`, `;`, `}` or EOF) — callers fail loudly then.
 *  Returns { start, end, stripped, marker } otherwise, where [start,end) is the
 *  exact region to rewrite (through any trailing comment, before the
 *  terminator) and `stripped` is the comment/space-free expression text.
 *  `marker` is true when the region already carries the PI_IMAGE_BUDGET comment.
 *  NOTE: only the FIRST site is parsed; callers enforce a single site. */
export function parseBundleBudgetRegion(src) {
    const m = BUDGET_DECL_RE.exec(src);
    if (!m) return null;
    const start = m.index;
    const i = skipBudgetTrivia(src, m.index + m[0].length);
    if (i >= src.length) return null;
    const exprStart = i;
    const numRe = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
    const parseTerm = (at) => {
        let j = skipBudgetTrivia(src, at);
        const c = src[j];
        if (c === "+" || c === "-") j = skipBudgetTrivia(src, j + 1);
        if (src[j] === "(") {
            const inner = parseExpr(j + 1);
            if (inner === null) return null;
            const close = skipBudgetTrivia(src, inner);
            return src[close] === ")" ? close + 1 : null;
        }
        numRe.lastIndex = j;
        const nm = numRe.exec(src);
        return nm === null ? null : j + nm[0].length;
    };
    const parseExpr = (at) => {
        const first = parseTerm(at);
        if (first === null) return null;
        let end = first;
        for (;;) {
            const op = skipBudgetTrivia(src, end);
            if (
                src[op] === "*" ||
                src[op] === "/" ||
                src[op] === "+" ||
                src[op] === "-" ||
                src[op] === "%"
            ) {
                const term = parseTerm(op + 1);
                if (term === null) return null;
                end = term;
            } else break;
        }
        return end;
    };
    const exprEnd = parseExpr(i);
    if (exprEnd === null || exprEnd === exprStart) return null;
    const term = skipBudgetTrivia(src, exprEnd);
    if (term >= src.length) return null; // value must not run to EOF
    const c = src[term];
    if (c !== "," && c !== ";" && c !== "}") return null; // trailing junk -> reject loudly
    const region = src.slice(start, term);
    const stripped = stripBudgetTrivia(region);
    if (!/^DEFAULT_MAX_BYTES=/.test(stripped)) return null;
    return {
        start,
        end: term,
        stripped,
        marker: region.includes(IMAGE_BUDGET_MARKER),
    };
}

/** Canonical minified bundle replacement: whole-initializer rewrite.
 *  Pure (source in, source out); throws on unknown layouts. */
export function patchBundleBudgetSource(src) {
    const sites = countMatches(src, BUDGET_DECL_RE);
    if (sites === 0) {
        throw new Error(
            "no `DEFAULT_MAX_BYTES=<expr>` found (missing assignment)",
        );
    }
    if (sites > 1) {
        throw new Error(
            `${sites} \`DEFAULT_MAX_BYTES=\` sites — refusing ambiguous edit, add a disambiguator`,
        );
    }
    const p = parseBundleBudgetRegion(src);
    if (!p) {
        const near = src.indexOf("DEFAULT_MAX_BYTES");
        throw new Error(
            "DEFAULT_MAX_BYTES initializer is not a plain arithmetic constant followed by a declaration terminator — refusing to partially consume or silently mis-parse. Near: " +
                snippet(src, near, 200),
        );
    }
    const canonical = `DEFAULT_MAX_BYTES=${IMAGE_MAX_BYTES} /*${IMAGE_BUDGET_MARKER}*/`;
    if (p.stripped === `DEFAULT_MAX_BYTES=${IMAGE_MAX_BYTES}` && p.marker) {
        return src; // already canonical
    }
    return src.slice(0, p.start) + canonical + src.slice(p.end);
}

function budgetApplied(src) {
    return (
        src.includes(IMAGE_BUDGET_MARKER) &&
        src.includes(`DEFAULT_MAX_BYTES = ${IMAGE_MAX_BYTES};`)
    );
}

function budgetApply(file, src, style) {
    if (budgetApplied(src)) return;
    // style is passed by the target ("sdk" for the pretty SDK file, "bundle"
    // for minified chunks). NEVER inferred from src content — a cosmetic
    // upstream change to the declaration (spacing, `let`-vs-`const`) must not
    // flip which replacement path runs.
    if (style === "bundle") {
        const patched = patchBundleBudgetSource(src);
        if (patched !== src) fs.writeFileSync(file, patched);
        return;
    }
    // ── SDK pretty copy ────────────────────────────────────────────────────
    const m = locate(src, RE_BUDGET_CONST);
    if (!m || countMatches(src, RE_BUDGET_CONST) !== 1 || !m[0].includes("=")) {
        throw new Error(
            `${file}: couldn't unambiguously find \`const DEFAULT_MAX_BYTES = ...;\` — ` +
                snippet(src, src.indexOf("DEFAULT_MAX_BYTES")),
        );
    }
    const prevLineStart = src.lastIndexOf("\n", m.index - 1) + 1;
    const prevLines = src.slice(prevLineStart, m.index);
    // If a previous application's comment block sits directly above, consume it
    // so re-budgets don't stack stale comment blocks.
    const startsWithOurComment = prevLines.includes(IMAGE_BUDGET_MARKER);
    const replaceFrom = startsWithOurComment ? prevLineStart : m.index;
    const replacement =
        BUDGET_COMMENT + "\n" + `const DEFAULT_MAX_BYTES = ${IMAGE_MAX_BYTES};`;
    regionReplace(file, src, replaceFrom, m.index + m[0].length, replacement);
}

// ---------------------------------------------------------------------------
// PI_BODY_GATE target logic (SDK + bundle main chunk)
// ---------------------------------------------------------------------------

const RE_ONPAYLOAD = /onPayload\s*:\s*async\s*\(/;

function gateApplied(src) {
    return (
        src.includes(SDK_GATE_REPLACEMENT) ||
        src.includes(BUNDLE_GATE_REPLACEMENT)
    );
}

/** All `onPayload: async(...)` closures with a brace body. More than one site
 *  exists since 0.85.0: the lane/drive streaming path hooks
 *  `lane.hooks.runWithGate("before_payload")` — a different hook system with
 *  an expression body, which is skipped here (the gate needs a block body to
 *  inject its statements into). */
function findGateCandidates(src) {
    const re = new RegExp(RE_ONPAYLOAD.source, "g");
    const sites = [];
    let m;
    while ((m = re.exec(src))) {
        const bodyOpen = findArrowBodyOpen(src, m.index);
        if (bodyOpen === -1) continue;
        const bodyClose = closingBrace(src, bodyOpen);
        if (bodyClose === -1) continue;
        sites.push({ index: m.index, bodyClose });
    }
    return sites;
}

function gateApply(file, src, newClosure, label) {
    if (gateApplied(src)) return;
    // Site identity is the SEMANTIC SEAM, not the property name: exactly one
    // `onPayload` closure must call `emitBeforeProviderRequest` — the gate
    // applies there. Zero sites means the chokepoint moved or changed shape;
    // several seam-bearing sites means an upstream refactor that must be
    // reviewed, never guessed at.
    const sites = findGateCandidates(src);
    if (sites.length === 0) {
        throw new Error(
            `${file}: no \`onPayload: async(...)\` closure with a brace body found. Does the file still ` +
                `contain the payload chokepoint? found near \`payload\` → ` +
                snippet(src, src.indexOf("onPayload")),
        );
    }
    const seams = sites.filter((s) =>
        src
            .slice(s.index, s.bodyClose + 1)
            .includes("emitBeforeProviderRequest"),
    );
    if (seams.length === 0) {
        throw new Error(
            `${file}: onPayload closure no longer calls \`emitBeforeProviderRequest\` ` +
                `(${label} — pi dropped the before_provider_request hook?). ` +
                `Not safe to inject PI_BODY_GATE; the closure now reads: ` +
                snippet(src, sites[0].index, 200),
        );
    }
    if (seams.length > 1) {
        throw new Error(
            `${file}: ${seams.length} \`onPayload\` sites call \`emitBeforeProviderRequest\` — refusing ambiguous edit`,
        );
    }
    regionReplace(
        file,
        src,
        seams[0].index,
        seams[0].bodyClose + 1,
        newClosure,
    );
}

// Canonical gate closures. These must be byte-exact: they are the stock
// `onPayload` arrow body REPLACED wholesale, so they must reproduce the exact
// stock hook call plus our gate. Rather than hand-transcribed (drift risk),
// they are generated once from the applied files by
// scripts/dev/gen-gate-closures.mjs — see the header of this file. Template
// literals are safe here: the backticks / `$` braces that occur inside are
// comment-doc only and get escaped by the generator; the generated file
// round-trips byte-exact back to the raw closure.
// Exported: verify-harness's bench pins these as part of the behavioral check.
export const SDK_GATE_REPLACEMENT = `onPayload: async (payload, _model) => {
            // PI_BODY_GATE (local patch; re-applied by verify-harness.mjs): enforce the
            // provider's hard ENCODED-request-body cap before the HTTP call. Token
            // compaction cannot bound request BYTES: a base64 image is ~1.3x its
            // raw size and every resent turn adds bytes, so a session under the
            // token cap can still exceed the body cap. Oversized requests fail
            // here with a quantified, actionable error instead of the opaque
            // provider \`413 payload_too_large\`. Sits after the extension hook
            // because the runner swallows handler throws — this is the one point
            // that can actually block.
            const runner = extensionRunnerRef.current;
            let gatePayload = runner?.hasHandlers("before_provider_request")
                ? await runner.emitBeforeProviderRequest(payload)
                : payload;
            ${SCOPE_GUARD}
            let __piSerialized;
            try {
                __piSerialized = JSON.stringify(gatePayload);
            } catch {
                return gatePayload; // unmeasurable — never block on a guard failure
            }
            const __piBytes =
                typeof Buffer !== "undefined"
                    ? Buffer.byteLength(__piSerialized, "utf8")
                    : new TextEncoder().encode(__piSerialized).length;
            if (__piBytes > 3538944) {
                let __piImageBytes = 0;
                let __piImageCount = 0;
                try {
                    const __piScan = (node) => {
                        if (!node || typeof node !== "object") return;
                        if (Array.isArray(node)) {
                            for (const item of node) __piScan(item);
                            return;
                        }
                        // Anthropic blocks use \`source:{type:"base64",media_type,data}\`
                        // (in the nested \`source\` object); OpenAI uses \`image_url.url:"data:..."\`.
                        if (typeof node.url === "string" && node.url.startsWith("data:")) {
                            __piImageBytes += node.url.length;
                            __piImageCount++;
                        } else if (typeof node.data === "string" && (node.media_type?.startsWith("image/") || node.mimeType?.startsWith("image/"))) {
                            __piImageBytes += node.data.length;
                            __piImageCount++;
                        }
                        for (const key of Object.keys(node)) {
                            const value = node[key];
                            if (value !== null && typeof value === "object") __piScan(value);
                        }
                    };
                    const messages = Array.isArray(gatePayload?.messages) ? gatePayload.messages : [];
                    __piScan(messages);
                } catch {
                    /* best-effort breakdown */
                }
                const mb = (bytes) => (bytes / 1048576).toFixed(2);
                const imageMb = mb(Math.min(__piImageBytes, __piBytes));
                const contextBytes = Math.max(0, __piBytes - __piImageBytes);
                throw new Error(
                    "[pi-harness request-body gate] blocked before send: encoded request body ~ " +
                        mb(__piBytes) +
                        ' MB exceeds the local 3.375 MB safety threshold for this route (128 KB below its ~3.5 MB request limit) (a byte limit, separate from the token window; base64 inflates images ~1.3x and resent turns add up). ' +
                        (__piImageCount > 0
                            ? __piImageCount + ' image' + (__piImageCount === 1 ? ' ~ ' : 's ~ ') + imageMb + ' MB (base64), other/context content ~ ' + mb(contextBytes) + ' MB. '
                            : '') +
                        'Send less context or a smaller/fewer image(s), then retry.'
                );
            }
            return gatePayload;
        }`;
export const BUNDLE_GATE_REPLACEMENT = `onPayload:async(payload,_model)=>{/*PI_BODY_GATE*/let runner=extensionRunnerRef.current,gatePayload=runner?.hasHandlers("before_provider_request")?await runner.emitBeforeProviderRequest(payload):payload;${SCOPE_GUARD}let __piS;try{__piS=JSON.stringify(gatePayload)}catch{return gatePayload}let __piB=typeof Buffer!=="undefined"?Buffer.byteLength(__piS,"utf8"):new TextEncoder().encode(__piS).length;if(__piB>3538944){let __piImg=0,__piImgN=0;try{let __piWalk=(n)=>{if(!n||typeof n!=="object")return;if(Array.isArray(n)){for(let x of n)__piWalk(x);return}if(typeof n.url==="string"&&n.url.startsWith("data:")){__piImg+=n.url.length;__piImgN++}else if(typeof n.data==="string"&&(n.media_type?.startsWith("image/")||n.mimeType?.startsWith("image/"))){__piImg+=n.data.length;__piImgN++}for(let k in n){let v=n[k];if(v!==null&&typeof v==="object")__piWalk(v)}};__piWalk(Array.isArray(gatePayload?.messages)?gatePayload.messages:[])}catch{}let __piM=b=>(b/1048576).toFixed(2),__piImgMb=__piM(Math.min(__piImg,__piB)),__piCtx=Math.max(0,__piB-__piImg);throw new Error("[pi-harness request-body gate] blocked before send: encoded request body ~ "+__piM(__piB)+" MB exceeds the local 3.375 MB safety threshold for this route (128 KB below its ~3.5 MB request limit) (a byte limit, separate from the token window; base64 inflates images ~1.3x and resent turns add up). "+(__piImgN>0?__piImgN+" image"+(__piImgN===1?" ~ ":"s ~ ")+__piImgMb+" MB (base64), other/context content ~ "+__piM(__piCtx)+" MB. ":"")+"Send less context or a smaller/fewer image(s), then retry.")}return gatePayload}`;

// ---------------------------------------------------------------------------
// discovery: content/structural, never by hashed chunk filename
// ---------------------------------------------------------------------------

function piCoreDir() {
    // Test seam: anchor-resilience bench runs the real apply() against a
    // scratch copy of the dist tree (env var set by that bench only).
    if (process.env.PI_HARNESS_PATCH_TEST_CORE) {
        return process.env.PI_HARNESS_PATCH_TEST_CORE;
    }
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

function listChunks() {
    const dir = path.join(piCoreDir() || "", "dist", "bundle", "chunks");
    try {
        return fs
            .readdirSync(dir)
            .filter((n) => n.endsWith(".js"))
            .map((n) => ({ name: n, path: path.join(dir, n) }));
    } catch {
        return [];
    }
}

function readSafe(p) {
    try {
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

export function targets() {
  if (!process.env.PI_HARNESS_PATCH_TEST_CORE) throw Error("Legacy transform targets are test-only; set an isolated fixture core explicitly");
    const core = piCoreDir();
    if (!core) return [];

    const sdkBudget = path.join(core, "dist", "utils", "image-resize-core.js");
    const sdkGate = path.join(core, "dist", "core", "sdk.js");
    for (const [label, file] of [
        ["SDK image budget", sdkBudget],
        ["SDK request-body gate", sdkGate],
    ]) {
        if (!fs.existsSync(file)) {
            throw new Error(
                `request-body-gate: required ${label} target is missing: ${file}`,
            );
        }
    }

    const chunks = listChunks().flatMap((chunk) => {
        const src = readSafe(chunk.path);
        return src === null ? [] : [{ ...chunk, src }];
    });
    if (chunks.length === 0) {
        throw new Error(
            "request-body-gate: no runtime bundle chunks found — bundle layout changed",
        );
    }

    // Discover budget and gate seams INDEPENDENTLY. Coupling gate discovery to
    // DEFAULT_MAX_BYTES previously let an upstream chunk split silently remove
    // the runtime gate target while unrelated budget targets kept verification
    // green. Today Pi has exactly two runtime budget copies (main + worker) and
    // one seam-bearing onPayload chunk; any count drift requires review.
    const budgetChunks = chunks.filter(({ src }) =>
        /DEFAULT_MAX_BYTES\s*=/.test(src),
    );
    if (budgetChunks.length !== 2) {
        throw new Error(
            `request-body-gate: expected 2 runtime DEFAULT_MAX_BYTES targets, found ${budgetChunks.length}`,
        );
    }
    const gateChunks = chunks.filter(({ src }) =>
        findGateCandidates(src).some((site) =>
            src
                .slice(site.index, site.bodyClose + 1)
                .includes("emitBeforeProviderRequest"),
        ),
    );
    if (gateChunks.length !== 1) {
        throw new Error(
            `request-body-gate: expected exactly 1 runtime onPayload/emitBeforeProviderRequest seam, found ${gateChunks.length}`,
        );
    }

    const out = [
        {
            name: "sdk: image-resize per-image budget",
            file: sdkBudget,
            exists: () => fs.existsSync(sdkBudget),
            isApplied: () => {
                const s = readSafe(sdkBudget);
                return s !== null && budgetApplied(s);
            },
            apply: () => budgetApply(sdkBudget, readSafe(sdkBudget), "sdk"),
        },
    ];

    for (const chunk of budgetChunks) {
        const isWorker = chunk.src.includes("parentPort");
        out.push({
            name: `bundle: image-resize per-image budget (${isWorker ? "worker chunk" : "chunk"})`,
            file: chunk.path,
            exists: () => fs.existsSync(chunk.path),
            isApplied: () => {
                const s = readSafe(chunk.path);
                if (s === null) return false;
                if (budgetApplied(s)) return true;
                const p = parseBundleBudgetRegion(s);
                return (
                    p !== null &&
                    p.marker &&
                    p.stripped === `DEFAULT_MAX_BYTES=${IMAGE_MAX_BYTES}`
                );
            },
            apply: () =>
                budgetApply(chunk.path, readSafe(chunk.path), "bundle"),
        });
    }

    const bundleGate = gateChunks[0];
    out.push({
        name: "bundle: onPayload whole-request body gate",
        file: bundleGate.path,
        exists: () => fs.existsSync(bundleGate.path),
        isApplied: () => {
            const s = readSafe(bundleGate.path);
            return s !== null && gateApplied(s);
        },
        apply: () =>
            gateApply(
                bundleGate.path,
                readSafe(bundleGate.path),
                BUNDLE_GATE_REPLACEMENT,
                "bundle chunk",
            ),
    });

    out.push({
        name: "sdk: onPayload whole-request body gate",
        file: sdkGate,
        exists: () => fs.existsSync(sdkGate),
        isApplied: () => {
            const s = readSafe(sdkGate);
            return s !== null && gateApplied(s);
        },
        apply: () =>
            gateApply(
                sdkGate,
                readSafe(sdkGate),
                SDK_GATE_REPLACEMENT,
                "sdk.js",
            ),
    });
    return out;
}

// ---------------------------------------------------------------------------
// CLI (only when run directly — verify-harness imports targets() and must not
// be killed by our process.exit)
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("request-body-gate.mjs")) {
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
