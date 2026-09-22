/*
 * Bounded, read-only history for automatic change-scope deliberation.
 *
 * The Pi session JSONL is the source of truth.  This module does not create a
 * transcript index or a second history store: it reads a small, validated
 * window, follows the active entry chain in each persisted session, and adds
 * the caller's in-memory branch.  Returned text is evidence only.  In
 * particular, role is retained so a later deliberator can distinguish a user
 * preference from an assistant's provisional choice.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const SCOPE_HISTORY_LIMITS = Object.freeze({
  maxFiles: 64,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxLinesPerFile: 12_000,
  maxDirectoryEntries: 4_096,
  maxDirectories: 128,
  maxHeaderBytes: 64 * 1024,
  maxMessageChars: 4_096,
  maxOutputChars: 6_000,
  maxCurrentBranchEntries: 12_000,
});

const TEXT_ROLES = new Set(["user", "assistant"]);
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "being", "between", "change",
  "changes", "could", "create", "current", "does", "each", "from",
  "have", "into", "make", "need", "only", "please", "project", "remove",
  "should", "that", "their", "there", "these", "this", "those", "update",
  "want", "with", "would", "your", "you", "implement", "improve", "fix",
  "adjust", "add", "edit", "modify", "redesign", "rework", "refactor",
  "replace", "review", "task", "work", "use", "using", "keep", "preserve",
]);

const SECRET_PATTERNS = [
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|private[_ -]?key|session[_ -]?token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/iu,
  /\b(?:sk-|pk_live_|pk_test_|rk_live_|rk_test_|ghp_|github_pat_|glpat[-_])[A-Za-z0-9_-]{12,}\b/iu,
  /-----BEGIN [^-\r\n]{0,80}PRIVATE KEY-----/iu,
  /https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/iu,
  /(?:^|[?&\s])(?:token|signature|sig|key|secret|password|passwd|api[_-]?key|access[_-]?token)=([^\s&#]+)/iu,
];

function checkAborted(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    throw signal.reason ?? Object.assign(new Error("Scope history collection aborted"), { name: "AbortError" });
  }
}

async function yieldToEventLoop(signal) {
  checkAborted(signal);
  await new Promise((resolve) => setImmediate(resolve));
  checkAborted(signal);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStat(a, b) {
  return Boolean(
    a &&
      b &&
      Number(a.dev) === Number(b.dev) &&
      Number(a.ino) === Number(b.ino) &&
      Number(a.size) === Number(b.size) &&
      Number(a.mtimeMs) === Number(b.mtimeMs) &&
      Number(a.ctimeMs) === Number(b.ctimeMs),
  );
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeId(value, fallback) {
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    return value;
  }
  return `entry-${hash(fallback).slice(0, 24)}`;
}

function parseAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function entryTime(entry) {
  const messageTime = parseAt(entry?.message?.timestamp);
  if (messageTime !== undefined) return messageTime;
  return parseAt(entry?.timestamp) ?? 0;
}

function normalizeText(value) {
  return String(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
}

function containsSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";
  // Deliberately inspect only text parts.  Thinking, tool calls, tool results,
  // images and provider-specific metadata never enter the returned evidence.
  return normalizeText(
    content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n"),
  );
}

function promptTerms(prompt) {
  if (typeof prompt !== "string") return [];
  const terms = prompt
    .slice(0, 32_768)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(terms.filter((term) => !STOP_WORDS.has(term)))].slice(0, 32);
}

function relevance(text, terms) {
  if (terms.length === 0) return 0;
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const words = new Set(lower.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  let score = 0;
  for (const term of terms) {
    if (words.has(term)) score += 3;
    else if (lower.includes(term)) score += 1;
  }
  return score;
}

function recordFromEntry(entry, source, sequence, state) {
  if (!isObject(entry) || entry.type !== "message") return undefined;
  const message = entry.message;
  if (!isObject(message) || !TEXT_ROLES.has(message.role)) return undefined;
  const text = messageText(message);
  if (!text) return undefined;
  if (text.length > SCOPE_HISTORY_LIMITS.maxMessageChars) {
    state.longMessages++;
    state.incomplete = true;
    noteOmission(source, entry, sequence, "oversize message", state);
    return undefined;
  }
  if (containsSecret(text)) {
    state.secretMessages++;
    state.incomplete = true;
    noteOmission(source, entry, sequence, "credential-like message", state);
    return undefined;
  }
  return {
    id: safeId(entry.id, `${source}\0${sequence}\0${text}`),
    role: message.role,
    text,
    at: entryTime(entry),
    source,
    _sequence: sequence,
    _current: source === "current-branch",
  };
}

function noteOmission(source, entry, sequence, reason, state) {
  const omissions = state.omittedBySource.get(source) ?? [];
  if (omissions.length < 256) omissions.push({ sequence, at: entryTime(entry), reason });
  state.omittedBySource.set(source, omissions);
  state.historyGap = true;
}

function newerOmission(record, state) {
  return (state.omittedBySource.get(record.source) ?? []).some((omission) => (
    omission.sequence > record._sequence || omission.at > record.at
  ));
}

const CORRECTION_CUE = /^(?:actually|no[,! ]|wait[,! ]|instead\b|but\b|keep\b|preserve\b|retain\b|leave\b|don't\b|do not\b|correction\b|on second thought\b|scratch that\b)/iu;
const UI_SCOPE_CUE = /\b(?:ui|interface|design|visual|layout|typograph(?:y|ic)|font|palette|color|brand|hero|spacing|animation|motion|mascot|character|experience|polish|refine|redesign|rework|revamp|overhaul|distracting|clunky|cheap|unprofessional)\b/iu;
const UI_PREFERENCE_CUE = /\b(?:prefer(?:s|red)?|preference|keep|preserve|maintain|retain|use|avoid|don't|do not|leave|stay|consistent|brand|style|typograph(?:y|ic)|font|palette|color|layout|spacing|motion|animation|mascot|character|visual|design|interface|ui)\b/iu;

function isUiScopePrompt(prompt) {
  return typeof prompt === "string" && UI_SCOPE_CUE.test(prompt);
}

function isUiPreference(text, prompt) {
  return isUiScopePrompt(prompt) && UI_PREFERENCE_CUE.test(text) && UI_SCOPE_CUE.test(text);
}

function isAdjacentCorrection(record, anchors) {
  if (record.role !== "user" || !CORRECTION_CUE.test(record.text)) return false;
  return anchors.some((anchor) => anchor.source === record.source && anchor._sequence < record._sequence && record._sequence - anchor._sequence <= 8);
}

function activeChain(entries, state) {
  const byId = new Map();
  for (const entry of entries) {
    if (isObject(entry) && typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
  }
  let leaf;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isObject(entry) && entry.type !== "session" && typeof entry.id === "string" && entry.id) {
      leaf = entry;
      break;
    }
  }
  if (!leaf) return [];
  const chain = [];
  const seen = new Set();
  let current = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    if (current.parentId === null || current.parentId === undefined || current.parentId === "") break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      // A line/byte cap can remove an ancestor.  The available suffix is still
      // the newest observed chain, but the missing prefix must stay unknown.
      state.brokenChains++;
      state.incomplete = true;
      break;
    }
    current = parent;
  }
  if (current && seen.has(current.id) && current.parentId && byId.has(current.parentId)) {
    state.brokenChains++;
    state.incomplete = true;
  }
  return chain.reverse();
}

function parseHeader(buffer) {
  const newline = buffer.indexOf(0x0a);
  const first = buffer
    .subarray(0, newline < 0 ? buffer.length : newline)
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .replace(/\r$/u, "")
    .trim();
  if (!first) return undefined;
  try {
    const value = JSON.parse(first);
    if (!isObject(value) || value.type !== "session") return undefined;
    if (typeof value.id !== "string" || !value.id || typeof value.cwd !== "string" || !value.cwd) return undefined;
    return {
      id: value.id,
      cwd: value.cwd,
      parentSession: typeof value.parentSession === "string" && value.parentSession ? value.parentSession : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readBounded(file, maxBytes, signal, { tail = false } = {}) {
  checkAborted(signal);
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) return { ok: false, reason: "not-file" };
    const chunks = [];
    let total = 0;
    const offset = tail ? Math.max(0, Number(before.size) - maxBytes) : 0;
    let position = offset;
    while (total < maxBytes && position < Number(before.size)) {
      checkAborted(signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total));
      const result = await handle.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
      position += result.bytesRead;
      if (result.bytesRead < chunk.length) break;
      await yieldToEventLoop(signal);
    }
    const after = await handle.stat();
    if (!sameStat(before, after)) return { ok: false, reason: "changed" };
    const truncated = offset > 0 || Number(after.size) > maxBytes;
    return { ok: true, buffer: Buffer.concat(chunks, total), truncated, offset, size: Number(before.size) || 0, stat: after };
  } catch (error) {
    checkAborted(signal);
    return { ok: false, reason: error?.code === "ELOOP" ? "symlink" : "read" };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function canonicalPath(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return await fs.realpath(path.resolve(value));
  } catch {
    return undefined;
  }
}

async function resolveSessionsDir(value, state) {
  if (typeof value !== "string" || !value.trim()) {
    state.incomplete = true;
    state.directoryIssue = "sessions directory unavailable";
    return undefined;
  }
  const candidate = path.resolve(value);
  let info;
  try {
    info = await fs.lstat(candidate);
  } catch (error) {
    state.incomplete = true;
    state.directoryIssue = error?.code === "ENOENT" ? "sessions directory missing" : "sessions directory unreadable";
    return undefined;
  }
  if (info.isSymbolicLink()) {
    state.incomplete = true;
    state.symlinks++;
    state.directoryIssue = "sessions directory symlink skipped";
    return undefined;
  }
  if (!info.isDirectory()) {
    state.incomplete = true;
    state.directoryIssue = "sessions path is not a directory";
    return undefined;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    state.incomplete = true;
    state.directoryIssue = "sessions directory unreadable";
    return undefined;
  }
}

async function inspectCandidate(file, projectCwd, state, signal) {
  checkAborted(signal);
  let info;
  try {
    info = await fs.lstat(file);
  } catch {
    state.readFailures++;
    state.incomplete = true;
    return undefined;
  }
  if (info.isSymbolicLink()) {
    state.symlinks++;
    state.incomplete = true;
    return undefined;
  }
  if (!info.isFile() || !file.toLowerCase().endsWith(".jsonl")) return undefined;
  state.candidateFiles++;
  const oversize = Number(info.size) > SCOPE_HISTORY_LIMITS.maxFileBytes;
  if (oversize) {
    // Large Pi sessions commonly contain tool bodies.  Read only a bounded
    // tail after independently validating this prefix/header; the omitted
    // prefix remains explicitly unknown to the caller.
    state.oversizeFiles++;
    state.incomplete = true;
  }
  const prefix = await readBounded(file, SCOPE_HISTORY_LIMITS.maxHeaderBytes, signal);
  if (!prefix.ok) {
    if (prefix.reason === "symlink") state.symlinks++;
    else state.headerFailures++;
    state.incomplete = true;
    return undefined;
  }
  const header = parseHeader(prefix.buffer);
  if (!header) {
    state.invalidHeaders++;
    state.incomplete = true;
    return undefined;
  }
  if (header.parentSession) {
    // Forked/child transcripts are useful for their owner, but they are not
    // independent user preference evidence for this parent conversation.
    state.syntheticExcluded++;
    return undefined;
  }
  const headerCwd = await canonicalPath(header.cwd);
  if (!headerCwd || headerCwd !== projectCwd) {
    state.scopeExcluded++;
    return undefined;
  }
  return {
    file,
    id: header.id,
    size: Number(info.size) || 0,
    mtimeMs: Number(info.mtimeMs) || 0,
    header,
    stat: prefix.stat,
    oversize,
  };
}

async function scanDirectory(directory, depth, projectCwd, state, candidates, signal) {
  checkAborted(signal);
  if (state.directories >= SCOPE_HISTORY_LIMITS.maxDirectories) {
    state.incomplete = true;
    state.directoryCap = true;
    return;
  }
  state.directories++;
  let handle;
  try {
    handle = await fs.opendir(directory);
  } catch {
    state.incomplete = true;
    state.directoryFailures++;
    return;
  }
  let visited = 0;
  try {
    for await (const entry of handle) {
      checkAborted(signal);
      visited++;
      if (visited > SCOPE_HISTORY_LIMITS.maxDirectoryEntries) {
        state.incomplete = true;
        state.directoryCap = true;
        break;
      }
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        state.symlinks++;
        state.incomplete = true;
        continue;
      }
      if (entry.isDirectory() && depth < 1) {
        await scanDirectory(file, depth + 1, projectCwd, state, candidates, signal);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        const candidate = await inspectCandidate(file, projectCwd, state, signal);
        if (candidate) candidates.push(candidate);
      }
      if ((visited & 31) === 0) await yieldToEventLoop(signal);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function parsePersistedFile(candidate, state, signal) {
  checkAborted(signal);
  const read = await readBounded(
    candidate.file,
    SCOPE_HISTORY_LIMITS.maxFileBytes,
    signal,
    { tail: candidate.oversize === true },
  );
  if (!read.ok || !sameStat(candidate.stat, read.stat)) {
    if (read.reason === "symlink") state.symlinks++;
    else state.readFailures++;
    state.incomplete = true;
    return [];
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
  } catch {
    state.invalidEncoding++;
    state.incomplete = true;
    return [];
  }
  let lines = text.split("\n");
  const tail = candidate.oversize === true || read.offset > 0;
  if (tail) {
    // A tail starts in the middle of a physical JSONL line.  It is not safe
    // to parse that fragment as an entry; the independently checked header
    // from inspectCandidate remains the chain's synthetic root.
    if (read.offset > 0) {
      lines.shift();
      state.partialLines++;
      state.incomplete = true;
    }
  } else {
    // Validate the header again against the bounded read before applying the
    // line cap.  The header was checked during discovery; this second check
    // also prevents a changed file from turning a suffix into another session.
    const header = parseHeader(Buffer.from(lines[0] ?? "", "utf8"));
    if (!header || header.id !== candidate.id) {
      state.invalidHeaders++;
      state.incomplete = true;
      return [];
    }
  }
  const hasFinalNewline = text.endsWith("\n");
  if (!tail && read.truncated && !hasFinalNewline) {
    lines.pop();
    state.partialLines++;
    state.incomplete = true;
  } else if (!hasFinalNewline && lines.at(-1)?.trim()) {
    // A complete final JSONL record does not require a trailing newline.
  }
  if (lines.length > SCOPE_HISTORY_LIMITS.maxLinesPerFile + 1) {
    lines = lines.slice(-(SCOPE_HISTORY_LIMITS.maxLinesPerFile + 1));
    state.lineCaps++;
    state.incomplete = true;
  }
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    checkAborted(signal);
    let line = lines[index];
    if (index === 0) line = line.replace(/^\uFEFF/u, "");
    line = line.replace(/\r$/u, "");
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (isObject(value)) entries.push(value);
    } catch {
      state.malformedLines++;
      state.incomplete = true;
    }
    if ((index & 127) === 0) await yieldToEventLoop(signal);
  }
  if (!entries.length) {
    state.invalidHeaders++;
    state.incomplete = true;
    return [];
  }
  // For a line-capped full read, and for every bounded tail, keep the checked
  // header as a synthetic root so activeChain can still follow retained
  // parent links.  This does not expose header data in returned evidence.
  if (entries[0]?.type !== "session") entries.unshift(candidate.header);
  return activeChain(entries, state);
}

function branchEntries(branch, state) {
  if (branch === undefined || branch === null) {
    state.branchUnavailable = true;
    state.incomplete = true;
    return [];
  }
  try {
    if (typeof branch === "string") throw new TypeError("branch must contain entries");
    const values = Array.isArray(branch) ? branch.slice() : [...branch];
    if (values.length > SCOPE_HISTORY_LIMITS.maxCurrentBranchEntries) {
      state.branchCap = true;
      state.incomplete = true;
      return values.slice(-SCOPE_HISTORY_LIMITS.maxCurrentBranchEntries);
    }
    return values;
  } catch {
    state.branchUnavailable = true;
    state.incomplete = true;
    return [];
  }
}

function publicRecord(record) {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    at: record.at,
    source: record.source,
  };
}

function recordCost(record) {
  return JSON.stringify(publicRecord(record)).length;
}

function rankNewest(a, b) {
  return b.at - a.at || b._sequence - a._sequence || a.id.localeCompare(b.id);
}

function rankOldest(a, b) {
  return a.at - b.at || a._sequence - b._sequence || a.id.localeCompare(b.id);
}

function chooseRecords(records, prompt, state) {
  const terms = promptTerms(prompt);
  for (const record of records) record._score = relevance(record.text, terms);

  const current = records.filter((record) => record._current).sort(rankNewest);
  const persisted = records.filter((record) => !record._current);
  const uiPrompt = isUiScopePrompt(prompt);
  const domainPreferences = uiPrompt
    ? persisted.filter((record) => isUiPreference(record.text, prompt))
    : [];
  const lexicalAnchors = records.filter((record) => record._score > 0 || domainPreferences.includes(record));
  const continuity = records.filter((record) => isAdjacentCorrection(record, lexicalAnchors));
  // An unanchored prompt has no safe way to identify an older topic.  The
  // live branch still supplies immediate conversational continuity, while
  // persisted sessions stay unknown until a lexical subject is present.
  const relevant = terms.length ? persisted.filter((record) => record._score > 0) : [];
  const bySource = new Map();
  for (const record of persisted) {
    const list = bySource.get(record.source) ?? [];
    list.push(record);
    bySource.set(record.source, list);
  }

  // Admission is newest-first.  The oldest matching record from each session
  // is admitted after the recent window when room remains, preserving a small
  // baseline for preference evolution without making old prose authoritative.
  const latestCurrent = terms.length
    ? current.filter((record) => record._score > 0 || continuity.includes(record)).slice(0, 8)
    : current.filter((record) => record.role === "user").slice(0, 2);
  const latestRelevant = [...relevant, ...continuity.filter((record) => !record._current), ...domainPreferences]
    .sort(rankNewest)
    .slice(0, 56);
  const baselines = [];
  for (const list of bySource.values()) {
    const matching = list.filter((record) => record._score > 0 || domainPreferences.includes(record)).sort(rankOldest);
    const baseline = matching[0];
    if (baseline) baselines.push(baseline);
  }
  // Do not append an unscoped latest record or the complete record set here:
  // after a task pivot that would make an old, unrelated statement look like
  // a current preference.  Relevance and the live branch are the admission
  // boundary; omitted history remains unknown.
  const ordered = [...latestCurrent, ...latestRelevant, ...baselines];
  const seen = new Set();
  const blockedSources = new Set();
  const selected = [];
  let used = 0;
  for (const record of ordered) {
    const key = `${record.source}\0${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (blockedSources.has(record.source)) continue;
    if (newerOmission(record, state)) {
      blockedSources.add(record.source);
      state.historyGap = true;
      state.incomplete = true;
      continue;
    }
    const candidate = [...selected.map(publicRecord), publicRecord(record)];
    if (JSON.stringify(candidate).length > SCOPE_HISTORY_LIMITS.maxOutputChars) {
      // A newer message from this session has already been omitted.  Older
      // messages in that same chain must not be used as a substitute for a
      // potentially conflicting correction.
      blockedSources.add(record.source);
      state.outputOmitted = true;
      state.incomplete = true;
      continue;
    }
    selected.push(record);
    used = JSON.stringify(selected.map(publicRecord)).length;
  }
  // Consumers read the evidence chronologically.  Ranking above only controls
  // which intact records survive the final character budget.
  selected.sort((a, b) => a.at - b.at || a._sequence - b._sequence || a.id.localeCompare(b.id));
  return selected.map(publicRecord);
}

function coverageText(state, evidence) {
  const reasons = [];
  if (state.directoryIssue) reasons.push(state.directoryIssue);
  if (state.directoryCap) reasons.push("directory cap reached");
  if (state.fileCap) reasons.push("file cap reached");
  if (state.totalByteCap) reasons.push("total byte cap reached");
  if (state.lineCaps) reasons.push("line cap reached");
  if (state.partialLines) reasons.push("partial line skipped");
  if (state.malformedLines) reasons.push("malformed line(s) skipped");
  if (state.oversizeFiles) reasons.push("oversize file prefix(es) omitted; bounded tail read");
  if (state.symlinks) reasons.push("symlink path(s) skipped");
  if (state.invalidEncoding) reasons.push("invalid UTF-8 skipped");
  if (state.brokenChains) reasons.push("missing active-chain ancestor(s)");
  if (state.branchCap) reasons.push("live branch cap reached");
  if (state.branchUnavailable) reasons.push("live branch unavailable");
  if (state.longMessages) reasons.push("oversize message(s) skipped");
  if (state.headerFailures || state.invalidHeaders) reasons.push("invalid or unreadable session header(s)");
  if (state.readFailures || state.directoryFailures) reasons.push("read failure(s)");
  if (state.secretMessages) reasons.push("credential-like message(s) omitted");
  if (state.syntheticExcluded) reasons.push("forked/child session(s) excluded");
  if (state.outputOmitted) reasons.push("output budget reached");
  if (state.historyGap) reasons.push("newer omitted message(s) leave this chain uncertain");
  const status = state.incomplete
    ? `INCOMPLETE; omitted and older evidence remains unknown (${[...new Set(reasons)].join(", ") || "bounded scan"}).`
    : "COMPLETE within scan bounds.";
  // Keep the uncertainty statement at the beginning: callers may display only
  // a short prefix while constructing the agent context.
  return `${status} ${evidence.length} same-project user/assistant text message(s) from active chains and the live branch. Canonical cwd headers filtered cross-project files; synthetic extension entries, child/tool results, thinking, images and tool-call bodies were excluded. Latest matches were prioritized; older matches are baseline evidence only. Historical text is never authorization.`;
}

/**
 * Collect bounded same-project session evidence for change-scope reasoning.
 * Persisted files are filtered by their canonical session header before the
 * file cap is applied.  `branch` is the active in-memory SessionManager branch
 * and is included even when Pi has not flushed the current session to disk.
 */
export async function collectScopeHistory({ cwd, sessionsDir, currentSessionId, prompt, branch, signal } = {}) {
  checkAborted(signal);
  const state = {
    candidateFiles: 0,
    scopeExcluded: 0,
    directories: 0,
    directoryFailures: 0,
    directoryIssue: "",
    directoryCap: false,
    fileCap: false,
    totalByteCap: false,
    headerFailures: 0,
    invalidHeaders: 0,
    readFailures: 0,
    malformedLines: 0,
    partialLines: 0,
    lineCaps: 0,
    oversizeFiles: 0,
    invalidEncoding: 0,
    symlinks: 0,
    brokenChains: 0,
    secretMessages: 0,
    longMessages: 0,
    syntheticExcluded: 0,
    historyGap: false,
    omittedBySource: new Map(),
    outputOmitted: false,
    branchUnavailable: false,
    branchCap: false,
    incomplete: false,
  };
  const projectCwd = await canonicalPath(cwd);
  if (!projectCwd) {
    state.incomplete = true;
    state.directoryIssue = "project cwd could not be canonicalized";
  }

  const records = [];
  let sequence = 0;
  const live = branchEntries(branch, state);
  for (const entry of live) {
    checkAborted(signal);
    const record = recordFromEntry(entry, "current-branch", sequence++, state);
    if (record) records.push(record);
    if ((sequence & 127) === 0) await yieldToEventLoop(signal);
  }

  const root = projectCwd ? await resolveSessionsDir(sessionsDir, state) : undefined;
  const candidates = [];
  if (root && projectCwd) await scanDirectory(root, 0, projectCwd, state, candidates, signal);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const eligible = candidates.filter((candidate) => candidate.id !== currentSessionId);
  if (eligible.length > SCOPE_HISTORY_LIMITS.maxFiles) {
    state.fileCap = true;
    state.incomplete = true;
  }
  let totalBytes = 0;
  for (const candidate of eligible.slice(0, SCOPE_HISTORY_LIMITS.maxFiles)) {
    checkAborted(signal);
    const boundedSize = Math.min(candidate.size, SCOPE_HISTORY_LIMITS.maxFileBytes);
    if (totalBytes + boundedSize > SCOPE_HISTORY_LIMITS.maxTotalBytes) {
      state.totalByteCap = true;
      state.incomplete = true;
      continue;
    }
    totalBytes += boundedSize;
    const chain = await parsePersistedFile(candidate, state, signal);
    const source = `session:${safeId(candidate.id, candidate.file)}`;
    for (const entry of chain) {
      const record = recordFromEntry(entry, source, sequence++, state);
      if (record) records.push(record);
    }
    if (chain.length) await yieldToEventLoop(signal);
  }
  const evidence = chooseRecords(records, prompt, state);
  return {
    evidence,
    incomplete: state.incomplete,
    coverage: coverageText(state, evidence),
  };
}

export default collectScopeHistory;
