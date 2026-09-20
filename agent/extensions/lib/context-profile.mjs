/**
 * Pure prefix-probing helpers for the context_profile tool.
 *
 * Records keep hashes, roles, custom types, tool names and character counts
 * only. Prompt text and tool output text never enter the state file, so a
 * profile can be shared as evidence without leaking session content.
 *
 * Cost note: hashing is per message with a WeakMap identity cache. Unchanged
 * message objects (the common case for a stable prefix) are not re-serialized.
 */
import { createHash } from "node:crypto";

export const PROFILE_VERSION = 2;
export const DEFAULT_RING = 30;
// Prefix comparison covers the most recent messages. A bounded window keeps the
// per-request state serialization cheap while still attributing recent breaks;
// `digestsCapped` marks records whose stored history was truncated.
export const MAX_DIGESTS = 1200;

const hashCache = new WeakMap();

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function hashValue(value) {
  try {
    return sha256(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === "object" && typeof part.text === "string"
          ? part.text
          : part === undefined
            ? ""
            : JSON.stringify(part ?? null),
      )
      .join("");
  return content == null ? "" : JSON.stringify(content);
}

export function describeMessage(message) {
  const role = typeof message?.role === "string" ? message.role : "unknown";
  const customType =
    typeof message?.customType === "string" && message.customType
      ? message.customType
      : undefined;
  const toolName =
    typeof message?.toolName === "string" && message.toolName
      ? message.toolName
      : undefined;
  const chars =
    contentText(message?.content).length +
    contentText(message?.summary).length;
  let hash;
  if (message && typeof message === "object") {
    const cached = hashCache.get(message);
    if (cached !== undefined) hash = cached;
  }
  if (hash === undefined) hash = hashValue(message) ?? "[unhashable]";
  if (message && typeof message === "object") hashCache.set(message, hash);
  return {
    role,
    ...(customType ? { customType } : {}),
    ...(toolName ? { toolName } : {}),
    chars,
    hash,
  };
}

/**
 * Extract the message-like array from the provider payload seen by
 * `before_provider_request`. That payload is the source of truth for cache
 * prefix diagnostics: the context hook can contain display-only or otherwise
 * filtered entries that never reach the provider.
 */
export function payloadMessages(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["messages", "input", "contents"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

export function selectProbeMessages(wireMessages, pendingMessages) {
  return wireMessages ?? pendingMessages ?? [];
}

export function compareMessages(previous, current) {
  const max = Math.max(previous.length, current.length);
  let lcpIndex = 0;
  while (lcpIndex < max) {
    const a = previous[lcpIndex];
    const b = current[lcpIndex];
    if (!a || !b || a.hash !== b.hash) break;
    lcpIndex++;
  }
  const changed = lcpIndex < current.length ? current[lcpIndex] : undefined;
  const removed = !changed && lcpIndex < previous.length;
  // Appending to the tail is cache-friendly: the cached prefix still matches.
  const appendedOnly =
    !removed && lcpIndex === previous.length && current.length > previous.length;
  return {
    lcpIndex,
    lcpRatio: current.length
      ? Number((lcpIndex / current.length).toFixed(4))
      : 1,
    appendedOnly: appendedOnly ? true : undefined,
    digestsCapped: current.length > MAX_DIGESTS ? true : undefined,
    firstChange: changed
      ? {
          index: lcpIndex,
          role: changed.role,
          ...(changed.customType ? { customType: changed.customType } : {}),
          ...(changed.toolName ? { toolName: changed.toolName } : {}),
        }
      : removed
        ? {
            index: lcpIndex,
            role: previous[lcpIndex]?.role ?? "unknown",
            removed: true,
            ...(previous[lcpIndex]?.customType
              ? { customType: previous[lcpIndex].customType }
              : {}),
            ...(previous[lcpIndex]?.toolName
              ? { toolName: previous[lcpIndex].toolName }
              : {}),
          }
        : null,
  };
}

/** Incremental chain hash over digest hashes: the value identifies exactly the
 * message prefix it covers, cheaply (small fixed-size inputs). */
export function chainHash(digests, upto = digests.length) {
  let chain = sha256("context-profile/v2");
  const end = Math.max(0, Math.min(upto, digests.length));
  for (let i = 0; i < end; i++) chain = sha256(chain + digests[i].hash);
  return sha256(chain);
}

export function buildRecord({
  seq,
  at,
  msSincePrev,
  messages,
  previousDigests,
  baseline = false,
  envelopeChanges = null,
}) {
  const digests = messages.map(describeMessage);
  const comparison = compareMessages(previousDigests ?? [], digests);
  const resentChars = digests
    .slice(comparison.lcpIndex)
    .reduce((sum, digest) => sum + digest.chars, 0);
  return {
    record: {
      v: PROFILE_VERSION,
      seq,
      at,
      msSincePrev:
        Number.isFinite(msSincePrev) && msSincePrev >= 0
          ? Math.round(msSincePrev)
          : null,
      messages: digests.length,
      chars: digests.reduce((sum, digest) => sum + digest.chars, 0),
      lcpIndex: comparison.lcpIndex,
      lcpRatio: comparison.lcpRatio,
      ...(baseline ? { baseline: true } : {}),
      ...(comparison.appendedOnly ? { appendedOnly: true } : {}),
      ...(comparison.digestsCapped ? { digestsCapped: true } : {}),
      firstChange: comparison.firstChange,
      // A changed system prompt or tool list invalidates the entire prompt even
      // when the message tail was appended cleanly, so it is its own signal.
      ...(envelopeChanges
        ? { envelopeChanges: envelopeChanges.slice(0, 3), envelopeChanged: true }
        : {}),
      prefixHash: chainHash(digests, comparison.lcpIndex),
      fullHash: chainHash(digests),
      resentChars,
      resentTokens: Math.ceil(resentChars / 4),
    },
    digests: digests.slice(-MAX_DIGESTS),
  };
}

/** Provider-visible envelope: everything in the request that precedes the
 * messages. A change here invalidates the whole conversation, not just the
 * changed part, so system-prompt and tool-list churn must be attributed
 * separately from message digests — the message-only probe cannot see it. */
export function payloadEnvelope(payload) {
  if (!payload || typeof payload !== "object") return null;
  let systemValue = payload.system ?? payload.systemPrompt;
  if (systemValue === undefined) systemValue = payload.instructions;
  if (systemValue === undefined) systemValue = payload.systemInstruction;
  if (systemValue === undefined) systemValue = payload.system_instruction;
  let system = null;
  if (systemValue !== undefined && systemValue !== null) {
    const encoded =
      typeof systemValue === "string" ? systemValue : JSON.stringify(systemValue);
    system = typeof encoded === "string" ? encoded : String(systemValue);
  }
  const tools = Array.isArray(payload.tools)
    ? payload.tools
    : Array.isArray(payload.functions)
      ? payload.functions
      : null;
  const scalars = {};
  for (const key of [
    "model",
    "tool_choice",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "stream",
  ])
    if (payload[key] !== undefined) scalars[key] = payload[key];
  return {
    system:
      system === null ? null : { chars: system.length, hash: sha256(system) },
    tools:
      tools === null
        ? null
        : {
            count: tools.length,
            hash: sha256(
              tools
                .map((tool) => `${toolName(tool)}:${hashValue(tool)}`)
                .join("|"),
            ),
          },
    scalars: { hash: sha256(JSON.stringify(scalars)), keys: Object.keys(scalars) },
  };
}

function toolName(tool) {
  return String(tool?.name ?? tool?.function?.name ?? "?");
}

/** Which tools appeared, disappeared or changed schema. Bounded: this explains
 * an invalidation, it is not a schema dump. */
export function toolsDiff(previousTools, currentTools, cap = 6) {
  const before = new Map(
    (Array.isArray(previousTools) ? previousTools : []).map((t) => [
      toolName(t),
      hashValue(t),
    ]),
  );
  const after = new Map(
    (Array.isArray(currentTools) ? currentTools : []).map((t) => [
      toolName(t),
      hashValue(t),
    ]),
  );
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, hash] of after) {
    if (!before.has(name)) added.push(name);
    else if (before.get(name) !== hash) changed.push(name);
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);
  return {
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    changed: changed.slice(0, cap),
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
  };
}

/** First-changed envelope component(s) between two recorded requests. */
export function compareEnvelope(
  previous,
  current,
  previousTools,
  currentTools,
) {
  if (!previous || !current) return null;
  const changes = [];
  if (previous.system?.hash !== current.system?.hash)
    changes.push({
      component: "systemPrompt",
      previousChars: previous.system?.chars ?? 0,
      currentChars: current.system?.chars ?? 0,
    });
  if (previous.tools?.hash !== current.tools?.hash)
    changes.push({
      component: "tools",
      previousCount: previous.tools?.count ?? 0,
      currentCount: current.tools?.count ?? 0,
      ...toolsDiff(previousTools, currentTools),
    });
  if (previous.scalars?.hash !== current.scalars?.hash)
    changes.push({
      component: "request-fields",
      keys: current.scalars?.keys ?? [],
    });
  return changes.length ? changes : null;
}

export function appendRecord(records, record, cap = DEFAULT_RING) {
  const bounded = Math.max(1, Math.floor(cap));
  const next = [...records, record];
  if (next.length <= bounded) return next;
  // Evict oldest append-only records first: true prefix breaks are the
  // diagnostic signal, and a 30-ring otherwise loses a monster invalidation
  // within minutes in a busy session. Break-saturated rings keep recency.
  const overflow = next.length - bounded;
  const keep = [];
  let dropped = 0;
  for (const entry of next) {
    if (dropped < overflow && entry.appendedOnly && !entry.envelopeChanged) {
      dropped++;
      continue;
    }
    keep.push(entry);
  }
  return keep.slice(-bounded);
}

export function changeKey(change) {
  if (!change) return "unknown";
  if (change.customType) return `custom:${change.customType}`;
  if (change.toolName) return `tool:${change.toolName}`;
  if (change.removed) return "history-truncated";
  return change.role ?? "unknown";
}

/** True when a recorded request can invalidate the provider's cached prefix. */
export function isPrefixBreak(record) {
  if (!record || record.baseline) return false;
  if (record.appendedOnly && !record.envelopeChanged) return false;
  return Boolean(record.firstChange || record.envelopeChanged);
}

export function prefixSummary(records) {
  const list = Array.isArray(records) ? records : [];
  const offenders = new Map();
  let breaks = 0;
  let resentChars = 0;
  let envelopeBreaks = 0;
  for (const record of list) {
    if (!record) continue;
    resentChars += record.resentChars ?? 0;
    // The first recorded request is a baseline, and a pure tail append keeps
    // the cached prefix intact — neither is a prefix break. A changed system
    // prompt or tool list breaks the prefix even when the tail only appended.
    if (!isPrefixBreak(record)) continue;
    breaks++;
    if (record.envelopeChanged) envelopeBreaks++;
    const key = record.envelopeChanged
      ? `envelope:${(record.envelopeChanges ?? []).map((change) => change.component).join("+")}`
      : changeKey(record.firstChange);
    const row = offenders.get(key) ?? { key, breaks: 0, resentChars: 0 };
    row.breaks++;
    row.resentChars += record.resentChars ?? 0;
    offenders.set(key, row);
  }
  return {
    requests: list.length,
    breaks,
    stable: list.length - breaks,
    envelopeBreaks,
    resentChars,
    offenders: [...offenders.values()]
      .sort((a, b) => b.resentChars - a.resentChars)
      .slice(0, 8),
  };
}

export function compositionFromBranch(entries) {
  const rows = new Map();
  const bump = (key, chars) => {
    const row = rows.get(key) ?? { key, count: 0, chars: 0 };
    row.count++;
    row.chars += chars;
    rows.set(key, row);
  };
  for (const entry of entries ?? []) {
    const type = typeof entry?.type === "string" ? entry.type : "unknown";
    if (type === "message" && entry.message) {
      const digest = describeMessage(entry.message);
      bump(
        digest.customType
          ? `custom:${digest.customType}`
          : digest.toolName
            ? `tool:${digest.toolName}`
            : digest.role,
        digest.chars,
      );
    } else if (type === "custom") {
      bump(
        `custom:${entry.customType ?? "custom"}`,
        contentText(entry.content).length + contentText(entry.data).length,
      );
    } else {
      bump(type, contentText(entry?.summary ?? entry?.content).length);
    }
  }
  return [...rows.values()].sort((a, b) => b.chars - a.chars);
}
