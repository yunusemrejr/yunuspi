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

export const PROFILE_VERSION = 1;
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
  let chain = sha256("context-profile/v1");
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
      prefixHash: chainHash(digests, comparison.lcpIndex),
      fullHash: chainHash(digests),
      resentChars,
      resentTokens: Math.ceil(resentChars / 4),
    },
    digests: digests.slice(-MAX_DIGESTS),
  };
}

export function appendRecord(records, record, cap = DEFAULT_RING) {
  const bounded = Math.max(1, Math.floor(cap));
  return [...records.slice(-(bounded - 1)), record];
}

export function changeKey(change) {
  if (!change) return "unknown";
  if (change.customType) return `custom:${change.customType}`;
  if (change.toolName) return `tool:${change.toolName}`;
  if (change.removed) return "history-truncated";
  return change.role ?? "unknown";
}

export function prefixSummary(records) {
  const list = Array.isArray(records) ? records : [];
  const offenders = new Map();
  let breaks = 0;
  let resentChars = 0;
  for (const record of list) {
    if (!record) continue;
    resentChars += record.resentChars ?? 0;
    // The first recorded request is a baseline, and a pure tail append keeps
    // the cached prefix intact — neither is a prefix break.
    if (!record.firstChange || record.baseline || record.appendedOnly) continue;
    breaks++;
    const key = changeKey(record.firstChange);
    const row = offenders.get(key) ?? { key, breaks: 0, resentChars: 0 };
    row.breaks++;
    row.resentChars += record.resentChars ?? 0;
    offenders.set(key, row);
  }
  return {
    requests: list.length,
    breaks,
    stable: list.length - breaks,
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
