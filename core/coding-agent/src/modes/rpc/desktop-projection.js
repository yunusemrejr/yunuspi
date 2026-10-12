// Desktop previews never alter the authoritative messages sent to the model or
// saved in JSONL. Keep wire records bounded, including image-heavy history.
const clip = (value, limit) => typeof value === 'string' && value.length > limit ? value.slice(0, limit) + '\n[Desktop preview truncated; full content is retained in session history.]' : value;
export function desktopBranchMessages(entries) {
    const messages = [];
    for (const entry of entries) {
        if (entry.type === 'message') messages.push(entry.message);
        else if (entry.type === 'custom_message') messages.push({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: entry.timestamp });
        else if (entry.type === 'compaction') messages.push({ role: 'custom', customType: 'desktop-compaction', content: 'Context compacted. Earlier conversation remains available.', display: true, timestamp: entry.timestamp });
    }
    return messages;
}
export function desktopMessage(message, budget = { remaining: 8 * 1024 * 1024 }) {
    if (!message || typeof message !== 'object') return message;
    const preview = {};
    for (const key of ['role', 'toolCallId', 'toolName', 'isError', 'errorMessage', 'stopReason', 'customType', 'display', 'timestamp', 'provider', 'model', 'usage']) {
        if (message[key] !== undefined) preview[key] = typeof message[key] === 'string' ? clip(message[key], 4000) : message[key];
    }
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
export function desktopHistory(messages, { limit = 80, before = messages.length } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(before) || before < 0) throw Error('History needs a limit of 1–200 and a nonnegative before index.');
    const end = Math.min(before, messages.length), lower = Math.max(0, end - limit), previews = [];
    let bytes = 0, start = end;
    for (let index = end - 1; index >= lower; index--) {
        const preview = desktopMessage(messages[index]), size = Buffer.byteLength(JSON.stringify(preview));
        if (previews.length && bytes + size > 8 * 1024 * 1024) break;
        previews.unshift(preview); bytes += size; start = index;
    }
    return { messages: previews, before: start, hasMore: start > 0, total: messages.length };
}
export function desktopEvent(event) {
    if (event.type === 'tool_execution_update') return undefined;
    if (event.type === 'agent_end') return { type: 'agent_end' };
    if (event.type === 'turn_end') return { type: 'turn_end' };
    if (event.type === 'message_start' || event.type === 'message_end') return { ...event, message: desktopMessage(event.message) };
    if (event.type === 'tool_execution_start') return { ...event, args: desktopArguments(event.args) };
    if (event.type === 'tool_execution_end') return { ...event, result: desktopMessage({ ...event.result, role: 'toolResult' }) };
    return event;
}
