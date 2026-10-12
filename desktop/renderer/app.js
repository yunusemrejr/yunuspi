import { createConversation, prependConversation, applyAgentEvent, messageText, imageParts, toolIcon } from './conversation.mjs';
import { element, icon, markdown } from './markdown.mjs';

const api = window.yunuspi;
const $ = id => document.getElementById(id);
let workspace = { projects: [], sessions: [], runtime: [] }, activeId = null, archived = false;
let switchVersion = 0, renderTimer, toastTimer, modalCancel, modalOwner, modalTimer, opening = false;
const conversations = new Map(), views = new Map(), attachments = new Map(), extensionQueue = [];
const safeError = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': Error: /, '').slice(-1800);
const current = () => workspace.sessions.find(s => s.id === activeId);
const projectOf = session => workspace.projects.find(p => p.id === session?.projectId);
const conversationOf = id => { if (!conversations.has(id)) conversations.set(id, createConversation()); return conversations.get(id); };
const viewOf = id => { if (!views.has(id)) views.set(id, { pinned: true, top: 0, limit: 80, nodes: new Map(), widgets: new Map() }); return views.get(id); };
const strip = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const tryAction = task => Promise.resolve().then(task).catch(error => toast(safeError(error)));

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function saveView() {
  if (!activeId) return;
  viewOf(activeId).top = $('conversation').scrollTop;
}
function setEditorDraft(id, value, focus = false) {
  const session = workspace.sessions.find(s => s.id === id); if (!session) return;
  session.draft = value;
  if (activeId === id) { $('prompt').value = value; resizePrompt(); if (focus) $('prompt').focus(); }
  tryAction(() => api.updateSession(id, { draft: value }));
}
function syncWorkspace(value) {
  workspace = value;
  const retained = new Set(workspace.sessions.filter(s => s.state === 'open').map(s => s.id));
  for (const id of conversations.keys()) if (!retained.has(id)) {
    conversations.delete(id); attachments.delete(id); views.get(id)?.nodes.clear();
    if (!workspace.sessions.some(s => s.id === id)) views.delete(id);
  }
  for (let index = extensionQueue.length - 1; index >= 0; index--) if (!retained.has(extensionQueue[index].sessionId)) extensionQueue.splice(index, 1);
  if (modalOwner && !retained.has(modalOwner.sessionId)) closeModal(false);
  if (activeId && !workspace.sessions.some(s => s.id === activeId && s.state === 'open')) {
    saveView(); activeId = null; opening = false; $('prompt').value = ''; $('messages').replaceChildren();
  }
  renderSidebar(); renderChrome(); renderContext();
}
function renderSidebar() {
  const query = $('session-search').value.trim().toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  for (const project of workspace.projects) {
    const sessions = workspace.sessions.filter(s => s.projectId === project.id && (archived ? s.state === 'archived' : s.state !== 'archived') && (!query || `${s.title} ${project.name}`.toLocaleLowerCase().includes(query))).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!sessions.length && (query || archived)) continue;
    const group = element('section', 'project-group'), heading = element('div', 'project-heading');
    heading.append(icon('folder'), element('span', '', project.name)); heading.title = project.path;
    const add = element('button', 'icon-button'); add.append(icon('plus')); add.setAttribute('aria-label', `New session in ${project.name}`); add.onclick = () => tryAction(() => newSession(project.id)); heading.append(add); group.append(heading);
    for (const session of sessions) {
      const runtime = workspace.runtime.find(r => r.id === session.id);
      const row = element('div', `session-row${session.id === activeId ? ' active' : ''}`);
      row.dataset.sessionId = session.id;
      const select = element('button', 'session-select');
      const dot = element('span', `session-dot ${runtime?.busy ? 'running' : runtime?.status === 'ready' ? 'ready' : session.state === 'closed' ? 'closed' : ''}`);
      select.append(dot, element('span', 'session-name', session.title)); select.title = `${session.title}${runtime?.busy ? ' · Working' : session.state === 'closed' ? ' · Closed' : ''}`;
      select.setAttribute('aria-label', `${session.title}${runtime?.busy ? ', working' : ''}`);
      if (session.id === activeId) select.setAttribute('aria-current', 'page');
      select.onclick = () => archived ? showSessionMenu(session.id) : tryAction(() => openSession(session.id));
      const more = element('button', 'icon-button row-menu'); more.append(icon('dots')); more.setAttribute('aria-label', `Actions for ${session.title}`); more.onclick = () => showSessionMenu(session.id);
      row.append(select, more); group.append(row);
    }
    fragment.append(group);
  }
  if (!fragment.childNodes.length) fragment.append(element('p', 'empty-hint', query ? 'No matching sessions.' : archived ? 'Nothing archived.' : 'Open a project. Start something.'));
  // Preserve focus during streaming status updates; sidebar controls keep stable
  // semantic identity even though the inexpensive list is rebuilt.
  const focused = document.activeElement?.closest('[data-session-id]');
  const focusedId = focused?.dataset.sessionId;
  const wasMenu = document.activeElement?.classList.contains('row-menu');
  $('session-list').replaceChildren(fragment);
  if (focusedId) $('session-list').querySelector(`[data-session-id="${focusedId}"] ${wasMenu ? '.row-menu' : '.session-select'}`)?.focus({ preventScroll: true });
  $('archive-count').textContent = String(workspace.sessions.filter(s => s.state === 'archived').length || '');
  $('archive-view').setAttribute('aria-pressed', String(archived));
  $('archive-view').querySelector('span').textContent = archived ? 'All sessions' : 'Archive';
}
function renderChrome() {
  const session = current(), project = projectOf(session), state = activeId ? conversationOf(activeId) : null;
  const runtime = workspace.runtime.find(r => r.id === activeId);
  const busy = Boolean(state?.busy || runtime?.busy);
  const hasDraft = Boolean($('prompt').value.trim() || attachments.get(activeId)?.length);
  $('project-name').textContent = project?.name || 'Workspace'; $('project-button').title = project?.path || 'Open a project';
  $('session-menu').disabled = !session;
  $('prompt').disabled = !session || opening;
  $('attach').disabled = !session || opening;
  $('send').disabled = !session || !hasDraft || opening || state?.sending;
  $('send').hidden = busy && !hasDraft;
  $('stop').hidden = !busy;
  $('model-button').disabled = !session || opening || busy;
  $('thinking-button').disabled = !session || opening || busy;
  const model = state?.model || session?.model;
  $('model-button').querySelector('span').textContent = model?.name || model?.id || (opening ? 'Connecting…' : 'Choose model');
  const thinking = state?.thinkingLevel ?? session?.thinkingLevel;
  $('thinking-button').querySelector('span').textContent = thinking && thinking !== 'off' ? thinking[0].toUpperCase() + thinking.slice(1) : 'Thinking';
  $('thinking-button').classList.toggle('enabled', Boolean(thinking && thinking !== 'off'));
  const status = state?.error ? 'error' : busy ? 'working' : opening ? 'connecting' : runtime ? 'ready' : '';
  $('connection').dataset.status = status;
  $('connection').querySelector('span').textContent = { error: 'Needs attention', working: 'Working', connecting: 'Connecting…', ready: 'Ready' }[status] || 'Local workspace';
  $('turn-status').hidden = !busy;
  $('turn-status').lastElementChild.textContent = state?.compacting ? 'Making room in context' : state?.retrying ? `Retrying · ${state.retrying}` : 'Working';
  const error = state?.error || '';
  $('session-error').hidden = !error; $('session-error').querySelector('span').textContent = strip(error);
  const peers = project ? workspace.runtime.filter(r => r.id !== activeId && workspace.sessions.find(s => s.id === r.id)?.projectId === project.id) : [];
  $('peer-indicator').hidden = !peers.length; $('peer-indicator').querySelector('span').textContent = `${peers.length + 1} sessions`;
  $('peer-indicator').title = 'Same-project sessions share coordination notices and project memory.';
  $('session-caption').textContent = state?.sending ? 'Sending…' : busy ? 'Enter to queue a follow-up · Esc to stop' : session ? 'Enter to send · Shift Enter for a new line' : 'Local files · persistent project memory';
  const stats = state?.stats;
  $('usage-caption').textContent = stats ? `${Number(stats.tokens?.total || 0).toLocaleString()} tokens · ${stats.costLabel || `$${Number(stats.cost || 0).toFixed(3)}`} total` : '';
  $('welcome-project').hidden = Boolean(session);
  $('welcome').hidden = Boolean(state?.messages.length);
  $('welcome').querySelector('h1').textContent = archived ? 'A little room to think.' : 'What are we building?';
}
async function newSession(projectId) {
  if (!projectId) projectId = current()?.projectId || workspace.projects[0]?.id;
  if (!projectId) { const project = await api.chooseProject(); if (!project) return; projectId = project.id; }
  archived = false;
  const session = await api.createSession(projectId);
  await openSession(session.id);
}
async function openSession(id) {
  if (current()?.id === id && !conversationOf(id).error && workspace.runtime.some(r => r.id === id)) { hideSidebarOnNarrow(); $('prompt').focus(); return; }
  saveView();
  const version = ++switchVersion;
  activeId = id; opening = true;
  const session = workspace.sessions.find(s => s.id === id);
  const pendingView = viewOf(id);
  pendingView.replay = []; pendingView.pendingHistory = true;
  $('prompt').value = session?.draft || ''; resizePrompt(); renderAttachments(); $('messages').replaceChildren();
  conversationOf(id).error = '';
  renderSidebar(); renderMessages(true); renderChrome(); hideSidebarOnNarrow();
  try {
    const result = await api.openSession(id, Boolean(conversationOf(id).loaded));
    if (version !== switchVersion || activeId !== id) return;
    // The worker emits during initialization. get_messages is authoritative at
    // its response boundary, and deltas arriving afterwards continue the reducer.
    const previous = conversationOf(id);
    const state = result.messages ? createConversation([...result.messages, ...(result.streamingMessage ? [result.streamingMessage] : [])]) : previous;
    if (result.messages) { state.historyBefore = result.before; state.hasMore = result.hasMore; }
    state.loaded = true;
    Object.assign(state, { model: result.state.model, thinkingLevel: result.state.thinkingLevel, busy: result.state.isStreaming, activities: previous.activities, stats: previous.stats });
    if (state.busy) {
      const last = [...state.messages].reverse().find(m => m.kind === 'assistant');
      if (last) state.streaming = last.key;
    }
    if (result.messages) for (const item of pendingView.replay) if (item.sequence > result.sequence) applyAgentEvent(state, item.event);
    pendingView.pendingHistory = false; pendingView.replay = [];
    conversations.set(id, state); viewOf(id).nodes.clear();
    // Keep at most eight loaded transcript caches. Closed/archived sessions are
    // released immediately; all history remains in the core's JSONL files.
    const other = [...conversations.keys()].filter(key => key !== id);
    while (other.length >= 8) { const oldest = other.shift(); conversations.delete(oldest); views.get(oldest)?.nodes.clear(); }
    opening = false; renderMessages(true); renderChrome(); renderActivity(); renderContext(); $('prompt').focus();
    // Totals come from the transcript, so a reopened session shows its cost before the next turn ends.
    api.stats(id).then(stats => { if (conversations.get(id) === state) { state.stats = stats; if (activeId === id) { renderChrome(); renderContext(); } } }).catch(() => {});
    showNextExtension();
  } catch (error) {
    if (version !== switchVersion || activeId !== id) return;
    pendingView.pendingHistory = false; pendingView.replay = [];
    conversationOf(id).error = safeError(error);
    if (version === switchVersion && activeId === id) { opening = false; renderChrome(); }
  }
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; requestAnimationFrame(() => { renderMessages(); renderChrome(); renderActivity(); }); }, 60);
}
function imageNodes(images) {
  const group = element('div', 'message-images');
  for (const part of images.slice(0, 8)) {
    const image = element('img'); image.src = `data:${part.mimeType};base64,${part.data}`; image.alt = 'Session image'; image.loading = 'lazy';
    image.onload = () => { if (activeId && viewOf(activeId).pinned) scrollToLatest(); };
    group.append(image);
  }
  return group;
}
function toolSummary(message) {
  const args = message.args || {};
  const detail = args.path || args.file || args.query || args.command || args.action || '';
  return `${message.name || 'Tool'}${detail ? ` · ${strip(detail).slice(0, 130).replace(/\s+/g, ' ')}` : ''}`;
}
function renderMessage(message, existing) {
  const node = existing || element('article', `message ${message.kind}`);
  node.dataset.key = message.key;
  if (String(message.revision) === node.dataset.revision && existing) return node;
  const wasOpen = node.querySelector('details')?.open;
  const oldDetails = node.querySelector('.thinking')?.open;
  node.replaceChildren(); node.dataset.revision = String(message.revision);
  if (message.kind === 'tool') {
    const details = element('details', 'tool-card'); details.open = wasOpen || false; details.dataset.status = message.status;
    const summary = element('summary'); summary.append(icon(toolIcon(message.name)), element('span', 'tool-title', toolSummary(message)), icon(message.status === 'done' ? 'check' : message.status === 'error' ? 'close' : 'dots', 'tool-state'));
    summary.setAttribute('aria-label', `${toolSummary(message)}, ${message.status}`);
    const output = element('div', 'tool-output', strip(message.output) || (message.status === 'running' ? 'Running…' : 'Complete'));
    details.append(summary, output); if (message.images?.length) details.append(imageNodes(message.images)); node.append(details);
  } else if (message.kind === 'user') {
    if (messageText(message)) node.append(element('div', 'user-bubble', messageText(message)));
    if (imageParts(message).length) node.append(imageNodes(imageParts(message)));
    if (message.optimistic) node.append(element('small', 'empty-hint', message.delivery || 'Queued'));
    if (message.failed) {
      const restore = element('button', 'quiet-button', 'Not sent · restore draft');
      restore.onclick = () => setEditorDraft(activeId, messageText(message) + ($('prompt').value ? `\n\n${$('prompt').value}` : ''), true); node.append(restore);
    }
  } else if (message.kind === 'assistant') {
    const label = element('div', 'assistant-label'); const rat = element('img'); rat.src = 'assets/rat.svg'; rat.alt = ''; label.append(rat, element('span', '', 'YunusPi')); node.append(label);
    const thinking = Array.isArray(message.content) ? message.content.filter(p => p?.type === 'thinking').map(p => p.thinking).join('\n') : '';
    if (thinking) {
      const details = element('details', 'thinking'); details.open = oldDetails || false; details.append(element('summary', '', 'Thought process'), element('div', 'thinking-body', thinking.slice(0, 24000))); node.append(details);
    }
    const body = element('div', 'prose'); body.append(markdown(messageText(message).slice(0, 500_000), url => tryAction(() => api.openExternal(url)))); node.append(body);
    if (imageParts(message).length) node.append(imageNodes(imageParts(message)));
    if (message.error) node.append(element('p', 'empty-hint', strip(message.error)));
  } else {
    if (messageText(message)) node.append(element('p', '', strip(messageText(message))));
    if (imageParts(message).length) node.append(imageNodes(imageParts(message)));
  }
  return node;
}
function renderMessages(restore = false) {
  if (!activeId) { $('messages').replaceChildren(); $('load-earlier').hidden = true; renderChrome(); return; }
  const state = conversationOf(activeId), view = viewOf(activeId), scroller = $('conversation');
  const beforeHeight = scroller.scrollHeight, beforeTop = scroller.scrollTop;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const anchor = [...$('messages').children].find(node => node.getBoundingClientRect().bottom > scrollerTop);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const visible = state.messages.slice(-view.limit).filter(message => message.kind !== 'assistant' || messageText(message) || imageParts(message).length || (Array.isArray(message.content) && message.content.some(part => part?.type === 'thinking' && part.thinking)));
  const keep = new Set(visible.map(m => m.key));
  for (const [key, node] of view.nodes) if (!keep.has(key)) { node.remove(); view.nodes.delete(key); }
  let previous = null;
  for (const message of visible) {
    const node = renderMessage(message, view.nodes.get(message.key)); view.nodes.set(message.key, node);
    if (node.parentNode !== $('messages')) $('messages').append(node);
    else if (previous && previous.nextSibling !== node) previous.after(node);
    previous = node;
  }
  $('load-earlier').hidden = !state.hasMore && state.messages.length <= view.limit;
  renderChrome();
  if (restore) scroller.scrollTop = view.pinned ? scroller.scrollHeight : view.top;
  else if (view.loadingEarlier) {
    if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else scroller.scrollTop = beforeTop + scroller.scrollHeight - beforeHeight;
    view.loadingEarlier = false;
  }
  else if (view.pinned) scroller.scrollTop = scroller.scrollHeight;
  view.lastClientHeight = scroller.clientHeight;
  updateJumpPosition();
  $('jump-bottom').hidden = view.pinned || !state.messages.length;
}
function scrollToLatest() {
  if (activeId) viewOf(activeId).pinned = true;
  $('conversation').scrollTop = $('conversation').scrollHeight; $('jump-bottom').hidden = true;
}
function updateJumpPosition() {
  const shell = document.querySelector('.conversation-shell').getBoundingClientRect();
  const scroller = $('conversation').getBoundingClientRect();
  $('jump-bottom').style.top = `${Math.max(6, scroller.bottom - shell.top - 42)}px`;
}
function renderActivity() {
  const list = $('activity-list'), state = activeId ? conversationOf(activeId) : null;
  if (!state?.activities.length) { list.replaceChildren(element('p', 'empty-hint', 'Tool runs and file changes appear here.')); return; }
  const fragment = document.createDocumentFragment();
  for (const activity of state.activities) {
    const row = element('div', 'activity-row'); row.append(icon(toolIcon(activity.name)));
    const detail = element('div'); detail.append(element('span', '', activity.name), element('small', '', strip(activity.path).slice(0, 100) || activity.status)); row.append(detail); fragment.append(row);
  }
  list.replaceChildren(fragment);
}
function contextCard(title, symbol, text) {
  const card = element('div', 'context-card'), heading = element('h3'); heading.append(icon(symbol), document.createTextNode(title)); card.append(heading); if (text) card.append(element('p', '', text)); return card;
}
function renderContext() {
  const fragment = document.createDocumentFragment(), session = current(), project = projectOf(session);
  if (!session) fragment.append(element('p', 'empty-hint', 'Open a session to see its context.'));
  else {
    const state = conversationOf(activeId);
    fragment.append(contextCard('Project', 'folder', project?.path));
    fragment.append(contextCard('Memory', 'memory', 'Session history is private to this conversation. Project notes and the source-linked vector index are shared by sessions in this project.'));
    const peers = workspace.runtime.filter(r => r.id !== activeId && workspace.sessions.find(s => s.id === r.id)?.projectId === session.projectId);
    const collaboration = contextCard('Collaboration', 'people', peers.length ? `${peers.length} peer session${peers.length > 1 ? 's' : ''}. Same-project peer notices and overlapping-file safeguards run automatically at agent boundaries.` : 'New sessions in this project automatically join the existing coordination layer.');
    for (const peer of peers) { const p = workspace.sessions.find(s => s.id === peer.id); const button = element('button', 'quiet-button', p.title); button.onclick = () => tryAction(() => openSession(peer.id)); collaboration.append(button); } fragment.append(collaboration);
    const resources = contextCard('Skills & tools', 'compass', 'Available through the harness’s on-demand discovery. Tool schemas enter context when needed.');
    const browse = element('button', 'quiet-button', 'Browse commands'); browse.onclick = () => tryAction(showCommands); resources.append(browse); fragment.append(resources);
    if (state.stats) fragment.append(contextCard('This session', 'chat', `${state.stats.userMessages} requests · ${state.stats.toolCalls} tool calls · ${state.stats.totalMessages} messages`));
    if (state.stats?.costLabel) {
      const parts = Object.entries({ Main: state.stats.costParts?.main, Delegated: state.stats.costParts?.delegated, Helpers: state.stats.costParts?.helpers }).filter(([, cost]) => cost > 0);
      fragment.append(contextCard('Total cost', 'chat', `${state.stats.costLabel}${parts.length > 1 ? ` · ${parts.map(([name, cost]) => `${name} $${cost.toFixed(3)}`).join(' · ')}` : ''}`));
    }
    for (const [key, value] of viewOf(activeId).widgets) {
      if (!value) continue;
      fragment.append(contextCard(strip(key).slice(0, 70), 'file', strip(value).slice(0, 1500)));
    }
  }
  $('context-content').replaceChildren(fragment);
}
function resizePrompt() { const prompt = $('prompt'); prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, Math.min(200, innerHeight * .25))}px`; renderChrome(); }
function renderAttachments() {
  const fragment = document.createDocumentFragment();
  for (const [index, part] of (attachments.get(activeId) || []).entries()) {
    const item = element('div', 'attachment'), image = element('img'); image.src = `data:${part.mimeType};base64,${part.data}`; image.alt = part.name || 'Attached image';
    const remove = element('button'); remove.append(icon('close')); remove.setAttribute('aria-label', `Remove ${part.name || 'image'}`); remove.onclick = () => { attachments.get(activeId).splice(index, 1); renderAttachments(); renderChrome(); };
    item.append(image, remove); fragment.append(item);
  }
  $('attachment-list').replaceChildren(fragment);
}
async function sendPrompt(event) {
  event?.preventDefault();
  const id = activeId, session = current(); if (!session || opening) return;
  const state = conversationOf(id); if (state.sending) return;
  const message = $('prompt').value.trim(), images = [...(attachments.get(id) || [])];
  if (!message && !images.length) return;
  if (/^\/models?\s*$/.test(message)) { setEditorDraft(id, ''); return showModels(); }
  if (/^\/(metrics|cost|self|session)\s*$/.test(message)) { setEditorDraft(id, ''); setWorkbench(true, 'context'); state.stats = await api.stats(id); renderContext(); return; }
  if (/^\/(skills|tools|help)\s*$/.test(message)) { setEditorDraft(id, ''); return showCommands(); }
  state.sending = true; state.error = '';
  const optimistic = { key: crypto.randomUUID(), kind: 'user', content: [{ type: 'text', text: message }, ...images.map(({ name, ...part }) => part)], optimistic: true, delivery: state.busy ? 'Queued' : 'Sending…', revision: 0 };
  state.messages.push(optimistic); viewOf(id).pinned = true;
  session.draft = '';
  $('prompt').value = ''; attachments.set(id, []); renderAttachments(); resizePrompt(); renderMessages();
  try {
    await api.prompt(id, message, images.map(({ name, ...part }) => part));
    if (message.startsWith('/') && optimistic.optimistic) { optimistic.optimistic = false; optimistic.revision++; }
  }
  catch (error) {
    state.error = safeError(error);
    const pending = state.messages.find(m => m.key === optimistic.key && m.optimistic);
    if (pending) { pending.failed = true; pending.optimistic = false; pending.revision++; }
    if (!workspace.sessions.find(s => s.id === id)?.draft && !(attachments.get(id)?.length)) {
      setEditorDraft(id, message); attachments.set(id, images);
      if (activeId === id) renderAttachments();
    }
  } finally { state.sending = false; if (activeId === id) { renderMessages(); renderChrome(); } }
}

function closeModal(cancelled = true) {
  clearTimeout(modalTimer); modalTimer = null;
  const cancel = modalCancel; modalCancel = null; modalOwner = null;
  if ($('dialog').open) $('dialog').close();
  $('dialog-content').replaceChildren();
  if (cancelled) cancel?.();
  queueMicrotask(showNextExtension);
}
function modal(title, build, onCancel) {
  if ($('dialog').open) closeModal();
  modalCancel = onCancel; $('dialog-title').textContent = title; $('dialog-content').replaceChildren();
  build($('dialog-content')); $('dialog').showModal();
}
function actionButton(label, symbol, handler, danger = false) {
  const button = element('button', danger ? 'danger' : ''); button.append(icon(symbol), element('span', '', label)); button.onclick = () => { closeModal(false); tryAction(handler); }; return button;
}
function showSessionMenu(id) {
  const session = workspace.sessions.find(s => s.id === id); if (!session) return;
  modal(session.title, content => {
    const list = element('div', 'dialog-list');
    if (session.state === 'archived') list.append(actionButton('Restore session', 'restore', () => api.sessionAction(id, 'restore')));
    else {
      list.append(actionButton(session.state === 'closed' ? 'Open session' : 'Close session', session.state === 'closed' ? 'chat' : 'close', () => session.state === 'closed' ? openSession(id) : api.sessionAction(id, 'close')));
      list.append(actionButton('Rename', 'file', () => renameSession(id)));
      list.append(actionButton('Archive session', 'archive', () => api.sessionAction(id, 'archive')));
      list.append(actionButton('Export conversation…', 'export', async () => { await openSession(id); return api.exportSession(id); }));
    }
    list.append(element('hr'), actionButton('Delete session…', 'trash', () => api.sessionAction(id, 'delete'), true)); content.append(list);
  });
}
function renameSession(id) {
  const session = workspace.sessions.find(s => s.id === id); if (!session) return;
  modal('Rename session', content => {
    const form = element('form'), input = element('input'); input.value = session.title; input.maxLength = 120; input.setAttribute('aria-label', 'Session name');
    const actions = element('div', 'dialog-actions'), save = element('button', 'primary-button', 'Save'); save.type = 'submit'; actions.append(save); form.append(input, actions);
    form.onsubmit = event => { event.preventDefault(); tryAction(async () => { await api.updateSession(id, { title: input.value }); closeModal(false); }); }; content.append(form); queueMicrotask(() => { input.focus(); input.select(); });
  });
}
async function showModels() {
  const id = activeId; if (!id) return;
  const { models } = await api.models(id);
  modal('Choose a model', content => {
    const search = element('input', 'dialog-search'); search.type = 'search'; search.placeholder = 'Search models or providers'; search.setAttribute('aria-label', 'Search models');
    const list = element('div', 'dialog-list');
    const draw = () => {
      list.replaceChildren(); const query = search.value.toLocaleLowerCase();
      for (const model of models.filter(m => `${m.name} ${m.id} ${m.provider}`.toLocaleLowerCase().includes(query)).slice(0, 150)) {
        const button = element('button'), name = element('span', '', model.name || model.id); name.append(element('small', '', `${model.provider} · ${model.id}`)); button.append(name);
        if (conversationOf(id).model?.id === model.id && conversationOf(id).model?.provider === model.provider) button.append(icon('check'));
        button.onclick = () => tryAction(async () => { await api.setModel(id, model.provider, model.id); closeModal(false); }); list.append(button);
      }
      if (!list.childNodes.length) list.append(element('p', 'empty-hint', 'No configured models match. Add a provider in Settings.'));
    };
    search.oninput = draw; content.append(search, list); draw();
  });
}
async function showThinking() {
  const id = activeId; if (!id) return;
  const { levels } = await api.models(id);
  modal('Thinking level', content => { const list = element('div', 'dialog-list'); for (const level of levels) list.append(actionButton(level[0].toUpperCase() + level.slice(1), 'brain', async () => { await api.setThinking(id, level); conversationOf(id).thinkingLevel = level; renderChrome(); })); content.append(list); });
}
async function showCommands() {
  const id = activeId; if (!id) { toast('Open a project session first.'); return; }
  const { commands } = await api.commands(id);
  modal('Skills & commands', content => {
    const search = element('input', 'dialog-search'); search.type = 'search'; search.placeholder = 'Find a skill or command'; search.setAttribute('aria-label', 'Search skills and commands'); const list = element('div', 'dialog-list');
    const draw = () => {
      list.replaceChildren();
      for (const command of commands.filter(c => `${c.name} ${c.description ?? ''}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).slice(0, 150)) {
        const button = element('button'), detail = element('span', '', `/${command.name}`); detail.append(element('small', '', command.description || command.source)); button.append(icon('compass'), detail);
        button.onclick = () => { closeModal(false); setEditorDraft(id, `/${command.name} `, true); }; list.append(button);
      }
    }; search.oninput = draw; content.append(search, list); draw();
  });
}
function showSettings() {
  modal('Settings', content => {
    content.append(element('p', '', `YunusPi ${workspace.version || ''} · Desktop`));
    const data = element('button', 'quiet-button'); data.append(icon('folder'), document.createTextNode('Open workspace data')); data.onclick = () => tryAction(() => api.openData()); content.append(data);
    const imported = element('button', 'quiet-button'); imported.append(icon('restore'), document.createTextNode('Import existing session…')); imported.onclick = () => { closeModal(false); tryAction(importSession); }; content.append(imported);
    content.append(element('p', '', 'Existing provider credentials are reused. Add an API key to the harness’s locked credential store.'));
    const form = element('form'), providerLabel = element('label', '', 'Provider ID'), provider = element('input'); provider.id = 'provider-id'; provider.placeholder = 'openai, anthropic, openrouter…'; provider.autocomplete = 'off'; providerLabel.htmlFor = provider.id;
    const keyLabel = element('label', '', 'API key'), key = element('input'); key.id = 'provider-key'; key.type = 'password'; key.autocomplete = 'new-password'; keyLabel.htmlFor = key.id;
    const status = element('p'); status.setAttribute('role', 'status'); const actions = element('div', 'dialog-actions'), save = element('button', 'primary-button', 'Save provider'); save.type = 'submit'; actions.append(save);
    form.append(providerLabel, provider, keyLabel, key, status, actions);
    form.onsubmit = event => { event.preventDefault(); save.disabled = true; void api.saveCredential(provider.value.trim(), key.value).then(() => { key.value = ''; status.textContent = 'Saved. Reconnect a session to load the provider.'; }).catch(error => { status.textContent = safeError(error); }).finally(() => { save.disabled = false; }); }; content.append(form);
  });
}
async function importSession() { const session = await api.importSession(); if (session) { archived = false; await openSession(session.id); } }
function showProjects() {
  modal('Projects', content => {
    const list = element('div', 'dialog-list');
    for (const project of workspace.projects) list.append(actionButton(project.name, 'folder', () => newSession(project.id)));
    list.append(element('hr'), actionButton('Open another project…', 'plus', async () => { const project = await api.chooseProject(); if (project) await newSession(project.id); })); content.append(list);
  });
}
function setSidebar(open) {
  if (open && innerWidth <= 850 && !$('workbench').hidden) setWorkbench(false);
  if (innerWidth <= 850) { $('app').classList.toggle('sidebar-open', open); $('app').classList.remove('sidebar-hidden'); $('sidebar-scrim').hidden = !open; }
  else { $('app').classList.toggle('sidebar-hidden', !open); $('app').classList.remove('sidebar-open'); $('sidebar-scrim').hidden = true; }
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  updatePanelInert();
  if (open && innerWidth <= 850) $('new-session').focus();
}
function hideSidebarOnNarrow() { if (innerWidth <= 850) setSidebar(false); }
function setWorkbench(open, tab = 'activity') {
  if (open && innerWidth <= 850) setSidebar(false);
  $('workbench').hidden = !open; $('workbench-toggle').setAttribute('aria-expanded', String(open));
  if (open) setTab(tab);
  updatePanelInert();
  if (open && innerWidth <= 1200) $('workbench-close').focus();
}
function updatePanelInert() {
  const sidebar = innerWidth <= 850 && $('app').classList.contains('sidebar-open');
  const workbench = innerWidth <= 1200 && !$('workbench').hidden;
  $('main').inert = sidebar || workbench;
  $('sidebar').inert = workbench && !sidebar;
  $('workbench-scrim').hidden = !workbench;
  $('workbench').setAttribute('role', workbench ? 'dialog' : 'complementary');
  if (workbench) $('workbench').setAttribute('aria-modal', 'true'); else $('workbench').removeAttribute('aria-modal');
}
function setTab(tab) {
  for (const name of ['activity', 'context']) { const selected = name === tab; $(`${name}-tab`).setAttribute('aria-selected', String(selected)); $(`${name}-tab`).tabIndex = selected ? 0 : -1; $(`${name}-panel`).hidden = !selected; }
  if (tab === 'context') renderContext(); else renderActivity();
}
function showNextExtension() {
  if ($('dialog').open || opening) return;
  const index = extensionQueue.findIndex(q => q.sessionId === activeId); if (index < 0) return;
  const request = extensionQueue.splice(index, 1)[0], { sessionId, event } = request;
  const respond = response => tryAction(() => api.extensionResponse(sessionId, { id: event.id, ...response }));
  modal(strip(event.title || 'YunusPi'), content => {
    if (event.message) content.append(element('p', '', strip(event.message)));
    if (event.method === 'select') {
      const list = element('div', 'dialog-list');
      for (const option of event.options || []) list.append(actionButton(strip(option), 'check', () => respond({ value: option }))); content.append(list);
    } else if (event.method === 'confirm') {
      const actions = element('div', 'dialog-actions');
      for (const [label, confirmed] of [['Cancel', false], ['Continue', true]]) { const button = element('button', confirmed ? 'primary-button' : 'quiet-button', label); button.onclick = () => { closeModal(false); respond({ confirmed }); }; actions.append(button); } content.append(actions);
    } else {
      const form = element('form'), input = element(event.method === 'editor' ? 'textarea' : 'input'); input.value = event.prefill || ''; input.placeholder = event.placeholder || ''; input.setAttribute('aria-label', event.title || 'Response');
      const actions = element('div', 'dialog-actions'), save = element('button', 'primary-button', 'Continue'); save.type = 'submit'; actions.append(save); form.append(input, actions); form.onsubmit = e => { e.preventDefault(); closeModal(false); respond({ value: input.value }); }; content.append(form);
    }
  }, () => respond({ cancelled: true }));
  modalOwner = { sessionId, requestId: event.id };
  if (event.timeout) modalTimer = setTimeout(() => { if (modalOwner?.requestId === event.id && $('dialog').open) closeModal(); }, Math.min(event.timeout, 2_147_483_647));
}
function extensionRequest(sessionId, event) {
  const view = viewOf(sessionId);
  if (event.method === 'notify') { if (sessionId === activeId) toast(strip(event.message)); return; }
  if (event.method === 'setWidget') {
    if (!event.widgetLines) view.widgets.delete(event.widgetKey); else { if (view.widgets.size >= 16 && !view.widgets.has(event.widgetKey)) view.widgets.delete(view.widgets.keys().next().value); view.widgets.set(event.widgetKey, event.widgetLines.join('\n')); }
    if (sessionId === activeId) renderContext(); return;
  }
  if (event.method === 'setStatus') { if (event.statusText) view.widgets.set(event.statusKey, event.statusText); else view.widgets.delete(event.statusKey); return; }
  if (event.method === 'set_editor_text') { setEditorDraft(sessionId, event.text || ''); return; }
  if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
    if (extensionQueue.length >= 32) { tryAction(() => api.extensionResponse(sessionId, { id: event.id, cancelled: true })); return; }
    extensionQueue.push({ sessionId, event });
    if (sessionId !== activeId) toast(`${workspace.sessions.find(s => s.id === sessionId)?.title || 'Another session'} needs input.`);
    showNextExtension();
  }
}
async function handleShortcut(action) {
  switch (action) {
    case 'newSession': return newSession();
    case 'openProject': { const project = await api.chooseProject(); if (project) return newSession(project.id); break; }
    case 'closeSession': if (activeId) return api.sessionAction(activeId, 'close'); break;
    case 'importSession': return importSession();
    case 'settings': return showSettings();
    case 'search': setSidebar(true); $('session-search').focus(); break;
    case 'sidebar': setSidebar(innerWidth <= 850 ? !$('app').classList.contains('sidebar-open') : $('app').classList.contains('sidebar-hidden')); break;
    case 'help': modal('Keyboard shortcuts', content => { for (const [key, value] of [['Ctrl / ⌘ N', 'New session'], ['Ctrl / ⌘ O', 'Open project'], ['Ctrl / ⌘ K', 'Find sessions'], ['Ctrl / ⌘ B', 'Toggle sidebar'], ['Ctrl / ⌘ W', 'Close session'], ['Ctrl / ⌘ ,', 'Settings'], ['Enter', 'Send or queue follow-up'], ['Shift Enter', 'New line'], ['Escape', 'Close dialog or stop turn']]) { const row = element('p'); row.append(element('kbd', '', key), document.createTextNode(`  ${value}`)); content.append(row); } }); break;
  }
}

api.onEvent(value => {
  switch (value.type) {
    case 'workspace': syncWorkspace(value.data); break;
    case 'agent': {
      if (value.event.type === 'extension_ui_closed') {
        for (let index = extensionQueue.length - 1; index >= 0; index--) if (extensionQueue[index].event.id === value.event.id && extensionQueue[index].sessionId === value.sessionId) extensionQueue.splice(index, 1);
        if (modalOwner?.requestId === value.event.id && modalOwner.sessionId === value.sessionId) closeModal(false);
      }
      else if (value.event.type === 'extension_ui_request') extensionRequest(value.sessionId, value.event);
      else {
        const view = viewOf(value.sessionId);
        if (view.pendingHistory) view.replay.push({ event: value.event, sequence: value.sequence });
        applyAgentEvent(conversationOf(value.sessionId), value.event);
      }
      if (value.sessionId === activeId) scheduleRender();
      break;
    }
    case 'state': Object.assign(conversationOf(value.sessionId), { model: value.data.model, thinkingLevel: value.data.thinkingLevel, busy: value.data.isStreaming }); if (value.sessionId === activeId) renderChrome(); break;
    case 'stats': conversationOf(value.sessionId).stats = value.data; if (value.sessionId === activeId) { renderChrome(); renderContext(); } break;
    case 'failure': if (value.sessionId) {
      for (let index = extensionQueue.length - 1; index >= 0; index--) if (extensionQueue[index].sessionId === value.sessionId) extensionQueue.splice(index, 1);
      if (modalOwner?.sessionId === value.sessionId) closeModal(false);
      const state = conversationOf(value.sessionId); state.error = safeError(value.message); state.busy = false; if (value.sessionId === activeId) renderChrome();
    } else toast(value.message); break;
    case 'shortcut': tryAction(() => handleShortcut(value.action)); break;
    case 'open-session': tryAction(() => openSession(value.sessionId)); break;
  }
});
$('new-session').onclick = () => tryAction(() => newSession());
$('add-project').onclick = $('welcome-project').onclick = () => tryAction(async () => { const project = await api.chooseProject(); if (project) await newSession(project.id); });
$('project-button').onclick = showProjects;
$('session-menu').onclick = () => { if (activeId) showSessionMenu(activeId); };
$('session-search').oninput = renderSidebar;
$('archive-view').onclick = () => { archived = !archived; renderSidebar(); };
$('settings').onclick = showSettings;
$('composer').onsubmit = event => { event.preventDefault(); tryAction(() => sendPrompt()); };
$('prompt').oninput = () => {
  resizePrompt();
  if (activeId) setEditorDraft(activeId, $('prompt').value);
};
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); tryAction(() => sendPrompt()); } };
$('stop').onclick = () => { if (activeId) tryAction(() => api.abort(activeId)); };
$('model-button').onclick = () => tryAction(showModels);
$('thinking-button').onclick = () => tryAction(showThinking);
$('attach').onclick = () => { const id = activeId; if (!id) return; tryAction(async () => { const images = await api.chooseImages(); const next = [...(attachments.get(id) || []), ...images]; if (next.length > 6) throw Error('Attach at most six images.'); attachments.set(id, next); if (activeId === id) { renderAttachments(); renderChrome(); } }); };
$('retry-session').onclick = () => { if (activeId) tryAction(() => openSession(activeId)); };
$('conversation').addEventListener('scroll', () => {
  if (!activeId) return;
  const scroller = $('conversation'), view = viewOf(activeId);
  if (view.lastClientHeight === undefined || view.lastClientHeight === scroller.clientHeight) view.pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 70;
  view.lastClientHeight = scroller.clientHeight; view.top = scroller.scrollTop;
  $('jump-bottom').hidden = view.pinned || !conversationOf(activeId).messages.length;
}, { passive: true });
$('jump-bottom').onclick = scrollToLatest;
$('load-earlier').onclick = () => tryAction(async () => {
  const id = activeId; if (!id) return;
  const state = conversationOf(id), view = viewOf(id);
  if (state.hasMore && state.messages.length <= view.limit) {
    $('load-earlier').disabled = true;
    try {
      const page = await api.history(id, state.historyBefore);
      prependConversation(state, page.messages); state.historyBefore = page.before; state.hasMore = page.hasMore;
    } catch (error) {
      if (activeId !== id) return;
      throw error;
    } finally { $('load-earlier').disabled = false; }
  }
  view.limit += 80; view.loadingEarlier = true; if (activeId === id) renderMessages();
});
$('sidebar-toggle').onclick = () => handleShortcut('sidebar');
$('sidebar-close').onclick = $('sidebar-scrim').onclick = () => { setSidebar(false); $('sidebar-toggle').focus(); };
$('workbench-toggle').onclick = () => setWorkbench($('workbench').hidden);
$('workbench-close').onclick = () => { setWorkbench(false); $('workbench-toggle').focus(); };
$('workbench-scrim').onclick = $('workbench-close').onclick;
for (const tab of ['activity', 'context']) {
  $(`${tab}-tab`).onclick = () => setTab(tab);
  $(`${tab}-tab`).onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = tab === 'activity' ? 'context' : 'activity'; setTab(next); $(`${next}-tab`).focus(); } };
}
$('dialog-close').onclick = () => closeModal();
$('dialog').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
$('dialog').addEventListener('click', event => { if (event.target === $('dialog')) { const r = $('dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
document.addEventListener('keydown', event => {
  const panel = innerWidth <= 850 && $('app').classList.contains('sidebar-open') ? $('sidebar') : innerWidth <= 1200 && !$('workbench').hidden ? $('workbench') : null;
  if (event.key === 'Tab' && !$('dialog').open && panel) {
    const controls = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node => node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[hidden]'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  if (event.key === 'Escape' && !$('dialog').open) {
    if ($('app').classList.contains('sidebar-open')) { setSidebar(false); $('sidebar-toggle').focus(); }
    else if (!$('workbench').hidden) { setWorkbench(false); $('workbench-toggle').focus(); }
    else if (activeId && conversationOf(activeId).busy) tryAction(() => api.abort(activeId));
  }
});
for (const suggestion of document.querySelectorAll('[data-suggest]')) suggestion.onclick = () => tryAction(async () => {
  if (!activeId) await newSession();
  if (!activeId) return;
  setEditorDraft(activeId, { explore: 'Explore this project and explain how its main parts fit together.', build: 'Help me build ', improve: 'Find and fix the most useful improvements in this project.' }[suggestion.dataset.suggest], true);
});
let narrow = innerWidth <= 850;
new ResizeObserver(() => {
  updateJumpPosition();
  if (activeId && viewOf(activeId).pinned) scrollToLatest();
}).observe($('conversation'));
window.addEventListener('resize', () => { if (narrow !== (innerWidth <= 850)) { narrow = innerWidth <= 850; setSidebar(!narrow); } updatePanelInert(); resizePrompt(); if (activeId && viewOf(activeId).pinned) scrollToLatest(); });
document.addEventListener('dragover', event => { event.preventDefault(); });
async function attachFiles(files) {
  const id = activeId; if (!id || opening) { toast('Open a session before attaching images.'); return; }
  const selected = [...files];
  if (selected.some(file => !/^image\/(png|jpeg|webp|gif)$/.test(file.type))) throw Error('Attach PNG, JPEG, WebP or GIF images.');
  if (selected.length + (attachments.get(id)?.length || 0) > 6 || selected.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) throw Error('Attach up to six images, at most 10 MiB together.');
  const images = await Promise.all(selected.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(Error('This image could not be read.'));
    reader.onload = () => resolve({ type: 'image', mimeType: file.type, data: String(reader.result).split(',')[1], name: file.name || 'Pasted image' }); reader.readAsDataURL(file);
  })));
  const combined = [...(attachments.get(id) || []), ...images];
  if (combined.reduce((sum, image) => sum + image.data.length, 0) > 14_000_000) throw Error('Attachments together must be smaller than 10 MiB.');
  attachments.set(id, combined);
  if (activeId === id) { renderAttachments(); renderChrome(); }
}
document.addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer?.files.length) tryAction(() => attachFiles(event.dataTransfer.files)); });
$('prompt').addEventListener('paste', event => { if (event.clipboardData?.files.length) { event.preventDefault(); tryAction(() => attachFiles(event.clipboardData.files)); } });
setSidebar(!narrow);
try { syncWorkspace(await api.snapshot()); if (workspace.activeId) await openSession(workspace.activeId); else renderChrome(); }
catch (error) { toast(safeError(error)); }
renderActivity();
