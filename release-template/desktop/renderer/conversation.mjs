export const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export const imageParts = message => Array.isArray(message?.content) ? message.content.filter(c => c.type === 'image' && typeof c.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType)) : [];
export const toolIcon = name => /bash|shell|terminal/.test(name) ? 'terminal' : /memory|recall|remember/.test(name) ? 'memory' : /search|find|browse/.test(name) ? 'search' : /edit|write|patch/.test(name) ? 'code' : 'file';
const key = () => globalThis.crypto.randomUUID();
export function createConversation(messages = []) {
  const state = { messages: [], streaming: null, busy: false, activities: [], error: '', stats: null };
  for (const message of messages) appendMessage(state, message);
  return state;
}
export function prependConversation(state, messages) {
  const earlier = createConversation(messages), merged = new Set();
  for (let index = 0; index < earlier.messages.length; index++) {
    const tool = earlier.messages[index];
    if (tool.kind !== 'tool') continue;
    const existing = state.messages.find(m => m.kind === 'tool' && m.callId === tool.callId);
    if (!existing) continue;
    existing.name = tool.name || existing.name;
    existing.args = Object.keys(tool.args || {}).length ? tool.args : existing.args;
    if (existing.status === 'running' && tool.status !== 'running') { existing.status = tool.status; existing.output = tool.output; existing.images = tool.images; }
    existing.revision++; earlier.messages[index] = existing; merged.add(tool.callId);
  }
  state.messages = [...earlier.messages, ...state.messages.filter(m => m.kind !== 'tool' || !merged.has(m.callId))];
  return state;
}
function ensureTool(state, id, name = 'tool', args = {}) {
  let tool = state.messages.find(m => m.kind === 'tool' && m.callId === id);
  if (!tool) { tool = { key: key(), kind: 'tool', callId: id, name, args, status: 'running', output: '', images: [], revision: 0 }; state.messages.push(tool); }
  return tool;
}
function appendMessage(state, message) {
  if (!message) return;
  if (message.role === 'toolResult') {
    const tool = ensureTool(state, message.toolCallId, message.toolName);
    tool.status = message.isError ? 'error' : 'done'; tool.output = messageText(message).slice(0, 16000); tool.images = imageParts(message); tool.revision++;
    return;
  }
  if (message.role === 'assistant' || message.role === 'user') {
    const entry = { key: key(), kind: message.role, content: structuredClone(message.content ?? []), revision: 0 };
    if (message.role === 'assistant') entry.error = message.errorMessage || '';
    state.messages.push(entry);
    if (Array.isArray(message.content)) for (const part of message.content) if (part.type === 'toolCall') ensureTool(state, part.id, part.name, part.arguments);
    return entry;
  }
  if (message.role === 'custom' && message.display !== false) state.messages.push({ key: key(), kind: 'note', content: message.content, revision: 0 });
}
export function applyAgentEvent(state, event) {
  switch (event.type) {
    case 'agent_start': state.busy = true; state.error = ''; break;
    case 'agent_end': state.busy = false; state.streaming = null; break;
    case 'message_start': {
      if (event.message?.role === 'user') {
        const pending = state.messages.find(m => m.optimistic && messageText(m) === messageText(event.message));
        if (pending) { pending.optimistic = false; pending.revision++; break; }
      }
      const message = appendMessage(state, event.message);
      if (event.message?.role === 'assistant' && message) state.streaming = message.key;
      break;
    }
    case 'message_update': {
      const delta = event.assistantMessageEvent;
      if (!delta) break;
      let message = state.messages.find(m => m.key === state.streaming);
      if (!message) { message = appendMessage(state, { role: 'assistant', content: [] }); state.streaming = message.key; }
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        const type = delta.type === 'text_delta' ? 'text' : 'thinking';
        if (!Array.isArray(message.content)) message.content = [];
        const index = Number.isInteger(delta.contentIndex) && delta.contentIndex >= 0 && delta.contentIndex < 256 ? delta.contentIndex : 0;
        const part = message.content[index] ?? { type, [type]: '' };
        part[type] = ((part[type] ?? '') + (delta.delta ?? '')).slice(0, 500_000);
        message.content[index] = part; message.revision++;
      }
      break;
    }
    case 'message_end': {
      if (event.message?.role === 'assistant') {
        const message = state.messages.find(m => m.key === state.streaming);
        if (message) { message.content = structuredClone(event.message.content); message.error = event.message.errorMessage || ''; message.revision++; }
        else appendMessage(state, event.message);
        if (event.message.errorMessage) state.error = event.message.errorMessage;
        state.streaming = null;
      }
      if (event.message?.role === 'toolResult') appendMessage(state, event.message);
      break;
    }
    case 'tool_execution_start': {
      const tool = ensureTool(state, event.toolCallId, event.toolName, event.args);
      tool.name = event.toolName; tool.args = event.args; tool.revision++;
      state.activities.unshift({ id: event.toolCallId, name: event.toolName, path: event.args?.path ?? event.args?.query ?? '', status: 'running', at: Date.now() });
      state.activities.length = Math.min(state.activities.length, 80);
      break;
    }
    case 'tool_execution_end': {
      const tool = ensureTool(state, event.toolCallId, event.toolName);
      tool.status = event.isError ? 'error' : 'done'; tool.output = messageText(event.result).slice(0, 16000); tool.images = imageParts(event.result); tool.revision++;
      const activity = state.activities.find(a => a.id === event.toolCallId); if (activity) activity.status = tool.status;
      break;
    }
    case 'auto_compaction_start': state.compacting = true; break;
    case 'auto_compaction_end': state.compacting = false; break;
    case 'auto_retry_start': state.retrying = event.attempt ?? 1; break;
    case 'auto_retry_end': state.retrying = null; break;
  }
  return state;
}
