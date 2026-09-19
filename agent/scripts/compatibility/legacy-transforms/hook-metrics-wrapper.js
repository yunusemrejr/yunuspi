function instrumentHook(handler, hook, extensionPath) {
 // Count decision/check boundaries, not every streamed token, UI notification,
 // lifecycle observer or the telemetry observer itself. Keep this list aligned
 // with session-metrics.ts so pre-V2 history is interpreted by the same contract.
 if (
  ![
   "input",
   "before_agent_start",
   "context",
   "before_provider_request",
   "tool_call",
   "tool_result",
   "session_before_switch",
   "session_before_fork",
   "session_before_compact",
   "session_before_tree",
  ].includes(hook)
 )
  return handler;
 const parts = String(extensionPath).replace(/\\/g, "/").split("/");
 let owner = parts.at(-1);
 if (owner === "index.ts" || owner === "index.js") {
  parts.pop();
  while (["dist", "build", "lib", "src"].includes(parts.at(-1))) parts.pop();
  owner = parts.at(-1) || "unknown";
 }
 if (owner === "health-log.ts" || owner === "session-telemetry.ts")
  return handler;
 const size = (value) => {
  let total = 0,
   nodes = 0;
  const stack = [value],
   seen = new Set();
  while (stack.length) {
   const x = stack.pop();
   if (++nodes > 100000) return undefined;
   if (typeof x === "string") total += x.length;
   else if (x && typeof x === "object" && !seen.has(x)) {
    seen.add(x);
    const values = Array.isArray(x) ? x : Object.values(x);
    if (values.length + stack.length + nodes > 100000) return undefined;
    for (const v of values) stack.push(v);
   }
  }
  return total;
 };
 // Safe diagnostic fingerprints only: fixed-size hashes of a bounded prefix,
 // never payload text. Lets exports retain before/after prefix hashes, changed
 // position, semantic hash and revision while redacting sensitive content.
 const fnv = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
 };
 const fingerprint = (value) => {
  try {
   const json = JSON.stringify(value);
   if (typeof json !== "string") return undefined;
   const prefix = json.slice(0, 2000);
   const semantic = json.replace(/\s+/g, " ").slice(0, 2000);
   return { beforeHash: fnv(prefix), semanticHash: fnv(semantic), prefixLen: prefix.length };
  } catch { return undefined; }
 };
 const changedAt = (a, b) => {
  try {
   const sa = JSON.stringify(a), sb = JSON.stringify(b);
   if (typeof sa !== "string" || typeof sb !== "string") return undefined;
   const n = Math.min(sa.length, sb.length, 20000);
   for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return i;
   return sa.length === sb.length ? -1 : n;
  } catch { return undefined; }
 };
 return async function (...args) {
  const sink = globalThis[Symbol.for("yunus-pi.metrics.v1")];
  if (typeof sink !== "function") return handler.apply(this, args);
  const started = performance.now(),
   event = args[0];
  // Stable per-dispatch event id. The runner creates ONE ctx per dispatch and
  // passes it to every handler, so ctx identity is a true dispatch handle; a
  // WeakMap on a globalThis Symbol survives /reload and keeps loader + bundle
  // copies in agreement. toolCallId wins where present (stable across
  // processes), which is what makes 2x/3x execution detectable later.
  let eventId, seq;
  try {
   const reg =
    globalThis[Symbol.for("yunus-pi.dispatch.v1")] ||
    (globalThis[Symbol.for("yunus-pi.dispatch.v1")] = {
     seq: 0,
     ctxs: new WeakMap(),
    });
   const key =
    args[1] && typeof args[1] === "object"
     ? args[1]
     : event && typeof event === "object"
       ? event
       : reg;
   let cursor = reg.ctxs.get(key);
   if (cursor === undefined) {
    cursor = { id: ++reg.seq, n: 0 };
    reg.ctxs.set(key, cursor);
   }
   seq = ++cursor.n;
   const toolCallId = event?.toolCallId;
   eventId =
    typeof toolCallId === "string" && toolCallId ? toolCallId : "#" + cursor.id;
  } catch {}
  const input =
   hook === "context"
    ? event?.messages
    : hook === "before_provider_request"
      ? event?.payload
      : undefined;
  let before, beforePrint;
  try {
   if (input !== undefined) { before = size(input); beforePrint = fingerprint(input); }
  } catch {}
  let result,
   error = false;
  try {
   result = await handler.apply(this, args);
   return result;
  } catch (e) {
   error = true;
   throw e;
  } finally {
   try {
    const output = hook === "context" ? (result?.messages ?? input) : (result ?? input);
    const after = before === undefined ? undefined : size(output);
    const afterPrint = before === undefined ? undefined : fingerprint(output);
    const pos = before !== undefined ? changedAt(input, output) : undefined;
    const charsChanged = before !== undefined && after !== undefined ? Math.abs(after - before) : 0;
    sink("hook", {
     owner,
     hook,
     eventId,
     seq,
     revision: seq,
     ms: performance.now() - started,
     at: Date.now(),
     error,
     changed: result !== undefined,
     blocked: result?.block === true,
     removedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, before - after)
       : 0,
     addedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, after - before)
       : 0,
     charsChanged,
     tokensChanged: Math.round(charsChanged / 4),
     changedAt: Number.isSafeInteger(pos) ? pos : undefined,
     beforeHash: beforePrint?.beforeHash,
     afterHash: afterPrint?.beforeHash,
     semanticHash: afterPrint?.semanticHash,
    });
   } catch {}
  }
 };
}
