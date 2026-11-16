import { createHash, randomUUID } from 'node:crypto';

// Desktop previews never alter the authoritative messages sent to the model or
// saved in JSONL. Keep wire records bounded, including image-heavy history.
const liveHistory = new WeakMap();
const MAX_CACHED_LIVE_HISTORY_ENTRIES = 50_000;

/** Harness-activity lines are drawn from their small, fixed-shape details (label, status, detail), never from model content. */
const activityDetails = (customType, details) => {
    if (customType !== 'harness-activity' || !details || typeof details !== 'object') return undefined;
    const json = JSON.stringify(details);
    return json.length <= 1024 ? JSON.parse(json) : undefined;
};
const clip = (value, limit) => typeof value === 'string' && value.length > limit ? value.slice(0, limit) + '\n[Desktop preview truncated; full content is retained in session history.]' : value;
const isDesktopHistoryEntry = entry => entry.type === 'message' || entry.type === 'custom_message' || entry.type === 'compaction';
function desktopEntryMessage(entry) {
    if (entry.type === 'message') return entry.message;
    if (entry.type === 'compaction') return { role: 'custom', customType: 'desktop-compaction', content: 'Context compacted. Earlier conversation remains available.', display: true, timestamp: entry.timestamp };
    const details = activityDetails(entry.customType, entry.details);
    return { role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: entry.timestamp, ...(details ? { details } : {}) };
}
export function desktopBranchMessages(entries) {
    const messages = [];
    for (const entry of entries) {
        if (isDesktopHistoryEntry(entry)) messages.push(desktopEntryMessage(entry));
    }
    return messages;
}
/** The latest /goal snapshot on a branch, so the desktop shows an unfinished goal before any runtime starts. */
export function desktopGoal(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== 'custom' || entry.customType !== 'goal-state-v1' || !Array.isArray(entry.data?.criteria)) continue;
        if (!['active', 'paused', 'blocked'].includes(entry.data.status)) return null;
        return { id: String(entry.data.id ?? ''), status: entry.data.status, settled: entry.data.criteria.filter((criterion) => criterion?.status !== 'open').length, total: entry.data.criteria.length };
    }
    return null;
}
export function desktopMessage(message, budget = { remaining: 8 * 1024 * 1024 }) {
    if (!message || typeof message !== 'object') return message;
    const preview = {};
    for (const key of ['role', 'toolCallId', 'toolName', 'isError', 'errorMessage', 'stopReason', 'customType', 'display', 'timestamp', 'provider', 'model', 'usage']) {
        if (message[key] !== undefined) preview[key] = typeof message[key] === 'string' ? clip(message[key], 4000) : message[key];
    }
    const details = activityDetails(message.customType, message.details);
    if (details) preview.details = details;
    if (typeof message.content === 'string') preview.content = clip(message.content, 32_000);
    else {
    let remaining = Math.min(budget.remaining, 4 * 1024 * 1024);
    preview.content = [];
    for (const part of (message.content ?? []).slice(0, 128)) {
        if (remaining < 300) break;
        let projected;
        if (part.type === 'image') {
            if (typeof part.data === 'string' && part.data.length + 200 <= remaining) {
                projected = { type: 'image', mimeType: part.mimeType, data: part.data };
            } else {
                projected = { type: 'text', text: '[Image retained in session history; omitted from this desktop preview.]' };
            }
        }
        else if (part.type === 'thinking') projected = { type: 'thinking', thinking: clip(part.thinking, 24_000) };
        else if (part.type === 'toolCall') projected = { type: 'toolCall', id: part.id, name: part.name, arguments: desktopArguments(part.arguments) };
        else projected = { type: 'text', text: clip(part.text ?? '', message.role === 'toolResult' ? 16_000 : 500_000) };
        let bytes = Buffer.byteLength(JSON.stringify(projected));
        if (bytes > remaining) {
            const field = projected.type === 'thinking' ? 'thinking' : 'text';
            projected = { type: field, [field]: clip(part[field] ?? JSON.stringify(projected), Math.max(0, Math.floor((remaining - 250) / 6))) };
            bytes = Buffer.byteLength(JSON.stringify(projected));
        }
        preview.content.push(projected); remaining -= bytes; budget.remaining -= bytes;
    }
    if (preview.content.length < (message.content ?? []).length) preview.content.push({ type: 'text', text: '[Additional content retained in session history.]' });
    }
    return preview;
}
export function desktopArguments(args) {
    if (!args || typeof args !== 'object') return {};
    const preview = {};
    for (const [key, value] of Object.entries(args).slice(0, 24)) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        preview[key] = clip(text, 4000);
    }
    return preview;
}
function validateHistoryPage(limit, before) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || before !== undefined && (!Number.isInteger(before) || before < 0)) throw Error('History needs a limit of 1–200 and a nonnegative before index.');
}
function historyPage(records, limit, before = records.length, toMessage) {
    const end = Math.min(before, records.length), lower = Math.max(0, end - limit), previews = [];
    let bytes = 0, start = end;
    for (let index = end - 1; index >= lower; index--) {
        const preview = desktopMessage(toMessage ? toMessage(records[index]) : records[index]), size = Buffer.byteLength(JSON.stringify(preview));
        if (previews.length && bytes + size > 8 * 1024 * 1024) break;
        previews.push(preview); bytes += size; start = index;
    }
    return { messages: previews.reverse(), before: start, hasMore: start > 0, total: records.length };
}
export function desktopHistory(messages, { limit = 80, before } = {}) {
    validateHistoryPage(limit, before);
    return historyPage(messages, limit, before);
}
function historyAnchor(scope, record) {
    return typeof record?.id === 'string' ? createHash('sha256').update(scope).update(record.id).digest('hex') : undefined;
}
export function desktopSessionHistory(manager, { limit = 80, before, anchor } = {}) {
    validateHistoryPage(limit, before);
    if (anchor !== undefined && (before === undefined || typeof anchor !== 'string' || !/^[a-f0-9]{64}$/.test(anchor))) throw Error('A history anchor requires a matching before index.');
    const header = manager.getHeader();
    let cache = liveHistory.get(manager);
    if (!cache || cache.header !== header) {
        cache = { header, scope: randomUUID(), projection: undefined };
        liveHistory.set(manager, cache);
    }
    const leaf = manager.getLeafEntry(), revision = manager.getEntriesRevision();
    let projection = cache.projection;
    if (!projection || projection.leaf !== leaf || projection.revision !== revision) {
        const branch = manager.getBranch();
        const records = branch.filter(isDesktopHistoryEntry);
        projection = { leaf, revision, records, goal: desktopGoal(branch) };
        cache.projection = records.length <= MAX_CACHED_LIVE_HISTORY_ENTRIES ? projection : undefined;
    }
    const { records, goal } = projection;
    // An append-only branch keeps its older prefix. A new session header or a
    // different entry at the boundary invalidates the renderer's cursor.
    if (anchor !== undefined && anchor !== historyAnchor(cache.scope, records[before])) return { reset: true };
    const page = historyPage(records, limit, before, desktopEntryMessage);
    return { ...page, anchor: page.hasMore ? historyAnchor(cache.scope, records[page.before]) : undefined, goal: before === undefined ? goal : undefined };
}
export function desktopEvent(event) {
    if (event.type === 'tool_execution_update') return undefined;
    if (event.type === 'agent_end') return { type: 'agent_end' };
    if (event.type === 'turn_end') return { type: 'turn_end' };
    if (event.type === 'message_start' || event.type === 'message_end') {
        // A provider's shared assistant partial can already contain updates
        // queued behind its start. The live desktop builds content from deltas.
        const message = event.type === 'message_start' && event.message?.role === 'assistant'
            ? { ...event.message, content: [] }
            : event.message;
        return { ...event, message: desktopMessage(message) };
    }
    if (event.type === 'tool_execution_start') return { ...event, args: desktopArguments(event.args) };
    if (event.type === 'tool_execution_end') return { ...event, result: desktopMessage({ ...event.result, role: 'toolResult' }) };
    return event;
}
