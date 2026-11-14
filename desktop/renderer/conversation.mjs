export const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export const imageParts = message => Array.isArray(message?.content) ? message.content.filter(c => c.type === 'image' && typeof c.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType)) : [];
const key = () => globalThis.crypto.randomUUID();

// What a tool call is for, read from its name. The first match wins, so `web_search` is a web step.
const TOOL_KINDS = [
  ['command', /^(?:bash|bg_run|bg_wait|shell|terminal|process)$/],
  ['read', /^read(?:_|$)/],
  ['edit', /^(?:edit|multi_?edit|write|apply_patch|patch)$/],
  ['agent', /^subagent/],
  ['plan', /^(?:goal|todo|checkpoint)$/],
  ['memory', /memory|recall|remember/],
  ['web', /web|fetch|browser|ui_explore|visual_review|github/],
  ['search', /grep|glob|find|search|^ls$|navigation/],
];
const KIND_ICON = { command: 'terminal', read: 'file', edit: 'code', agent: 'people', plan: 'target', memory: 'memory', web: 'compass', search: 'search', other: 'tune' };
export const toolKind = name => TOOL_KINDS.find(([, pattern]) => pattern.test(String(name ?? '')))?.[0] ?? 'other';
export const toolIcon = name => KIND_ICON[toolKind(name)];

const firstLine = value => String(value ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
const squeeze = (value, limit = 140) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const pretty = name => { const words = String(name || 'tool').replace(/[_-]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
/** Arguments reach the desktop as text: a list is its JSON, and one cut short by the preview limit reads as no list. */
const listArg = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trimStart().startsWith('[')) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
const toolPath = args => args.path || args.file || args.file_path || args.filePath || '';
/** The files a read or an edit touched, so a summary can count files and not calls. */
const toolFiles = tool => {
  const args = tool?.args && typeof tool.args === 'object' ? tool.args : {};
  const many = listArg(args.files).map(file => typeof file === 'string' ? file : file?.path).filter(Boolean);
  return many.length ? many : toolPath(args) ? [String(toolPath(args))] : [];
};

const RUNNING = { Ran: 'Running', Read: 'Reading', Edited: 'Editing', Wrote: 'Writing', Searched: 'Searching', Listed: 'Listing', Started: 'Starting' };
/** One line for a tool call in the words a person would use: what was done (`verb`) to what (`detail`).
 * A call still running is said in the present: `Running npm test`. */
export function toolLine(tool) {
  const line = describeTool(tool);
  return tool?.status === 'running' && RUNNING[line.verb] ? { ...line, verb: RUNNING[line.verb] } : line;
}
function describeTool(tool) {
  const args = tool?.args && typeof tool.args === 'object' ? tool.args : {}, name = String(tool?.name || 'tool'), kind = toolKind(name);
  const text = value => squeeze(firstLine(value)), path = toolPath(args);
  if (name === 'bash') return { kind, verb: 'Ran', detail: text(args.command), code: true };
  if (name === 'bg_run') return { kind, verb: 'Started', detail: text(args.command || args.name), code: true };
  if (kind === 'read') return { kind, verb: 'Read', detail: squeeze(toolFiles(tool).join(', ')) || text(args.symbol || args.name), code: true };
  if (kind === 'edit') return { kind, verb: name === 'write' ? 'Wrote' : 'Edited', detail: text(path), code: true };
  if (name === 'ls') return { kind, verb: 'Listed', detail: text(path || '.'), code: true };
  if (kind === 'search') return { kind, verb: 'Searched', detail: squeeze([text(args.pattern || args.query || args.name), path ? `in ${text(path)}` : ''].filter(Boolean).join(' ')), code: true };
  if (kind === 'agent') {
    const tasks = listArg(args.tasks), chain = listArg(args.chain), agents = list => list.map(step => step?.agent).filter(Boolean);
    if (tasks.length) return { kind, verb: `${tasks.length} agents at once`, detail: squeeze(agents(tasks).join(', ')) };
    if (chain.length) return { kind, verb: `${chain.length} agents in turn`, detail: squeeze(agents(chain).join(' → ')) };
    if (args.agent && args.task) return { kind, verb: pretty(args.agent), detail: text(args.task) };
    return { kind, verb: 'Subagents', detail: squeeze([args.action, args.agent].filter(Boolean).join(' · ')) };
  }
  const target = path || args.url || args.query || args.pattern || args.command || args.name || args.task || args.prompt || args.message || args.taskId || '';
  return { kind, verb: pretty(name), detail: squeeze([args.action, target && target !== args.action ? text(target) : ''].filter(Boolean).join(' · ')), code: kind === 'command' };
}

/** The line of a failed call's output that says what went wrong: the first that names a failure, else the first line. */
export function toolTrouble(tool) {
  if (tool?.status !== 'error') return '';
  const lines = String(tool.output ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const telling = lines.find(line => /error|fail|not found|no such|denied|refused|cannot|unable|invalid|exit code|timed out|not ok|✖/i.test(line)) ?? lines[0] ?? '';
  return squeeze(telling.replace(/^(?:\W*RETRYABLE\W*|error:\s*|[✖✗×]\s*)/i, ''), 180);
}

/** The files a session changed, oldest first, with how many edits each took. A failed edit changed nothing. */
export function filesChanged(messages) {
  const files = new Map();
  for (const tool of messages) if (tool.kind === 'tool' && tool.status === 'done' && toolKind(tool.name) === 'edit') for (const file of toolFiles(tool)) files.set(file, (files.get(file) ?? 0) + 1);
  return [...files].map(([path, edits]) => ({ path, edits }));
}

/** A span of time as people say it: `8 s`, `2m 14s`, `1h 05m`. Nothing under one second, or for a span that was not measured. */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What a block of work came to: how many steps of each kind, how it ended and how long it took. */
export function workSummary(steps, live = false) {
  const tools = steps.filter(step => step.kind === 'tool'), counts = {}, files = { read: new Set(), edit: new Set() };
  for (const tool of tools) {
    const kind = toolKind(tool.name);
    // A command that failed still ran; an edit or a read that failed changed or showed nothing.
    if (files[kind] && tool.status === 'error') continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (files[kind]) for (const file of toolFiles(tool)) files[kind].add(file);
  }
  const parts = [];
  if (counts.command) parts.push(`ran ${count(counts.command, 'command')}`);
  if (counts.edit) parts.push(`edited ${count(files.edit.size || counts.edit, 'file')}`);
  if (counts.read) parts.push(`read ${count(files.read.size || counts.read, 'file')}`);
  if (counts.search) parts.push(count(counts.search, 'search', 'searches'));
  if (counts.web) parts.push(count(counts.web, 'web step'));
  if (counts.agent) parts.push(count(counts.agent, 'subagent run'));
  const other = (counts.plan ?? 0) + (counts.memory ?? 0) + (counts.other ?? 0);
  if (other) parts.push(count(other, parts.length ? 'other step' : 'step'));
  const times = steps.flatMap(step => [step.startedAt, step.at]).filter(Number.isFinite);
  const last = tools.at(-1), failed = tools.filter(tool => tool.status === 'error').length;
  // A turn that is over cannot still be running a tool: that call was cut off.
  const state = live ? 'live' : tools.some(tool => tool.status === 'running') ? 'stopped' : last?.status === 'error' ? 'failed' : 'done';
  return { tools: tools.length, failed, state, phrase: parts.join(', '), ms: times.length > 1 ? Math.max(...times) - Math.min(...times) : undefined, last };
}

/**
 * Folds what the agent did between two things the user reads into one block: its tool calls, the
 * harness lines and the short lines the model wrote on the way. What the model wrote last, after its
 * last tool, is the answer and stays outside. While the turn runs (`busy`) nothing is the answer yet.
 * A stretch without a tool call is plain conversation and is left as it is, and a block of one or two
 * calls is `bare`: its rows need no header to sum them up.
 */
export function workBlocks(messages, busy = false) {
  const items = []; let steps = [];
  const flush = live => {
    if (!steps.length) return;
    const tools = steps.filter(step => step.kind === 'tool').length, last = steps.at(-1);
    const answer = tools && !live && last.kind === 'assistant' && (messageText(last) || imageParts(last).length) ? steps.pop() : null;
    if (tools) items.push({ kind: 'work', key: `work:${steps[0].key}`, steps, live, bare: tools < 3 });
    else items.push(...steps);
    if (answer) items.push(answer);
    steps = [];
  };
  for (const message of messages) {
    if (message.kind === 'tool' || message.kind === 'assistant' || message.kind === 'activity') steps.push(message);
    else { flush(false); items.push(message); }
  }
  flush(busy);
  return items;
}

/**
 * The harness writes goal turns as user messages: the kickoff carries the whole brief and each
 * continuation is synthetic. Read them back so the transcript shows a goal card and a
 * "continuing" row instead of a wall of text the user never typed (goal-state.ts formats).
 */
export function goalMessage(text) {
  const value = String(text ?? '');
  const continuation = /^\[goal (\w+), continuation (\d+)\/(\d+)\] ([^\n]*)/.exec(value);
  if (continuation) {
    const open = /^The goal is not finished: (\d+) criteria/.exec(continuation[4]);
    return { type: 'continuation', id: continuation[1], step: Number(continuation[2]), limit: Number(continuation[3]), open: open ? Number(open[1]) : 0 };
  }
  const kickoff = /^\[goal-tracked (\w+)\] Goal: ([\s\S]*?)\n\nAcceptance criteria[^\n]*\n((?:- [^\n]*\n?)+)/.exec(value);
  if (!kickoff) return null;
  const body = kickoff[2];
  const literal = /The user wrote: «([\s\S]*?)»/.exec(body)?.[1] ?? /^Assignment: ([^\n]+)/.exec(body)?.[1];
  const order = /Boosts (?:in force|added to this goal)(?:, in the order written)? — (.+?) —/.exec(body)?.[1] ?? /^(\w+) boost in force/.exec(body)?.[1];
  const criteria = kickoff[3].split('\n').map(line => /^- (\w+): (.*)$/.exec(line)).filter(Boolean).map(([, id, text]) => ({ id, text }));
  const note = /\n\nThe user's note on resuming: ([^\n]+)/.exec(value)?.[1];
  return { type: 'kickoff', id: kickoff[1], words: (literal ?? body.split('\n\n')[0]).trim(), boosts: order ? order.split(/\s*(?:→|\+)\s*/).filter(Boolean) : [], criteria, ...(note ? { note } : {}) };
}

/** Consecutive harness lines (JEV, effort, skills, guardian) share one compact row. */
function appendActivity(state, message) {
  const details = message.details && typeof message.details === 'object' ? message.details : {};
  // Lines carry their reading in details; the content string is only a fallback for lines without any.
  const fallback = message.details ? '' : typeof message.content === 'string' ? message.content : '';
  const item = { label: String(details.label ?? 'Harness').slice(0, 60), detail: String(details.detail ?? fallback).slice(0, 240), status: details.status === 'error' ? 'error' : details.status === 'skip' ? 'skip' : 'ok' };
  const last = state.messages.at(-1);
  if (last?.kind === 'activity' && last.items.length < 40) { last.items.push(item); last.revision++; return last; }
  const entry = { key: key(), kind: 'activity', items: [item], revision: 0 };
  state.messages.push(entry);
  return entry;
}
export function createConversation(messages = []) {
  const state = { messages: [], streaming: null, busy: false, error: '', stats: null };
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
    if (Number.isFinite(message.timestamp)) tool.at ??= message.timestamp;
    return;
  }
  if (message.role === 'assistant' || message.role === 'user') {
    const entry = { key: key(), kind: message.role, content: structuredClone(message.content ?? []), revision: 0 };
    if (Number.isFinite(message.timestamp)) entry.at = message.timestamp;
    if (message.role === 'assistant') entry.error = message.errorMessage || '';
    else {
      const goal = goalMessage(messageText(message));
      if (goal?.type === 'kickoff') { state.goals ??= new Set(); if (state.goals.has(goal.id)) goal.resumed = true; state.goals.add(goal.id); }
      if (goal) entry.goal = goal;
    }
    state.messages.push(entry);
    if (Array.isArray(message.content)) for (const part of message.content) if (part.type === 'toolCall') ensureTool(state, part.id, part.name, part.arguments);
    return entry;
  }
  if (message.role === 'custom' && message.customType === 'harness-activity') return appendActivity(state, message);
  if (message.role === 'custom' && message.display !== false) state.messages.push({ key: key(), kind: 'note', content: message.content, revision: 0 });
}
export function applyAgentEvent(state, event) {
  switch (event.type) {
    case 'agent_start': state.busy = true; state.error = ''; state.turnStarted = Date.now(); break;
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
      if (!message) { message = appendMessage(state, { role: 'assistant', content: [], timestamp: Date.now() }); state.streaming = message.key; }
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
      tool.name = event.toolName; tool.args = event.args; tool.startedAt = Date.now(); tool.revision++;
      break;
    }
    case 'tool_execution_end': {
      const tool = ensureTool(state, event.toolCallId, event.toolName);
      tool.status = event.isError ? 'error' : 'done'; tool.output = messageText(event.result).slice(0, 16000); tool.images = imageParts(event.result); tool.revision++;
      tool.at = Date.now();
      break;
    }
    // Extension notices (goal set, continuing, achieved, cost and effort notes) stay in the transcript.
    case 'notice': {
      const text = String(event.text ?? '').slice(0, 4000), last = state.messages.at(-1);
      // "Goal g…: continuing (n)" repeats the continuation row the goal's own message draws right after it.
      if (!text || /^Goal \w+: continuing \(\d+\) — /.test(text)) break;
      if (last?.kind === 'notice' && last.text === text) { last.count = (last.count ?? 1) + 1; last.revision++; break; }
      state.messages.push({ key: key(), kind: 'notice', text, tone: event.tone === 'error' || event.tone === 'warning' ? event.tone : 'info', revision: 0 });
      break;
    }
    case 'thinking_level_changed': if (typeof event.level === 'string') state.thinkingLevel = event.level; break;
    case 'auto_compaction_start': state.compacting = true; break;
    case 'auto_compaction_end': state.compacting = false; break;
    case 'auto_retry_start': state.retrying = event.attempt ?? 1; break;
    case 'auto_retry_end': state.retrying = null; break;
  }
  return state;
}
