// Rate-limit + gateway-SSE retry policy patch — re-applied by verify-harness.mjs.
// Lives OUTSIDE node_modules so it survives `npm update`; the patched files
// (pi bundle chunk + the SDK copies of the retry loop) do not.
//
// WHAT: today a 429 (or any rate-limit error) burns the same retry budget as a
// transient 500 — 3 attempts of exponential backoff (2s/4s/8s) at the agent
// loop layer, then the run stops with "Error: 429 Too Many Requests" and the
// session waits for the human. That is exactly backwards for rate limits:
// they need a LONG, FIXED cooldown (the provider says "retry shortly"), not a
// fast-growing one, and giving up after ~14s of a shared-pool limit was the
// daily symptom.
//
// COOLDOWN CLASS (extended 2026-08-31): gateway mid-stream SSE error injection
// joins rate limits in the cooldown class. OpenRouter-style gateways convert an
// upstream stream failure into prose — "JSON error injected into SSE stream" —
// that contains NO HTTP status, so it fell through every entry of pi-ai's
// RETRYABLE_PROVIDER_ERROR_PATTERN and turned a transient 502-class blip into
// a fatal, unretryable turn error (same failure class reported by Cline/n8n
// against OpenRouter). Two-part fix, both in this patch:
//   1. RETRYABLE_PROVIDER_ERROR_PATTERN gains "json error injected into sse
//      stream" + "stream_read_error" (targets below), so isRetryableAssistantError
//      returns true and the retry loops engage at all;
//   2. RATE_LIMIT_RE (the cooldown-class pattern) gains the same phrases, so
//      once retryable they get the SAME treatment as 429s: fixed 25s cooldown,
//      no maxRetries cap, 2-minute consecutive-loop budget, then pause with a
//      "send a message to retry" note instead of dying.
// UPSTREAM FINISH-REASON ERRORS (extended 2026-09-02): OpenRouter terminates
// a stream with finish_reason "error" when the UPSTREAM provider it routed to
// (Z.AI for z-ai/glm-5.3-flash) fails mid-generation. pi maps that to the
// errorMessage "Provider finish_reason: error" (openai-completions mapStopReason
// default branch), which matched NONE of the retryable patterns — so the turn
// died instantly and only a fresh prompt (new request → fresh upstream routing)
// recovered it. Fleet data: 37 occurrences 2026-08-27..2026-09-02, all
// openrouter/z-ai-glm-5.3-flash, 17 of them in a single hour (13:00–13:59 on
// 09-02) across ~8 parallel sessions. Fix: "finish_reason: error" joins
// RETRYABLE_PROVIDER_ERROR_PATTERN (both copies below), so the NORMAL retry
// budget applies to the outer agent loop and the inner retryAssistantCall.
// CLASS DECISION (2026-09-02) — normal exponential (2s/4s/8s, capped by
// maxRetries), NOT the cooldown class: the failure is upstream-side, a short
// retry burst does not hammer a shared pool, and the common case is a
// one-request blip that a 2s retry absorbs.
// PROMOTED TO COOLDOWN CLASS (2026-09-04, the documented follow-up): the
// capped budget did not hold in sustained incidents — sid 01a068 (09-03
// 18:37-19:46) logged 7 incidents in ~70min with 50s-3m20s gaps between the
// error and the next activity (the capped window is ~14s, so every longer
// blip halted the turn until a human nudge), and sessions "halt with it a
// lot" per the user. "finish_reason: error" now ALSO joins RATE_LIMIT_RE
// below: fixed 25s per retry, uncapped by maxRetries, 2min consecutive
// budget, then pause-with-note; the next user message gets fresh upstream
// routing. It stays in RETRYABLE_PROVIDER_ERROR_PATTERN — cooldown
// classification is only tested after retryability.
// PROVIDER UNAVAILABLE (2026-09-04): HTTP 503 / upstream_unavailable is the
// same sustained-outage class. A real background researcher exhausted the
// stock three-retry inner cap after useful work, then exited. 503/service-
// unavailable wording therefore joins the cooldown class; ordinary 500/502/
// 504 blips retain stock bounded exponential retries.
//
// ANCHOR RESILIENCE (2026-09-04): pi 0.85.0 renamed minified identifiers
// (_prepareRetry message→message2 + settings2→settings; classifier
// message→message2). The fixed-string anchors stopped matching,
// findBundleChunk() returned null, and targets() silently omitted every
// bundle target — verify-harness stayed green while the runtime `pi` path
// was stock. Two fixes: the chunk scan now matches structurally
// ("async _prepareRetry("), and the two renamed regions use structural
// regexes that CAPTURE the minified identifiers into the replacement instead
// of hardcoding them; targets() also fails loudly when the chunk cannot be
// located at all.
//
// EMPTY-RESPONSE CLASS (added 2026-09-03): a "successful" turn with NO
// actionable content is a provider-side anomaly, not a turn end. friendli's
// zai-org/GLM-5.3-flash streamed reasoning-only and fully empty responses that
// finished with finish_reason "stop" while billing 89–712 output tokens each;
// pi stored an empty assistant message, the agent loop saw no tool calls, and
// the run halted silently mid-task — 8 times in one session (01a067,
// 2026-09-03 12:35–12:50), each halt requiring a manual "go on", plus 2
// thinking-only stops with the same effect. isRetryableAssistantError()
// previously only recognized stopReason "error" + errorMessage, so a
// content-less "stop" turn was accepted as a legitimate turn end and the
// auto-continuation machinery (_prepareRetry -> agent.continue()) never ran.
// Fix: classify stop responses with no tool calls and no non-empty text as
// retryable provider errors (annotated with a diagnostic errorMessage and
// stopReason "error" so budget exhaustion is VISIBLE via auto_retry_end ->
// showError), then let the EXISTING retry loops drive continuation: the outer
// agent-loop _prepareRetry (normal maxRetries budget + exponential backoff;
// the bad assistant message is removed from agent state before continue()) and
// the inner retryAssistantCall for auxiliary calls. Legitimate classes keep
// their semantics: text-only final answers (has text), tool-call turns (has
// toolCalls), user cancellations ("aborted"), and "length" truncations are NOT
// classified; error-stop classification is unchanged.
//
// POLICY (user spec): on cooldown-class errors —
//   * cooldown is a FIXED 25s per retry (never exponential, never increased);
//   * retries are NOT capped by maxRetries;
//   * if the CONSECUTIVE cooldown loop has totaled more than 2 minutes
//     (25s x ~5 attempts), the retry loop stops and the run pauses — the
//     final error message carries a "paused" note, and the session stays
//     stopped until the user sends a new message (prompt() resets the clock).
// Non-cooldown transient errors (timeouts, network) keep the stock
// maxRetries/exponential behavior untouched.
//
// Files patched (15 targets in 3 files; all owned by this module):
//   1. bundle chunk  — _prepareRetry (outer agent auto-retry; THE runtime path)
//   2. bundle chunk  — retryAssistantCall (inner per-call retry, same chunk)
//   3. bundle chunk  — RETRYABLE_PROVIDER_ERROR_PATTERN (gateway SSE +
//      upstream finish-reason + empty-response phrases)
//   3b. bundle chunk — isRetryableAssistantError empty-response classification
//      (PI_EMPTY_RESPONSE_POLICY; same chunk as 1–3)
//   3c. bundle chunk — retry-counter reset guard (same chunk)
//   4. dist/core/agent-session.js — _prepareRetry + prompt() clock reset +
//      retry-counter reset guard (SDK path)
//   5. pi-ai/dist/utils/retry.js — retryAssistantCall (SDK path), the same
//      gateway + upstream finish-reason + empty-response phrases in
//      RETRYABLE_PROVIDER_ERROR_PATTERN, the moderation
//      fail-fast (deterministic content-moderation rejections must NOT be
//      blind-retried with an identical payload — 3 identical retries of a
//      deterministic rejection is pure waste; they fail fast so the agent can
//      modify the request or route elsewhere, while transient provider errors
//      keep the normal retry budget), AND the empty-response classification
//      in isRetryableAssistantError. All edits folded into this module because
//      they patch the SAME files — two mechanisms editing one file is how
//      drift happens.
// Behavioral tests: scripts/tests/test-empty-response-policy.mjs (classifier
// classes) and scripts/tests/e2e-empty-response-continuation.mjs (real
// AgentSession flows: transient recovery + bounded sustained failure).
//
// Sibling note: pressure-journal.mjs (removed 2026-09-01, folded into this module)'s former __piMarkPressure inserts in
// these regions were removed 2026-08-31 (provider-pressure dead-code cleanup).
// Fingerprints/replacements below never included those lines, so isApplied
// and apply() are unaffected either way.
//
//
// Idempotent: no-op when the PI_RATE_LIMIT_POLICY marker is present. Exits 0 on
// success/no-op, 1 on anchor mismatch (upstream refactor — patch needs updating).
// CLI: node retry-429-policy.mjs [--fix]   (default: report only)
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

const MARKER = "PI_RATE_LIMIT_POLICY";
const WINDOW_MS = 120_000; // consecutive cooldown-class loop budget
const COOLDOWN_MS = 25_000; // fixed cooldown per retry
/** A gap between consecutive cooldown-class failures longer than this starts a
 * NEW series (the old one was broken by successful work — it is no longer
 * "consecutive"), so a success followed much later by a fresh 429 gets a
 * fresh 2-minute budget instead of an instant stop. */
const SERIES_GAP_MS = 8 * 60_000;
/** Cooldown-class errors: rate limits, provider-unavailable 503s, and
 * gateway/upstream stream failures. The same literal is injected into the
 * bundle (minified) and SDK (readable) paths. */
const RATE_LIMIT_RE =
  "/\\b429\\b|\\b503\\b|rate.?limit|too many requests|service.?unavailable|temporar(?:ily)? unavailable|upstream_unavailable|json error injected into sse stream|stream_read_error|finish_reason: error/i";
/** Previous revisions, retained only for deterministic in-place upgrades. */
const RATE_LIMIT_RE_FINISH_REASON =
  "/\\b429\\b|rate.?limit|too many requests|json error injected into sse stream|stream_read_error|finish_reason: error/i";
const RATE_LIMIT_RE_PREV =
  "/\\b429\\b|rate.?limit|too many requests|json error injected into sse stream|stream_read_error/i";
const NOTE_NEW = "transient provider error persisted >2min";
/** Current bundle-outer patch comment — single source for the replacement.
 *  The first sentence enumerates every cooldown-class member. */
const BUNDLE_OUTER_NEW_COMMENT =
  "/*" +
  MARKER +
  " (local patch; re-applied by verify-harness.mjs): cooldown-class errors (rate limits + gateway mid-stream SSE injection + upstream finish_reason: error) cool off a FIXED 25s per retry (no exponential growth, no maxRetries cap) and keep retrying while the consecutive loop is <2min; beyond that the run pauses — the final error is annotated and prompt() resets the clock on the next user message. Other transient errors keep stock maxRetries/backoff. */";
function piCoreDir() {
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

/** Locate the bundle chunk by content — Vite rehashes chunk filenames per
 *  build, so a hash-name lookup breaks every update. The match is
 *  STRUCTURAL ("async _prepareRetry(" — the method definition, param-name
 *  agnostic) so minifier renames cannot silently empty the target set the
 *  way the 0.85.0 message→message2 rename did; a genuine upstream refactor
 *  surfaces as the loud missing-chunk failure in targets() instead. */
function findBundleChunk() {
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
      if (src.includes("async _prepareRetry(")) {
        return p;
      }
    }
  } catch {
    /* no chunks dir */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target 1: bundle chunk outer retry — STRUCTURAL regex target. The 0.85.0
// build renamed the minified identifiers this region uses (message→message2,
// settings2→settings); the old fixed-string anchor stopped matching and the
// target silently vanished (see ANCHOR RESILIENCE note at the top). The regex
// captures the current identifiers and templates them into the replacement,
// so future renames survive; a genuinely restructured _prepareRetry throws.
// ---------------------------------------------------------------------------

const BUNDLE_METHOD_HEAD = /async _prepareRetry\((\w+)\)\{/;
// PREAMBLE TOLERANCE (2026-09-07): the previous single combined regex
// (method head + settings logic adjacent) broke when an EARLIER alphabetical
// patch — autonomous-recovery.mjs — inserted its PI_AUTONOMOUS_RECOVERY_V2
// block between the method head and the retry settings logic. On a fresh
// node_modules the recovery preamble applied first, this anchor then never
// matched, verify --fix failed, and the 5-minute repair timer re-fired a
// failing verification (and a desktop notification) every cycle. The head and
// the patch region are therefore matched separately: the structural anchor is
// the settings→delayMs region within a bounded window after the method head,
// and the replacement preserves whatever preamble precedes it.
const BUNDLE_SETTINGS_PATTERN =
  /let (\w+)=this\.settingsManager\.getRetrySettings\(\);if\(!\1\.enabled\)return!1;if\(this\._retryAttempt\+\+,this\._retryAttempt>\1\.maxRetries\)return this\._retryAttempt--,!1;let delayMs=\1\.baseDelayMs\*2\*\*\(this\._retryAttempt-1\);/;
// ~0.9KB today; 8KB tolerates future preambles without letting the match
// escape the method (the settings pattern itself is unique to this method).
const BUNDLE_PREAMBLE_WINDOW = 8_000;

function buildBundleOuterReplacement(param, settingsVar) {
  return (
    `let ${settingsVar}=this.settingsManager.getRetrySettings();if(!${settingsVar}.enabled)return!1;` +
    BUNDLE_OUTER_NEW_COMMENT +
    "let rateLimited=" +
    RATE_LIMIT_RE +
    `.test(${param}.errorMessage||"");` +
    "if(!rateLimited)this._piRateLimitLoopStart=void 0;" +
    "else if(!this._piRateLimitLoopStart)this._piRateLimitLoopStart=Date.now();" +
    "else if(Date.now()-this._piRateLimitLoopStart>" +
    SERIES_GAP_MS +
    ")this._piRateLimitLoopStart=Date.now();" +
    "if(rateLimited&&Date.now()-this._piRateLimitLoopStart>" +
    WINDOW_MS +
    `){${param}.errorMessage=(${param}.errorMessage||"429 rate limit")+" — paused:` +
    NOTE_NEW +
    '; send a message to retry";this._piRateLimitLoopStart=void 0;return!1}' +
    `if(this._retryAttempt++,this._retryAttempt>${settingsVar}.maxRetries&&!rateLimited)return this._retryAttempt--,!1;` +
    "let delayMs=rateLimited?" +
    COOLDOWN_MS +
    `:${settingsVar}.baseDelayMs*2**(this._retryAttempt-1);`
  );
}

function makeBundleOuterTarget(chunk) {
  return {
    name: "bundle: agent-loop _prepareRetry",
    file: chunk,
    exists: () => fs.existsSync(chunk),
    isApplied: () => {
      try {
        const src = fs.readFileSync(chunk, "utf8");
        // Both halves required: the loop-start line is unique to THIS region
        // (the prompt()/inner-loop inserts don't contain it), and the regex
        // literal pins the CURRENT cooldown class so class revisions
        // (2026-09-04 finish_reason promotion) re-trigger apply().
        const start = src.indexOf("async _prepareRetry(");
        // Window covers the preamble + inserted policy (body slice is ~1.7KB
        // pre-patch, ~2.2KB post-patch; 4KB leaves margin for future ones).
        const region = start === -1 ? "" : src.slice(start, start + 4_000);
        return (
          region.includes(
            "else if(!this._piRateLimitLoopStart)this._piRateLimitLoopStart=Date.now()",
          ) && region.includes(RATE_LIMIT_RE)
        );
      } catch {
        return false;
      }
    },
    apply: () => {
      const src = fs.readFileSync(chunk, "utf8");
      const head = BUNDLE_METHOD_HEAD.exec(src);
      if (head) {
        const window = src.slice(
          head.index,
          head.index + BUNDLE_PREAMBLE_WINDOW,
        );
        const sm = BUNDLE_SETTINGS_PATTERN.exec(window);
        if (sm) {
          // Surgical replace of ONLY the settings→delayMs region: the method
          // head and any preamble inserted by earlier patches stay intact.
          const absStart = head.index + sm.index;
          fs.writeFileSync(
            chunk,
            src.slice(0, absStart) +
              buildBundleOuterReplacement(head[1], sm[1]) +
              src.slice(absStart + sm[0].length),
          );
          return;
        }
      }
      // In-place class promotion for already-patched files. Replace all
      // copies in the shared chunk (outer + inner); the inner target still
      // independently verifies its uncapped ordering below.
      let upgraded = src;
      for (const previous of [
        RATE_LIMIT_RE_PREV,
        RATE_LIMIT_RE_FINISH_REASON,
      ]) {
        upgraded = upgraded.replaceAll(
          previous + ".test(",
          RATE_LIMIT_RE + ".test(",
        );
      }
      if (upgraded !== src) {
        fs.writeFileSync(chunk, upgraded);
        return;
      }
      throw new Error(
        `structural anchor mismatch (async _prepareRetry) in ${chunk} — upstream refactor, patch needs updating`,
      );
    },
  };
}

const BUNDLE_INNER_HEAD_ANCHOR =
  "let maxAttempts=policy?.enabled?policy.maxRetries:0,attempt2=0,lastRetry;";
const BUNDLE_INNER_HEAD_REPLACEMENT =
  "let maxAttempts=policy?.enabled?policy.maxRetries:0,attempt2=0,lastRetry,rateLimitLoopStart=0;";

const BUNDLE_INNER_ANCHOR =
  'if(attempt2>=maxAttempts||!isRetryableAssistantError(response))return lastRetry&&await callbacks?.onRetryFinished?.(!1,lastRetry.attempt,response.errorMessage),response;attempt2++,lastRetry={attempt:attempt2,errorMessage:response.errorMessage||"Unknown error"};let delayMs=policy.baseDelayMs*2**(attempt2-1);';

const BUNDLE_INNER_RETURN =
  "return lastRetry&&await callbacks?.onRetryFinished?.(!1,lastRetry.attempt,response.errorMessage),response;";
const BUNDLE_INNER_PREV_POLICY_COMMENT =
  "/*" +
  MARKER +
  " (local patch): cooldown-class errors (rate limits + gateway mid-stream SSE injection) get a fixed 25s cooldown, 2min consecutive-loop budget, then give up with the final error — mirrors the agent-loop policy so auxiliary calls (summarization etc.) stop hammering the same shared pool. */";
const BUNDLE_INNER_POLICY_COMMENT =
  "/*" +
  MARKER +
  " (local patch): cooldown-class errors (rate limits + provider-unavailable 503s + gateway/upstream stream failures) get a fixed 25s cooldown, no maxRetries cap, and a 2min consecutive-loop budget — mirrors the agent-loop policy so auxiliary calls stop hammering the same shared pool. */";
const BUNDLE_INNER_CAPPED_CHECK =
  "if(attempt2>=maxAttempts||!isRetryableAssistantError(response))" +
  BUNDLE_INNER_RETURN +
  BUNDLE_INNER_PREV_POLICY_COMMENT +
  "let rateLimited=" +
  RATE_LIMIT_RE +
  '.test(response.errorMessage||"");';
const BUNDLE_INNER_UNCAPPED_CHECK_PREV =
  "if(!isRetryableAssistantError(response))" +
  BUNDLE_INNER_RETURN +
  BUNDLE_INNER_POLICY_COMMENT +
  "let rateLimited=" +
  RATE_LIMIT_RE +
  '.test(response.errorMessage||"");' +
  "if(attempt2>=maxAttempts&&!rateLimited)" +
  BUNDLE_INNER_RETURN;
const BUNDLE_INNER_UNCAPPED_CHECK =
  "if(policy?.enabled!==!0)" +
  BUNDLE_INNER_RETURN +
  BUNDLE_INNER_UNCAPPED_CHECK_PREV;
const BUNDLE_INNER_REPLACEMENT =
  BUNDLE_INNER_UNCAPPED_CHECK +
  "if(rateLimited){if(!rateLimitLoopStart)rateLimitLoopStart=Date.now();if(Date.now()-rateLimitLoopStart>" +
  WINDOW_MS +
  ")" +
  BUNDLE_INNER_RETURN +
  "}else rateLimitLoopStart=0;" +
  'attempt2++,lastRetry={attempt:attempt2,errorMessage:response.errorMessage||"Unknown error"};let delayMs=rateLimited?' +
  COOLDOWN_MS +
  ":policy.baseDelayMs*2**(attempt2-1);";

// Gateway SSE-injection + upstream finish-reason phrases + the empty-response
// note phrase into RETRYABLE_PROVIDER_ERROR_PATTERN — without them
// isRetryableAssistantError() returns false and NO loop ever retries.
// WHY "no actionable content" must be IN the pattern: the annotation is a
// two-step composition — agent-session classifies the run's last message
// TWICE (agent_end -> _willRetryAfterAgentEnd for the willRetry flag, then
// _handlePostAgentRun for the actual retry). The FIRST classification mutates
// the message to stopReason "error" + errorMessage (the note below); the
// SECOND classification sees stopReason "error" and falls through to the
// pattern test, which must then still return true. The note phrase is the
// bridge — keep it and the pattern entry in lockstep.
const BUNDLE_PATTERN_PREV = '"stream_read_error"])';
const BUNDLE_PATTERN_NEXT_TAIL = '"stream_read_error","finish_reason: error"])';
const BUNDLE_PATTERN_CURRENT_TAIL =
  '"stream_read_error","finish_reason: error"])';
/** 2026-09-03 revision tail (no actionable content), superseded 2026-09-06. */
const BUNDLE_PATTERN_0903_TAIL =
  '"stream_read_error","finish_reason: error","no actionable content"])';
/** 2026-09-06 revision tail (adds the codex WebSocket transport phrase). */
/** 2026-09-06 revision tail (codex WebSocket transport), superseded 2026-09-07. */
const BUNDLE_PATTERN_WEBSOCKET_TAIL =
  '"stream_read_error","finish_reason: error","no actionable content","WebSocket error"])';
const BUNDLE_PATTERN_LATEST_TAIL =
  '"stream_read_error","finish_reason: error","no actionable content","WebSocket error","h2 protocol error"])';

const BUNDLE_PATTERN_ANCHOR = '"ResourceExhausted"])';
const BUNDLE_PATTERN_REPLACEMENT =
  '"ResourceExhausted","json error injected into sse stream","stream_read_error","finish_reason: error","no actionable content","WebSocket error","h2 protocol error"])';

const BUNDLE_PROMPT_ANCHOR =
  "async prompt(text,options){let expandPromptTemplates=options?.expandPromptTemplates??!0";
const BUNDLE_PROMPT_REPLACEMENT =
  "async prompt(text,options){this._piRateLimitLoopStart=void 0;let expandPromptTemplates=options?.expandPromptTemplates??!0";

// ---------------------------------------------------------------------------
// Target 4: SDK dist/core/agent-session.js (readable source)
// ---------------------------------------------------------------------------

const SDK_OUTER_ANCHOR = [
  "        this._retryAttempt++;",
  "        if (this._retryAttempt > settings.maxRetries) {",
  "            // Preserve the completed attempt count so post-run handling can emit the final failure.",
  "            this._retryAttempt--;",
  "            return false;",
  "        }",
  "        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);",
].join("\n");

const SDK_OUTER_REPLACEMENT = [
  `        // ${MARKER} (local patch; re-applied by verify-harness.mjs): cooldown-class`,
  "        // errors (rate limits + gateway SSE injection + upstream",
  "        // finish_reason: error) cool off a",
  "        // FIXED 25s per retry (no exponential growth, no maxRetries cap) and",
  "        // keep retrying while the consecutive loop is <2min; beyond that the run",
  "        // pauses — the final error is annotated and prompt() resets the clock on",
  "        // the next user message.",
  `        const rateLimited = ${RATE_LIMIT_RE}.test(message.errorMessage || "");`,
  "        if (!rateLimited) {",
  "            this._piRateLimitLoopStart = undefined;",
  "        } else if (!this._piRateLimitLoopStart) {",
  "            this._piRateLimitLoopStart = Date.now();",
  "        } else if (Date.now() - this._piRateLimitLoopStart > 480000) {",
  "            // >8min since the last failure: the old series is dead, start fresh.",
  "            this._piRateLimitLoopStart = Date.now();",
  "        }",
  "        if (rateLimited && Date.now() - this._piRateLimitLoopStart > 120000) {",
  '            message.errorMessage = (message.errorMessage || "429 rate limit") +',
  `                " — paused: ${NOTE_NEW}; send a message to retry";`,
  "            this._piRateLimitLoopStart = undefined;",
  "            return false;",
  "        }",
  "        this._retryAttempt++;",
  "        if (this._retryAttempt > settings.maxRetries && !rateLimited) {",
  "            // Preserve the completed attempt count so post-run handling can emit the final failure.",
  "            this._retryAttempt--;",
  "            return false;",
  "        }",
  "        const delayMs = rateLimited",
  "            ? 25000",
  "            : settings.baseDelayMs * 2 ** (this._retryAttempt - 1);",
].join("\n");

const SDK_PROMPT_ANCHOR = [
  "    async prompt(text, options) {",
  "        const expandPromptTemplates = options?.exp",
].join("\n");

const SDK_PROMPT_REPLACEMENT = [
  "    async prompt(text, options) {",
  "        // " +
    MARKER +
    ": a new user message resets the consecutive-429 clock.",
  "        this._piRateLimitLoopStart = undefined;",
  "        const expandPromptTemplates = options?.exp",
].join("\n");

// ---------------------------------------------------------------------------
// Target 5: pi-ai dist/utils/retry.js (readable source; inner retry loop)
// ---------------------------------------------------------------------------

function piAiRetryPath() {
  return path.join(
    piCoreDir() || "",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "utils",
    "retry.js",
  );
}

const PIAI_HEAD_ANCHOR = [
  "    const maxAttempts = policy?.enabled ? policy.maxRetries : 0;",
  "    let attempt = 0;",
  "    let lastRetry;",
].join("\n");

const PIAI_HEAD_REPLACEMENT = [
  "    const maxAttempts = policy?.enabled ? policy.maxRetries : 0;",
  "    let attempt = 0;",
  "    let lastRetry;",
  "    let rateLimitLoopStart = 0;",
].join("\n");

const PIAI_ANCHOR = [
  "        // Non-retryable, or budget exhausted: return the final error message.",
  "        if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {",
  "            if (lastRetry)",
  "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
  "            return response;",
  "        }",
  "        attempt++;",
  '        lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };',
  "        const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);",
].join("\n");

const PIAI_CAPPED_CHECK = [
  "        // Non-retryable, or budget exhausted: return the final error message.",
  "        if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {",
  "            if (lastRetry)",
  "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
  "            return response;",
  "        }",
  `        // ${MARKER} (local patch): cooldown-class errors (rate limits + gateway`,
  "        // mid-stream SSE injection) get a FIXED 25s cooldown (no exponential",
  "        // growth) and keep retrying while this call has spent <2min in the",
  "        // consecutive loop; beyond that, give up with the final error so callers",
  "        // stop hammering the same shared pool.",
  `        const rateLimited = ${RATE_LIMIT_RE}.test(response.errorMessage || "");`,
].join("\n");

const PIAI_UNCAPPED_CHECK_PREV = [
  "        // Non-retryable errors return immediately.",
  "        if (!isRetryableAssistantError(response)) {",
  "            if (lastRetry)",
  "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
  "            return response;",
  "        }",
  `        // ${MARKER} (local patch): cooldown-class errors (rate limits +`,
  "        // provider-unavailable 503s + gateway/upstream stream failures) get a",
  "        // FIXED 25s cooldown and no maxRetries cap while this call has spent",
  "        // <2min in the consecutive loop; beyond that, give up with the final",
  "        // error so callers stop hammering the same shared pool.",
  `        const rateLimited = ${RATE_LIMIT_RE}.test(response.errorMessage || "");`,
  "        // The ordinary retry cap must be evaluated AFTER classification;",
  "        // otherwise the documented two-minute cooldown budget is unreachable.",
  "        if (attempt >= maxAttempts && !rateLimited) {",
  "            if (lastRetry)",
  "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
  "            return response;",
  "        }",
].join("\n");

const PIAI_UNCAPPED_CHECK = [
  "        // A disabled retry policy is authoritative for every error class.",
  "        if (policy?.enabled !== true) {",
  "            return response;",
  "        }",
  PIAI_UNCAPPED_CHECK_PREV,
].join("\n");

const PIAI_REPLACEMENT = [
  PIAI_UNCAPPED_CHECK,
  "        if (rateLimited) {",
  "            if (!rateLimitLoopStart) rateLimitLoopStart = Date.now();",
  "            if (Date.now() - rateLimitLoopStart > 120000) {",
  "                if (lastRetry)",
  "                    await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
  "                return response;",
  "            }",
  "        } else {",
  "            rateLimitLoopStart = 0;",
  "        }",
  "        attempt++;",
  '        lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };',
  "        const delayMs = rateLimited",
  "            ? 25000",
  "            : policy.baseDelayMs * 2 ** (attempt - 1);",
].join("\n");

// Gateway SSE + empty-response phrases into RETRYABLE_PROVIDER_ERROR_PATTERN (SDK copy).
// "no actionable content" bridges the empty-response annotation composition:
// agent-session classifies the run's last message twice (agent_end willRetry
// flag, then _handlePostAgentRun), and the first classification annotates the
// message to stopReason "error" + errorMessage (EMPTY_RESPONSE_NOTE) — the
// second classification must still match the retryable pattern. Keep the note
// (EMPTY_RESPONSE_NOTE) and this entry in lockstep.
const PIAI_PATTERN_ANCHOR = '    "ResourceExhausted",\n]);';
const PIAI_PATTERN_PREV_TAIL = '    "stream_read_error",\n]);';
const PIAI_PATTERN_CURRENT_TAIL = '    "finish_reason: error",\n]);';
/** 2026-09-03 revision tail (no actionable content), superseded 2026-09-06. */
const PIAI_PATTERN_0903_TAIL =
  '    "finish_reason: error",\n    "no actionable content",\n]);';
/** isApplied fingerprint for the SDK pattern target: the comment-rich
 *  PIAI_PATTERN_REPLACEMENT interleaves comments between entries, so an
 *  entry-adjacency tail (LATEST_TAIL) never appears verbatim in an applied
 *  file — anchor on the last entry + closing bracket instead. */
/** 2026-09-06 revision tail (codex WebSocket transport), superseded 2026-09-07. */
const PIAI_PATTERN_WEBSOCKET_TAIL = '    "WebSocket error",\n]);';
const PIAI_PATTERN_APPLIED_TAIL = '    "h2 protocol error",\n]);';
const PIAI_PATTERN_REPLACEMENT = [
  '    "ResourceExhausted",',
  "    // pi-harness local patch (re-applied by verify-harness.mjs): gateway",
  "    // mid-stream SSE error injection — OpenRouter-style 502 prose with no",
  "    // HTTP status in the text, so it previously fell through every pattern",
  "    // above and turned a transient upstream blip into a fatal turn error.",
  '    "json error injected into sse stream",',
  '    "stream_read_error",',
  "    // pi-harness local patch (2026-09-02): OpenRouter terminates a stream",
  '    // with finish_reason "error" when the routed-upstream provider fails',
  '    // mid-generation (pi\'s message: "Provider finish_reason: error") —',
  "    // transient, upstream-side (the next request re-routes); cooldown",
  "    // class since 2026-09-04 (see RATE_LIMIT_RE).",
  '    "finish_reason: error",',
  "    // pi-harness local patch (2026-09-03): the empty-response annotation note",
  '    // phrase (see Target 6+7) — the annotated message is stopReason "error" +',
  "    // this errorMessage, and the second classification (post-run retry) must",
  "    // still match this pattern for the retry to engage.",
  '    "no actionable content",',
  "    // pi-harness local patch (2026-09-06): codex WebSocket transport death —",
  '    // a dropped stream/connection surfaces as stopReason "error" with this',
  "    // message and zero billed output (observed 2026-09-06, openai-codex);",
  "    // transient, retried under the stock budget (not the cooldown class).",
  '    "WebSocket error",',
  "    // pi-harness local patch (2026-09-07): Node HTTP/2 transport reset —",
  '    // "h2 protocol error: error reading a body from connection" surfaces',
  "    // when the provider's HTTP/2 connection is reset mid-body (observed",
  "    // 2026-09-07, together/deepseek); transient, retried under the stock",
  "    // budget (not the cooldown class).",
  '    "h2 protocol error",',
  "]);",
].join("\n");

// ---------------------------------------------------------------------------
// Target 6+7: isRetryableAssistantError — empty-response classification
// (bundle chunk minified + pi-ai dist/utils/retry.js readable)
// ---------------------------------------------------------------------------

// A stop response with no tool call and no non-empty text is a provider anomaly
// (see EMPTY-RESPONSE CLASS above): annotate it as a first-class retryable error
// and let the existing retry loops auto-continue. The annotation (stopReason
// "error" + errorMessage) is what makes budget exhaustion visible: agent-session
// emits auto_retry_end(success:false) only for stopReason "error", and the TUI
// renders it with showError. Idempotent: `??=` never overwrites an existing
// diagnostic, and re-classification of an already-annotated message is stable.
const EMPTY_RESPONSE_FINGERPRINT = "PI_EMPTY_RESPONSE_POLICY";
const EMPTY_RESPONSE_NOTE =
  "Provider returned no actionable content (empty/thinking-only response)";
// Same 0.85.0 minifier-rename story as the outer target: the classifier's
// parameter is build-specific (message2 in 0.85.x), so capture it structurally
// and template it into the guard instead of hardcoding a name.
const BUNDLE_CLASSIFY_PATTERN =
  /function isRetryableAssistantError\((\w+)\)\{if\(\1\.stopReason!=="error"\|\|!\1\.errorMessage\)return!1;/;

function buildEmptyResponseGuardBundle(param) {
  return (
    `if(${param}.stopReason==="stop"&&!(Array.isArray(${param}.content)&&${param}.content.some(block=>block&&(block.type==="toolCall"||block.type==="text"&&typeof block.text==="string"&&block.text.trim().length>0))))` +
    `{${param}.stopReason="error";${param}.errorMessage??="` +
    EMPTY_RESPONSE_NOTE +
    '";return!0}'
  );
}

function makeBundleClassifyTarget(chunk) {
  return {
    name: "bundle: isRetryableAssistantError empty-response classification",
    file: chunk,
    exists: () => fs.existsSync(chunk),
    // Fingerprint on the marker comment so sibling edits inside this
    // function region cannot false-negative isApplied().
    isApplied: () => {
      try {
        return fs
          .readFileSync(chunk, "utf8")
          .includes(EMPTY_RESPONSE_FINGERPRINT);
      } catch {
        return false;
      }
    },
    apply: () => {
      const src = fs.readFileSync(chunk, "utf8");
      const m = src.match(BUNDLE_CLASSIFY_PATTERN);
      if (!m) {
        if (src.includes(EMPTY_RESPONSE_FINGERPRINT)) return; // already applied
        throw new Error(
          `structural anchor mismatch (isRetryableAssistantError) in ${chunk} — upstream refactor, patch needs updating`,
        );
      }
      fs.writeFileSync(
        chunk,
        src.replace(
          BUNDLE_CLASSIFY_PATTERN,
          `function isRetryableAssistantError(${m[1]}){/*` +
            EMPTY_RESPONSE_FINGERPRINT +
            " (local patch; re-applied by verify-harness.mjs): a stop response with no tool calls and no non-empty text is a provider anomaly (reasoning-only/empty stream that billed tokens and halted the run) — classify it as a retryable error so the existing retry loops auto-continue; user aborts and text/tool-call turns keep their semantics. */" +
            buildEmptyResponseGuardBundle(m[1]) +
            `if(${m[1]}.stopReason!=="error"||!${m[1]}.errorMessage)return!1;`,
        ),
      );
    },
  };
}
const SDK_CLASSIFY_ANCHOR = [
  "export function isRetryableAssistantError(message) {",
  '    if (message.stopReason !== "error" || !message.errorMessage)',
  "        return false;",
].join("\n");
const SDK_CLASSIFY_REPLACEMENT = [
  "export function isRetryableAssistantError(message) {",
  `    // ${EMPTY_RESPONSE_FINGERPRINT} (local patch; re-applied by verify-harness.mjs): a`,
  "    // stop response with no tool calls and no non-empty text is a provider",
  "    // anomaly (reasoning-only/empty stream that billed tokens and halted the run",
  "    // silently — friendli GLM-5.3-flash 2026-09-03). Annotate it as a first-class",
  "    // retryable error so the existing retry loops (outer _prepareRetry ->",
  "    // agent.continue(), inner retryAssistantCall) auto-continue under the normal",
  "    // maxRetries budget; on exhaustion the run ends with a visible error instead",
  "    // of a silent halt. Aborted, length, text-only, and tool-call turns keep",
  "    // their existing semantics.",
  "    if (",
  '        message.stopReason === "stop" &&',
  "        !(Array.isArray(message.content) &&",
  "            message.content.some((block) =>",
  "                block &&",
  '                (block.type === "toolCall" ||',
  '                    (block.type === "text" &&',
  '                        typeof block.text === "string" &&',
  "                        block.text.trim().length > 0)),",
  "            ))",
  "    ) {",
  '        message.stopReason = "error";',
  `        message.errorMessage ??= "${EMPTY_RESPONSE_NOTE}";`,
  "        return true;",
  "    }",
  '    if (message.stopReason !== "error" || !message.errorMessage)',
  "        return false;",
].join("\n");

// ---------------------------------------------------------------------------
// Target 8+9: retry-counter reset guard (bundle chunk + SDK agent-session)
// ---------------------------------------------------------------------------
// agent-session resets the retry counter on every non-error assistant message
// at message_end. A fresh empty response still carries stopReason "stop" at
// that point (the empty-response annotation happens at agent_end), so without
// this guard the reset fires after EVERY retry and the retry loop never
// terminates — an infinite 2s retry pump against a provider that keeps
// returning empty turns. The guard makes "retryable-bad" responses not count
// as successes: when a retry is in flight, the classifier runs at message_end
// and its annotation also lands EARLY (the reset guard is what annotates the
// retried turn), so budget exhaustion is reached after maxRetries attempts.
const SDK_RESET_ANCHOR = [
  "                // Reset retry counter immediately on successful assistant response",
  "                // This prevents accumulation across multiple LLM calls within a turn",
  '                if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {',
].join("\n");
const SDK_RESET_PREV_CONDITION =
  '                if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0 && !this._isRetryableError(assistantMsg)) {';
const SUCCESS_RESET_FINGERPRINT =
  "A successful response starts a fresh cooldown series.";
const SDK_RESET_REPLACEMENT = [
  "                // Reset retry counter immediately on successful assistant response",
  "                // This prevents accumulation across multiple LLM calls within a turn.",
  `                // ${EMPTY_RESPONSE_FINGERPRINT} (local patch; re-applied by verify-harness.mjs):`,
  "                // a retryable-bad response (no actionable content) must not count as a",
  "                // success here — it would reset the counter mid-sequence and turn the",
  "                // retry budget into an infinite pump. The classifier call also annotates",
  "                // the message at the earliest lifecycle point.",
  SDK_RESET_PREV_CONDITION,
  `                    // ${SUCCESS_RESET_FINGERPRINT}`,
  "                    this._piRateLimitLoopStart = undefined;",
].join("\n");
const SDK_RESET_UPGRADE = [
  SDK_RESET_PREV_CONDITION,
  `                    // ${SUCCESS_RESET_FINGERPRINT}`,
  "                    this._piRateLimitLoopStart = undefined;",
].join("\n");
const BUNDLE_RESET_ANCHOR =
  'assistantMsg.stopReason!=="error"&&this._retryAttempt>0&&(this._emit({type:"auto_retry_end",success:!0,attempt:this._retryAttempt}),this._retryAttempt=0)';
const BUNDLE_RESET_PREV_REPLACEMENT =
  'assistantMsg.stopReason!=="error"&&this._retryAttempt>0&&!this._isRetryableError(assistantMsg)&&(this._emit({type:"auto_retry_end",success:!0,attempt:this._retryAttempt}),this._retryAttempt=0)';
const BUNDLE_RESET_REPLACEMENT =
  'assistantMsg.stopReason!=="error"&&this._retryAttempt>0&&!this._isRetryableError(assistantMsg)&&(this._piRateLimitLoopStart=void 0,this._emit({type:"auto_retry_end",success:!0,attempt:this._retryAttempt}),this._retryAttempt=0)';

// ---------------------------------------------------------------------------
// Moderation fail-fast on pi-ai dist/utils/retry.js (folded from
// verify-harness.mjs inline section [2]; one atomic apply, self-verifying)
// ---------------------------------------------------------------------------

const MOD_MARKER = "DETERMINISTIC_REJECTION_PATTERN";
const MOD_PATTERN_LEGACY = "/data_inspection_failed|inappropriate content|content inspection|content filter|content moderation/i";
// Invalid request bodies are deterministic even when a router wraps them in
// "Provider returned error" (which the stock classifier treats as transient).
// Do not classify all HTTP 400s: overloaded/transport failures can use that code.
const MOD_PATTERN = "/data_inspection_failed|inappropriate content|content inspection|content filter|content moderation|invalid[ _-](?:request|parameters?|arguments?)|unsupported[ _-]parameter|unrecognized request argument/i";
// Old v1 in-list patch (extra literals appended to RETRYABLE_PROVIDER_ERROR_PATTERN);
// stripped if present so the v2 pattern is the single source of truth.
const MOD_V1_INLINE =
  /, "data_inspection_failed", "inappropriate content", "content\.\?inspection", "content\.\?filter", "content\.\?moderation" \/\* pi-harness local patch[^*]*\*\//g;
const MOD_DECL_ANCHOR = "]);\nclass RetrySleepAbortError";
const MOD_DECL_REPLACEMENT =
  "]);\n" +
  "// pi-harness local patch v2 (re-applied by verify-harness.mjs): deterministic\n" +
  "// content-moderation rejections must NOT be blind-retried with an identical\n" +
  "// payload (3 identical retries of a deterministic rejection is pure waste).\n" +
  "// They fail fast so the agent can modify the request or route elsewhere;\n" +
  "// transient provider errors keep the normal retry budget.\n" +
  `const DETERMINISTIC_REJECTION_PATTERN = ${MOD_PATTERN};\n` +
  "class RetrySleepAbortError";
const MOD_CHECK_ANCHOR =
  "    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;";
const MOD_CHECK_REPLACEMENT =
  MOD_CHECK_ANCHOR +
  "\n    if (DETERMINISTIC_REJECTION_PATTERN.test(errorMessage))\n        return false; /* pi-harness local patch v2 */";

/** Bundle-mirrored moderation fail-fast: the SDK target above patches
 *  pi-ai/dist/utils/retry.js, but the RUNTIME path is the minified bundle
 *  chunk (same isRetryableAssistantError + NON_RETRYABLE pattern). Without
 *  this target the CLI keeps blind-retrying deterministic moderation
 *  rejections (25s cooldown-class or stock budget) while the SDK fails
 *  fast — SDK/CLI parity gap found in the 2026-09-06 robustness audit. */
const BUNDLE_MOD_DECL_ANCHOR =
  'NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN=buildProviderErrorPattern(["GoUsageLimitError","FreeUsageLimitError","Monthly usage limit reached","available balance","insufficient_quota","out of budget","quota exceeded","billing"]),';
const BUNDLE_MOD_DECL_REPLACEMENT =
  BUNDLE_MOD_DECL_ANCHOR +
  `DETERMINISTIC_REJECTION_PATTERN=${MOD_PATTERN},`;
const BUNDLE_MOD_CHECK_ANCHOR =
  "return NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage2)?!1:RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage2)";
const BUNDLE_MOD_CHECK_REPLACEMENT =
  "if(DETERMINISTIC_REJECTION_PATTERN.test(errorMessage2))return!1;/*PI_DETERMINISTIC_REJECTION_BUNDLE (local patch; re-applied by verify-harness.mjs): deterministic content-moderation rejections fail fast in the runtime path too — identical-payload retries are pure waste.*/" +
  BUNDLE_MOD_CHECK_ANCHOR;

/** Upgrade only the known declaration; unknown/partial layouts fail before a write.
 * Shared by SDK and CLI targets so fingerprint changes cannot silently skip
 * the new fail-fast behavior on installations carrying the previous patch. */
export function transformDeterministicRejections(source, bundled = false) {
  const declaration = bundled ? `DETERMINISTIC_REJECTION_PATTERN=${MOD_PATTERN},` : `const DETERMINISTIC_REJECTION_PATTERN = ${MOD_PATTERN};`;
  const legacy = bundled ? `DETERMINISTIC_REJECTION_PATTERN=${MOD_PATTERN_LEGACY},` : `const DETERMINISTIC_REJECTION_PATTERN = ${MOD_PATTERN_LEGACY};`;
  const check = bundled ? "if(DETERMINISTIC_REJECTION_PATTERN.test(errorMessage2))return!1;" : "if (DETERMINISTIC_REJECTION_PATTERN.test(errorMessage))\n        return false;";
  let result = source.replace(MOD_V1_INLINE, "");
  if (result.includes(MOD_MARKER)) {
    const existing = result.includes(declaration) ? declaration : legacy;
    if (result.split(existing).length !== 2 || result.split(check).length !== 2 || result.includes(declaration) && result.includes(legacy))
      throw new Error("deterministic rejection patch drift: declaration/check missing or duplicated");
    return result.replace(existing, declaration);
  }
  const declarationAnchor = bundled ? BUNDLE_MOD_DECL_ANCHOR : MOD_DECL_ANCHOR;
  const checkAnchor = bundled ? BUNDLE_MOD_CHECK_ANCHOR : MOD_CHECK_ANCHOR;
  if (result.split(declarationAnchor).length !== 2 || result.split(checkAnchor).length !== 2)
    throw new Error("deterministic rejection patch anchor missing or ambiguous");
  result = result.replace(declarationAnchor, bundled ? BUNDLE_MOD_DECL_REPLACEMENT : MOD_DECL_REPLACEMENT)
    .replace(checkAnchor, bundled ? BUNDLE_MOD_CHECK_REPLACEMENT : MOD_CHECK_REPLACEMENT);
  return result;
}

function makeDeterministicTarget(file, bundled) {
  return {
    name: bundled ? "bundle: pi-ai moderation fail-fast (runtime parity)" : "sdk: pi-ai moderation fail-fast",
    file,
    exists: () => fs.existsSync(file),
    isApplied: () => {
      try {
        const source = fs.readFileSync(file, "utf8");
        return transformDeterministicRejections(source, bundled) === source;
      } catch { return false; }
    },
    apply: () => {
      const source = fs.readFileSync(file, "utf8");
      const result = transformDeterministicRejections(source, bundled);
      if (result !== source) {
        if (!bundled) fs.copyFileSync(file, file + ".bak-harness");
        fs.writeFileSync(file, result);
      }
    },
  };
}
const makeModerationTarget = file => makeDeterministicTarget(file, false);
const makeBundleModerationTarget = file => makeDeterministicTarget(file, true);

// ---------------------------------------------------------------------------
// Target table
// ---------------------------------------------------------------------------

function makeStaticTarget(name, file, anchor, replacement, notes) {
  // Optional `upgrades`: [{from,to}, ...] — in-place revision bumps for files
  // that already carry a PREVIOUS revision of this patch (stock anchor long
  // gone). Each swap is skipped when `to` is already present (idempotent
  // re-entry) and required to match `from` otherwise, so a partially swapped
  // file fails loudly instead of silently drifting. Upgrades swap MINIMAL
  // substrings (one regex literal, one note string) chosen to sit clear of
  // sibling patches' insert points (see pressure-journal coupling above).
  // Optional `fingerprint`: a stable substring of `replacement` used for the
  // isApplied check instead of the whole replacement text. Needed when a
  // sibling patch injects extra lines into our replacement region (full-string
  // match would falsely report MISSING) — or, as with the bundle inner loop,
  // when the natural fingerprint is ambiguous with another region.
  const upgrades = notes && notes.upgrades ? notes.upgrades : null;
  const legacyUpgrade = notes && notes.upgrade ? notes.upgrade : null;
  const fingerprint = notes && notes.fingerprint ? notes.fingerprint : null;
  return {
    name,
    file,
    notes,
    exists: () => fs.existsSync(file),
    isApplied: () => {
      try {
        const src = fs.readFileSync(file, "utf8");
        return fingerprint
          ? src.includes(fingerprint)
          : src.includes(replacement);
      } catch {
        return false;
      }
    },
    apply: () => {
      let src = fs.readFileSync(file, "utf8");
      if (src.includes(fingerprint || replacement)) return;
      if (src.includes(anchor)) {
        if (src.split(anchor).length !== 2)
          throw new Error(`ambiguous patch anchor in ${file}`);
        fs.writeFileSync(file, src.replace(anchor, replacement));
        return;
      }
      if (legacyUpgrade && src.includes(legacyUpgrade.from)) {
        fs.writeFileSync(
          file,
          src.replace(legacyUpgrade.from, legacyUpgrade.to),
        );
        return;
      }
      if (upgrades) {
        let changed = false;
        for (const u of upgrades) {
          if (src.includes(u.to)) continue; // already swapped
          if (!src.includes(u.from)) {
            // Optional stages model alternate old revisions in a chain. At
            // least one later required structural upgrade still has to match,
            // so unknown layouts continue to fail loudly.
            if (u.optional) continue;
            throw new Error(
              `upgrade anchor mismatch in ${file} — expected previous-revision text not found: ${JSON.stringify(u.from.slice(0, 80))}`,
            );
          }
          src = src.replace(u.from, u.to);
          changed = true;
        }
        if (changed) {
          fs.writeFileSync(file, src);
          return;
        }
      }
      throw new Error(
        `anchor mismatch in ${file} — upstream refactor, patch needs updating`,
      );
    },
  };
}

// Exported for consumers that must quote the policy (reminders.ts contextual
// prose, the empty-response classifier test): the patch is the single
// authority — prose and test regexes are derived from these, never restated.
export { COOLDOWN_MS, WINDOW_MS, SERIES_GAP_MS, RATE_LIMIT_RE };

// Keep lifecycle prediction aligned with the existing cooldown policy. No new
// inference loop or provider/model switch is introduced here.
export function transformRetryLifecycle(
  source,
  bundled = false,
  remove = false,
) {
  const prediction = bundled
    ? /_willRetryAfterAgentEnd\((\w+)\)\s*\{[\s\S]*?(?=_findLastAssistantMessage\()/
    : / {4}_willRetryAfterAgentEnd\((\w+)\) \{[\s\S]*?\n {4}\}/;
  const found = source.match(prediction);
  if (!found) throw new Error("retry lifecycle: prediction anchor missing");
  const event = found[1];
  const replacement = `_willRetryAfterAgentEnd(${event}) {
        /* PI_RETRY_LIFECYCLE_V1 */
        const settings = this.settingsManager.getRetrySettings();
        if (!settings.enabled) return false;
        for (let i = ${event}.messages.length - 1; i >= 0; i--) {
            const message = ${event}.messages[i];
            if (message.role !== "assistant") continue;
            if (!this._isRetryableError(message)) return false;
            if (!${RATE_LIMIT_RE}.test(message.errorMessage || ""))
                return this._retryAttempt < settings.maxRetries;
            const started = this._piRateLimitLoopStart;
            const elapsed = Date.now() - started;
            return !started || elapsed <= ${WINDOW_MS} || elapsed > ${SERIES_GAP_MS};
        }
        return false;
    }`;
  const nextPrediction = (bundled ? "" : "    ") + replacement;
  const begin = source.indexOf("async _prepareRetry(");
  const end = source.indexOf("abortRetry()", begin);
  if (begin < 0 || end < 0)
    throw new Error("retry lifecycle: retry body missing");
  let body = source.slice(begin, end);
  const parameter = body.match(/async _prepareRetry\((\w+)\)/)?.[1];
  if (!parameter || !body.includes(RATE_LIMIT_RE))
    throw new Error("retry lifecycle: cooldown policy missing");
  const entry = (status, reason) =>
    `this.sessionManager.appendCustomEntry("harness-retry", {status: "${status}", reason: "${reason}", provider: ${parameter}.provider, model: ${parameter}.model, attempt: this._retryAttempt});`;
  const edits = bundled
    ? [
        [
          'this._emit({type:"auto_retry_start",',
          'this._retryAbortController=new AbortController;try{/* PI_RETRY_CONTROLLER_READY */this._emit({type:"auto_retry_start",',
        ],
        [
          ",this._retryAbortController=new AbortController;try{await ",
          ";await ",
        ],
        [
          `${parameter}.errorMessage=(${parameter}.errorMessage||"429 rate limit")`,
          `/* PI_RETRY_PAUSE_RECORDED */${entry("paused", "cooldown-window-exhausted")}${parameter}.errorMessage=(${parameter}.errorMessage||"429 rate limit")`,
        ],
        [
          "catch{let attempt",
          `catch{/* PI_RETRY_CANCEL_RECORDED */${entry("cancelled", "retry-cancelled")}let attempt`,
        ],
      ]
    : [
        [
          '        this._emit({\n            type: "auto_retry_start",',
          '        this._retryAbortController = new AbortController();\n        try { /* PI_RETRY_CONTROLLER_READY */\n        this._emit({\n            type: "auto_retry_start",',
        ],
        [
          "        this._retryAbortController = new AbortController();\n        try {\n            await sleep",
          "            await sleep",
        ],
        [
          `            ${parameter}.errorMessage = (${parameter}.errorMessage || "429 rate limit")`,
          `            /* PI_RETRY_PAUSE_RECORDED */ ${entry("paused", "cooldown-window-exhausted")}\n            ${parameter}.errorMessage = (${parameter}.errorMessage || "429 rate limit")`,
        ],
        [
          "            // Aborted during sleep - emit end event so UI can clean up",
          `            /* PI_RETRY_CANCEL_RECORDED */ ${entry("cancelled", "retry-cancelled")}\n            // Aborted during sleep - emit end event so UI can clean up`,
        ],
      ];
  const count = (text, match) => text.split(match).length - 1;
  if (source.includes("PI_RETRY_LIFECYCLE_V1")) {
    if (
      found[0] !== nextPrediction ||
      edits.some(([, next]) => count(body, next) !== 1)
    )
      throw new Error("retry lifecycle: partial patch or postcondition drift");
    if (remove) {
      // Reversible fixture/rollback path; reconstruct the pre-fix semantics,
      // not an arbitrary historical minifier's whitespace or local names.
      for (const [oldText, newText] of [...edits].reverse())
        body = body.replace(newText, oldText);
      const originalPrediction = `${bundled ? "" : "    "}_willRetryAfterAgentEnd(${event}) {
        const settings = this.settingsManager.getRetrySettings();
        if (!settings.enabled || this._retryAttempt >= settings.maxRetries) return false;
        for (let i = ${event}.messages.length - 1; i >= 0; i--) {
            const message = ${event}.messages[i];
            if (message.role === "assistant") return this._isRetryableError(message);
        }
        return false;
    }`;
      return (source.slice(0, begin) + body + source.slice(end)).replace(
        found[0],
        originalPrediction,
      );
    }
    return source;
  }
  if (
    !found[0].includes("this._retryAttempt") ||
    !found[0].includes("maxRetries")
  )
    throw new Error("retry lifecycle: prediction semantics changed upstream");
  for (const [oldText] of edits)
    if (count(body, oldText) !== 1)
      throw new Error(`retry lifecycle: anchor drift: ${oldText.slice(0, 90)}`);
  for (const [oldText, newText] of edits) body = body.replace(oldText, newText);
  const result = (source.slice(0, begin) + body + source.slice(end)).replace(
    found[0],
    nextPrediction,
  );
  if (transformRetryLifecycle(result, bundled) !== result)
    throw new Error("retry lifecycle: postcondition failed");
  return result;
}

function makeRetryLifecycleTarget(file, bundled) {
  return {
    name: `${bundled ? "bundle" : "sdk"}: retry lifecycle prediction, cancellation and durable outcome`,
    file,
    exists: () => fs.existsSync(file),
    isApplied() {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes("PI_RETRY_LIFECYCLE_V1") &&
        transformRetryLifecycle(source, bundled) === source
      );
    },
    apply() {
      const source = fs.readFileSync(file, "utf8");
      const result = transformRetryLifecycle(source, bundled);
      if (source !== result) fs.writeFileSync(file, result);
    },
  };
}

export function targets() {
  const core = piCoreDir();
  const chunk = findBundleChunk();
  const retryPath = piAiRetryPath();
  const sdkSession = core
    ? path.join(core, "dist", "core", "agent-session.js")
    : null;
  const out = [];
  if (core && !chunk) {
    // Fail loudly: the bundle chunk is the RUNTIME path of the `pi` binary.
    // The 0.85.0 anchor drift silently emptied this target set while
    // verify-harness stayed green — precisely the silent-omission failure
    // this guard exists to prevent.
    throw new Error(
      "retry-429-policy: bundle chunk not found (pi bundle layout changed — update findBundleChunk / structural anchors)",
    );
  }
  if (chunk) {
    out.push(
      makeBundleOuterTarget(chunk),
      makeStaticTarget(
        "bundle: classify empty auxiliary response before success",
        chunk,
        "let response=await produce();",
        'let response=await produce();/* PI_AUX_EMPTY_RESPONSE */if(policy?.enabled===!0&&response.stopReason==="stop")isRetryableAssistantError(response);',
      ),
      makeStaticTarget(
        "bundle: retryAssistantCall inner loop",
        chunk,
        BUNDLE_INNER_ANCHOR,
        BUNDLE_INNER_REPLACEMENT,
        {
          // WHY this fingerprint and not the old "let delayMs=rateLimited?25000:":
          // that string ALSO matches the outer _prepareRetry region
          // (identical prefix, only the fallback differs), so since the
          // 0.84.4 restore isApplied() returned true while the inner body
          // was still stock — the cooldown policy was silently absent.
          // The response.errorMessage regex tail is inner-only AND pins the
          // current cooldown class, so class revisions (2026-09-04
          // finish_reason promotion) re-trigger apply() and the swap below.
          fingerprint: BUNDLE_INNER_UNCAPPED_CHECK,
          // The outer target runs first and promotes every regex copy in the
          // shared chunk. This target owns only the inner cap ordering.
          upgrades: [
            {
              from: BUNDLE_INNER_CAPPED_CHECK,
              to: BUNDLE_INNER_UNCAPPED_CHECK_PREV,
            },
            {
              from: BUNDLE_INNER_UNCAPPED_CHECK_PREV,
              to: BUNDLE_INNER_UNCAPPED_CHECK,
            },
          ],
        },
      ),
      makeStaticTarget(
        "bundle: retryAssistantCall loop-start var",
        chunk,
        BUNDLE_INNER_HEAD_ANCHOR,
        BUNDLE_INNER_HEAD_REPLACEMENT,
      ),
      makeStaticTarget(
        "bundle: retryable-pattern gateway SSE + upstream finish-reason + empty-response phrases",
        chunk,
        BUNDLE_PATTERN_ANCHOR,
        BUNDLE_PATTERN_REPLACEMENT,
        {
          // Fingerprint anchored on the LATEST tail so each revision bump
          // re-triggers apply() and the upgrades[] swap below runs.
          fingerprint: BUNDLE_PATTERN_LATEST_TAIL,
          upgrades: [
            // Files carrying the 2026-08-31 revision (gateway SSE phrases
            // only) get the finish-reason entry appended in place. Optional:
            // files already past this revision no longer contain the anchor.
            {
              from: BUNDLE_PATTERN_PREV,
              to: BUNDLE_PATTERN_NEXT_TAIL,
              optional: true,
            },
            // Files carrying the 2026-09-02 revision (gateway + finish-reason)
            // get the empty-response note phrase appended in place. Optional
            // for the same reason (09-03+ files no longer contain it).
            {
              from: BUNDLE_PATTERN_CURRENT_TAIL,
              to: BUNDLE_PATTERN_0903_TAIL,
              optional: true,
            },
            // Files carrying the 2026-09-03 revision get the codex WebSocket
            // transport phrase appended (2026-09-06). Required: every upgraded
            // file must reach this revision or the layout is unknown.
            {
              from: BUNDLE_PATTERN_0903_TAIL,
              to: BUNDLE_PATTERN_WEBSOCKET_TAIL,
            },
            {
              from: BUNDLE_PATTERN_WEBSOCKET_TAIL,
              to: BUNDLE_PATTERN_LATEST_TAIL,
            },
          ],
        },
      ),
      makeStaticTarget(
        "bundle: prompt() clock reset",
        chunk,
        BUNDLE_PROMPT_ANCHOR,
        BUNDLE_PROMPT_REPLACEMENT,
      ),
      makeStaticTarget(
        "bundle: agent-session retry-counter + cooldown-clock reset guard",
        chunk,
        BUNDLE_RESET_ANCHOR,
        BUNDLE_RESET_REPLACEMENT,
        {
          fingerprint:
            "!this._isRetryableError(assistantMsg)&&(this._piRateLimitLoopStart=void 0",
          upgrades: [
            {
              from: BUNDLE_RESET_PREV_REPLACEMENT,
              to: BUNDLE_RESET_REPLACEMENT,
            },
          ],
        },
      ),
      makeBundleClassifyTarget(chunk),
      makeBundleModerationTarget(chunk),
    );
  }
  if (sdkSession && fs.existsSync(sdkSession)) {
    out.push(
      makeStaticTarget(
        "sdk: agent-session _prepareRetry",
        sdkSession,
        SDK_OUTER_ANCHOR,
        SDK_OUTER_REPLACEMENT,
        {
          // Fingerprint (not full-replacement match): keeps isApplied true
          // even if a future sibling inserts into this region; anchored on
          // the installed cooldown regex so CLASS revisions (2026-09-04
          // finish_reason promotion) flip isApplied and re-trigger the
          // in-place upgrade below.
          fingerprint: `${RATE_LIMIT_RE}.test(message.errorMessage || "")`,
          upgrades: [
            {
              from: `        const rateLimited = ${RATE_LIMIT_RE_PREV}.test(message.errorMessage || "");`,
              to: `        const rateLimited = ${RATE_LIMIT_RE_FINISH_REASON}.test(message.errorMessage || "");`,
            },
            {
              from: `        const rateLimited = ${RATE_LIMIT_RE_FINISH_REASON}.test(message.errorMessage || "");`,
              to: `        const rateLimited = ${RATE_LIMIT_RE}.test(message.errorMessage || "");`,
            },
          ],
        },
      ),
      makeStaticTarget(
        "sdk: agent-session prompt() clock reset",
        sdkSession,
        SDK_PROMPT_ANCHOR,
        SDK_PROMPT_REPLACEMENT,
      ),
      makeStaticTarget(
        "sdk: agent-session retry-counter + cooldown-clock reset guard",
        sdkSession,
        SDK_RESET_ANCHOR,
        SDK_RESET_REPLACEMENT,
        {
          fingerprint: SUCCESS_RESET_FINGERPRINT,
          upgrades: [
            {
              from: SDK_RESET_PREV_CONDITION,
              to: SDK_RESET_UPGRADE,
            },
          ],
        },
      ),
    );
  }
  if (retryPath && fs.existsSync(retryPath)) {
    out.push(
      makeModerationTarget(retryPath),
      makeStaticTarget(
        "sdk: classify empty auxiliary response before success",
        retryPath,
        "        const response = await produce();",
        '        const response = await produce();\n        /* PI_AUX_EMPTY_RESPONSE */\n        if (policy?.enabled === true && response.stopReason === "stop") isRetryableAssistantError(response);',
      ),
      makeStaticTarget(
        "sdk: pi-ai isRetryableAssistantError empty-response classification",
        retryPath,
        SDK_CLASSIFY_ANCHOR,
        SDK_CLASSIFY_REPLACEMENT,
        {
          // Fingerprint on the marker comment so sibling edits inside this
          // function region cannot false-negative isApplied().
          fingerprint: EMPTY_RESPONSE_FINGERPRINT,
        },
      ),
      makeStaticTarget(
        "sdk: pi-ai retryable-pattern gateway SSE + upstream finish-reason + empty-response phrases",
        retryPath,
        PIAI_PATTERN_ANCHOR,
        PIAI_PATTERN_REPLACEMENT,
        {
          // Fingerprint anchored on the APPLIED tail (see PIAI_PATTERN_APPLIED_TAIL)
          // so revision bumps re-trigger apply() and the upgrades[] swaps run.
          fingerprint: PIAI_PATTERN_APPLIED_TAIL,
          upgrades: [
            // Files carrying only the 2026-08-31 gateway phrases get the
            // finish-reason entry appended before the closing bracket.
            // Optional: files already past this revision no longer match.
            {
              from: PIAI_PATTERN_PREV_TAIL,
              to: PIAI_PATTERN_CURRENT_TAIL,
              optional: true,
            },
            // Files carrying the 2026-09-02 revision (gateway +
            // finish-reason) get the empty-response note phrase appended.
            // Optional: 09-03+ files no longer contain the anchor.
            {
              from: PIAI_PATTERN_CURRENT_TAIL,
              to: PIAI_PATTERN_0903_TAIL,
              optional: true,
            },
            // Files carrying the 2026-09-03 revision get the codex WebSocket
            // transport phrase appended (2026-09-06). Required: every upgraded
            // file must reach this revision or the layout is unknown. Anchored
            // on the APPLIED tail form — the comment-rich replacement never
            // contains entry-adjacent tails verbatim in applied files.
            {
              from: '    "no actionable content",\n]);',
              to:
                '    "no actionable content",\n' +
                "    // pi-harness local patch (2026-09-06): codex WebSocket transport death —\n" +
                '    // a dropped stream/connection surfaces as stopReason "error" with this\n' +
                "    // message and zero billed output (observed 2026-09-06, openai-codex);\n" +
                "    // transient, retried under the stock budget (not the cooldown class).\n" +
                '    "WebSocket error",\n]);',
            },
            {
              from: PIAI_PATTERN_WEBSOCKET_TAIL,
              to:
                '    "WebSocket error",\n' +
                "    // pi-harness local patch (2026-09-07): Node HTTP/2 transport reset —\n" +
                '    // "h2 protocol error: error reading a body from connection" surfaces\n' +
                "    // when the provider's HTTP/2 connection is reset mid-body (observed\n" +
                "    // 2026-09-07, together/deepseek); transient, retried under the stock\n" +
                "    // budget (not the cooldown class).\n" +
                '    "h2 protocol error",\n]);',
            },
          ],
        },
      ),
      makeStaticTarget(
        "sdk: pi-ai retryAssistantCall loop-start var",
        retryPath,
        PIAI_HEAD_ANCHOR,
        PIAI_HEAD_REPLACEMENT,
      ),
      makeStaticTarget(
        "sdk: pi-ai retryAssistantCall inner loop",
        retryPath,
        PIAI_ANCHOR,
        PIAI_REPLACEMENT,
        {
          // Fingerprint includes the installed cooldown regex so class
          // revisions (2026-09-04 finish_reason promotion) flip isApplied
          // and trigger the swap below.
          fingerprint: PIAI_UNCAPPED_CHECK,
          upgrades: [
            {
              from: `        const rateLimited = ${RATE_LIMIT_RE_PREV}.test(response.errorMessage || "");`,
              to: `        const rateLimited = ${RATE_LIMIT_RE_FINISH_REASON}.test(response.errorMessage || "");`,
              optional: true,
            },
            {
              from: `        const rateLimited = ${RATE_LIMIT_RE_FINISH_REASON}.test(response.errorMessage || "");`,
              to: `        const rateLimited = ${RATE_LIMIT_RE}.test(response.errorMessage || "");`,
              optional: true,
            },
            {
              from: PIAI_CAPPED_CHECK,
              to: PIAI_UNCAPPED_CHECK_PREV,
            },
            {
              from: PIAI_UNCAPPED_CHECK_PREV,
              to: PIAI_UNCAPPED_CHECK,
            },
          ],
        },
      ),
    );
  }
  if (
    !sdkSession ||
    !fs.existsSync(sdkSession) ||
    !retryPath ||
    !fs.existsSync(retryPath)
  ) {
    throw new Error(
      "retry-429-policy: required SDK session/retry target missing",
    );
  }
  out.push(
    makeRetryLifecycleTarget(sdkSession, false),
    makeRetryLifecycleTarget(chunk, true),
  );
  return out;
}

// ---------------------------------------------------------------------------
// CLI (only when run directly — verify-harness imports targets() and must not
// be killed by our process.exit)
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("retry-429-policy.mjs")) {
  const FIX = process.argv.includes("--fix");
  let failures = 0;
  let allTargets;
  try {
    allTargets = targets();
  } catch (e) {
    console.log(`  ✗ targets(): ${e.message}`);
    process.exit(1);
  }
  for (const t of allTargets) {
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
