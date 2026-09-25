/** Keep specialized schemas out of the initial prompt without removing their
 * capabilities. Discovery changes schema exposure only; it never runs a tool
 * or grants access outside the host's original active/allowed tool set. */
import { Type } from 'typebox';
import { CAPABILITY_GROUPS, capabilityGroup, groupOverview, searchCapabilityMetadata } from './capability-groups.ts';
import { browseCapabilities, searchCapabilities, getCapabilityDetail } from './harness-capabilities.ts';
import { askJev, jevMark, tooShort } from './jev-client.ts';
import { needleRank } from './needle-runtime.ts';
import { multiStageRetrieve } from './micro-intelligence/retrieval.ts';
import { skillActionSegments, skillRoutes } from './skill-routing.ts';

/** Multi-stage re-rank: lexical order -> Needle semantic ranking -> Jev
 * validation when uncertain. Single candidates, trivial queries and
 * low-confidence judgments stay on the lexical order. Needle reordering is
 * local (no API spend); a Jev reorder carries its ledger mark. */
async function rerankWithJev<T>(
  kind: string,
  query: string,
  matches: readonly T[],
  idOf: (item: T) => string,
  textOf: (item: T) => string,
  pi: unknown,
  signal?: AbortSignal,
): Promise<{ matches: T[]; info?: { mark: string; top: string; confidence: number } } | undefined> {
  try {
    if (tooShort(query, 3) || matches.length < 2) return undefined;
    // A named capability is already an unambiguous selection. Semantic
    // ranking cannot improve it and must not demote it or spend inference.
    const identity = (text: string) => text.trim().toLowerCase().replace(/[\s_:/.]+/g, '-').replace(/-+/g, '-');
    if (matches.some(item => identity(idOf(item)) === identity(query))) return undefined;
    const lexical = matches.map((item) => ({ id: idOf(item), text: textOf(item), item }));
    const outcome = await multiStageRetrieve({
      kind, site: 'rank', query, lexical,
      needle: (needleQuery, candidates, topK) => needleRank({ query: needleQuery, candidates, topK }),
      jev: (site, state, questions) => askJev(site, state, questions, { pi, signal }),
      jevMark: (site, detail, usage) => jevMark(site, detail, usage),
    });
    if (outcome.applied === 'lexical') return undefined;
    const ordered = outcome.ordered.map((entry) => entry.item);
    if (outcome.applied === 'jev' && outcome.mark && outcome.jevTop !== undefined && outcome.jevConfidence !== undefined) {
      return { matches: ordered, info: { mark: outcome.mark, top: outcome.jevTop, confidence: outcome.jevConfidence } };
    }
    return { matches: ordered };
  } catch {
    return undefined;
  }
}
const RECEIPT = 'harness-tool-activation-v1';
const RESUME_TOOLS = 6;
const DISCOVERY_PAGE = 8;
// Historical discovery is not a permanent schema subscription. Retain a small
// recent working set and every unresolved call, without rewriting session history.
export function restoredToolNames(entries: any[], allowed: Set<string>): Set<string> {
  const recent = new Set<string>(), pending = new Map<string,string>();
  const branch = entries.slice(-2000);
  for (const entry of branch) {
    const message = entry.type === 'message' ? entry.message : undefined;
    if (entry.type === 'compaction' || message?.role === 'compactionSummary' || message?.role === 'user' || message?.role === 'assistant') pending.clear();
    if (message?.role === 'assistant' && Array.isArray(message.content))
      for (const call of message.content) if (call.type === 'toolCall' && typeof call.id === 'string' && allowed.has(call.name)) pending.set(call.id,call.name);
    if (message?.role === 'toolResult') pending.delete(message.toolCallId);
  }
  let messages = 0;
  const remember = (name: unknown) => {
    if (typeof name === 'string' && allowed.has(name) && !CORE_TOOLS.has(name) && recent.size < RESUME_TOOLS) recent.add(name);
  };
  for (const entry of branch.toReversed()) {
    if (entry.type === 'message' && ++messages > 12) break;
    if (entry.type === 'message' && entry.message?.role === 'toolResult') remember(entry.message.toolName);
    if (entry.type === 'custom' && entry.customType === RECEIPT && Array.isArray(entry.data?.names))
      for (const name of entry.data.names.slice(-128).toReversed()) remember(name);
  }
  for (const name of pending.values()) recent.add(name);
  return recent;
}
export const CORE_TOOLS = new Set([
  'read','bash','edit','write','grep','find','ls','tool_search',
  'session_self','subagent','bg_wait','quality_review','skill_review',
  // These readers are dependencies of existing context/safety hook owners.
  'project_intel','project_tests','obs_read','checkpoint_read','todo',
  'project_report','module_report','symbol_search','context_slice',
  // Local ML/statistical salience. The relevant-guidance owner only delivers a
  // utility hint when the tool is already active, so leaving these to lazy
  // discovery made their shipped guidance unreachable.
  'context_score','handoff_capsule','evidence_cache',
  // The bash tool description unconditionally points at explicit background
  // work through bg_run/bg_status/bg_logs/bg_kill; keep the quartet with bg_wait.
  'bg_run','bg_status','bg_logs','bg_kill',
]);
/** Prompts that unmistakably need a specialized studio stage its tools for
 * the first model turn: one schema bundle instead of a discovery round trip
 * the agent may not think to make. Intents come from the skill routing table
 * (one source of truth); attached images count as the reference for an
 * image-to-code request. Everything else stays lazily discoverable. */
export const INTENT_BUNDLES: ReadonlyArray<{ skill: string; tools: readonly string[] }> = [
  { skill: 'mockup-to-code', tools: ['image_analyze', 'image_crop', 'image_trace', 'visual_diff', 'render_see'] },
  { skill: 'code-first-video', tools: ['video_project', 'video_render', 'video_qa', 'narration_tts', 'audio_synth'] },
  { skill: 'key-visual-art-direction', tools: ['scene_create', 'scene_render', 'video_compose'] },
];
// Intents without a skill route: quality work stages the measurement tools,
// commits stage the pre-commit review, copy and docs stage the prose check.
const DIRECT_BUNDLES: ReadonlyArray<{ pattern: RegExp; tools: readonly string[] }> = [
  { pattern: /\b(?:refactor\w*|clean ?up|de-?dup\w*|duplicat\w* (?:code|logic)|dry (?:up|principle|violations?)|dead code|unused (?:code|imports?|exports?)|code (?:quality|review|smells?)|lint(?:ing|er|s)?|cyclomatic|complexity|slop|tech(?:nical)? debt|simplif(?:y|ication) (?:the |this )?code)\b/i, tools: ['code_quality', 'git_info'] },
  { pattern: /\b(?:commit(?:ting)?|pull request|open (?:a )?pr|push (?:it|the|this|to)|ready to (?:merge|ship)|pre-?commit)\b/i, tools: ['git_info'] },
  { pattern: /\b(?:desktop (?:app|application|gui|window)s?|electron app|gtk|pyqt|pyside|qt (?:app|widget|window)s?|tkinter|wxpython|x11 (?:app|window)s?|gui (?:app|application|test)s?)\b/i, tools: ['desktop_session'] },
  { pattern: /\b(?:copywriting|(?:landing|marketing|sales|product) (?:page )?copy|blog post|newsletter|press release|release notes|proofread|rewrite (?:the |this )?(?:text|copy|prose|docs?)|readme|documentation)\b/i, tools: ['code_quality'] },
];
const WEB_TARGET = /\b(?:websites?|web ?pages?|landing pages?|home ?pages?|sites?|pages?|html|css|tailwind|react|vue|svelte|components?|ui|front-?end|layout|app screens?)\b/i;
const IMAGE_ASK = /\b(?:this|these|attached|like|match\w*|same|similar|based on|from|recreate|replicate|clone|turn|convert|build|make|implement|copy)\b/i;
export function intentBundleTools(prompt: unknown, images = 0): string[] {
  const text = String(prompt ?? '').slice(0, 32768);
  if (!text.trim()) return [];
  const segments = skillActionSegments(text), out = new Set<string>();
  for (const bundle of INTENT_BUNDLES) {
    const route = skillRoutes.find(candidate => candidate.name === bundle.skill);
    const routed = !!route && segments.some(part => route.intent.test(route.pathIntent ? part : part.replace(/(?:\S*\/)+\S*/g, ' ')));
    const pictured = bundle.skill === 'mockup-to-code' && images > 0 && WEB_TARGET.test(text) && IMAGE_ASK.test(text);
    if (routed || pictured) for (const name of bundle.tools) out.add(name);
  }
  for (const bundle of DIRECT_BUNDLES) if (segments.some(part => bundle.pattern.test(part))) for (const name of bundle.tools) out.add(name);
  return [...out];
}
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(name => b.has(name));
const safeOffset = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
const pageLimit = (value: unknown, fallback = 3) => Number.isSafeInteger(value)
  ? Math.min(DISCOVERY_PAGE, Math.max(1, value as number)) : fallback;

function boundedSourceInfo(info: any): any {
  if (!info || typeof info !== 'object') return undefined;
  const result: any = {};
  for (const key of ['path', 'source', 'scope', 'origin', 'baseDir']) {
    if (typeof info[key] === 'string') result[key] = info[key].slice(0, 512);
  }
  return Object.keys(result).length ? result : undefined;
}

function commandSourceGroups(commands: readonly any[]) {
  const counts = new Map<string, number>([['extension', 0], ['prompt', 0], ['skill', 0]]);
  for (const command of commands) {
    if (typeof command?.source !== 'string') continue;
    counts.set(command.source, (counts.get(command.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({id, label: id[0].toUpperCase() + id.slice(1), count}));
}

function commandMetadata(command: any, detail = false) {
  const result: any = {
    name: String(command.name).slice(0, 256),
    description: String(command.description ?? '').slice(0, detail ? 512 : 160),
    source: typeof command.source === 'string' ? command.source.slice(0, 64) : 'unknown',
  };
  if (detail) {
    const sourceInfo = boundedSourceInfo(command.sourceInfo);
    if (sourceInfo) result.sourceInfo = sourceInfo;
  }
  return result;
}

function normalizedCommandCatalog(pi: any): any[] | undefined {
  if (typeof pi.getCommands !== 'function') return undefined;
  let commands: unknown;
  try { commands = pi.getCommands(); } catch { return undefined; }
  if (!Array.isArray(commands)) return [];
  return commands.filter((command: any) => command && typeof command.name === 'string' && command.name.length > 0);
}

/** Live tool availability for one discovery call, enumerated once and shared
 * by every record on the page instead of once per record. */
function availabilitySnapshot(pi: any): { registered: Set<string>; active: Set<string> } {
  const registered = new Set<string>();
  try {
    for (const tool of pi.getAllTools?.() ?? []) if (typeof tool?.name === 'string') registered.add(tool.name);
  } catch { /* A descriptive index remains useful if a host cannot expose schemas. */ }
  const active = new Set<string>();
  try {
    for (const name of pi.getActiveTools?.() ?? []) if (typeof name === 'string') active.add(name);
  } catch { /* Treat current activity as unknown rather than granting it. */ }
  return { registered, active };
}
/** Add live availability to the static ability index without presenting its
 * pointers as a claim that a configured tool is currently registered. */
function capabilityMetadata(record: any, pi: any, detail = false, availability?: { registered: Set<string>; active: Set<string> }): any {
  const tools = Array.isArray(record?.tools) ? record.tools.filter((name: any) => typeof name === 'string') : [];
  const { registered, active } = availability ?? availabilitySnapshot(pi);
  const result: any = {
    id: String(record?.id ?? '').slice(0, 128),
    group: String(record?.group ?? '').slice(0, 64),
    summary: String(record?.summary ?? '').slice(0, 512),
    entrypoints: Array.isArray(record?.entrypoints) ? record.entrypoints.map((value: any) => String(value).slice(0, 128)) : [],
    tools: tools.map((value: string) => value.slice(0, 128)),
    commands: Array.isArray(record?.commands) ? record.commands.map((value: any) => String(value).slice(0, 128)) : [],
    options: Array.isArray(record?.options) ? record.options : [],
    related: Array.isArray(record?.related) ? record.related.map((value: any) => String(value).slice(0, 128)) : [],
    toolAvailability: tools.map((name: string) => ({name: name.slice(0, 128),available:registered.has(name),active:active.has(name)})),
  };
  if (detail) {
    if (Array.isArray(record?.sourceFiles)) result.sourceFiles = record.sourceFiles.map((value: any) => String(value).slice(0, 512));
    if (typeof record?.doc === 'string') result.doc = record.doc.slice(0, 512);
  } else {
    // Summary pages should not spend context on empty detail-only fields.
    for (const key of ['entrypoints','commands','options','related']) delete result[key];
    result.inspect = {kind:'capabilities',id:result.id};
  }
  return result;
}
export function registerToolDiscovery(pi: any) {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_TOOL_DISCOVERY === 'off'
    || typeof pi.getAllTools !== 'function' || typeof pi.setActiveTools !== 'function'
    || typeof pi.getActiveTools !== 'function') return;
  let allowed = new Set<string>(), expected = new Set<string>(), wireDirty = false, owner: string | undefined, flushed = new Set<string>();
  let generation = 0;
  let sessionController = new AbortController();
  const invalidate = () => { generation++; sessionController.abort(); sessionController = new AbortController(); };
  const identity = (ctx: any) => JSON.stringify([ctx.cwd,ctx.sessionManager?.getSessionId?.()]);
  // Batch schema changes until the tool batch ends. The next model turn must
  // be able to use tools it just discovered within this same user request.
  const applyActive = (names: Iterable<string>) => {
    const next = [...names];
    let live: Set<string> | undefined;
    try { live = new Set(pi.getActiveTools()); } catch { /* No live list: apply the staged change anyway. */ }
    if (live && live.size === next.length && next.every(name => live.has(name))) { flushed = new Set(next); return; }
    try { pi.setActiveTools(next); flushed = new Set(next); } catch { /* Host keeps its wire if refused; staging stays logical. */ }
  };
  const flushPending = () => {
    if (!wireDirty) return;
    // A host narrowing access between discovery and the boundary wins.
    const live = new Set<string>(pi.getActiveTools());
    if (!same(live, flushed)) { allowed = new Set([...allowed].filter(name => live.has(name))); expected = new Set([...expected].filter(name => allowed.has(name))); }
    applyActive(expected);
    wireDirty = !same(expected, flushed);
  };
  const initialize = (_event: any, ctx: any) => {
    invalidate();
    // Explicit CLI tool selections belong to the caller, including --no-tools.
    if (process.argv.some(arg => arg === '--tools' || arg.startsWith('--tools=') || arg === '--no-tools')) return;
    const current = pi.getActiveTools();
    if (!current.includes('tool_search')) return;
    const available = new Set(pi.getAllTools().map((tool: any) => tool.name));
    // Compare against the last flushed wire state, not the staging set:
    // internally staged (wireDirty) additions must not read as an external
    // selection change, or re-init drops them along with their receipts.
    allowed = owner && same(flushed,new Set(current))
      ? new Set([...allowed].filter(name => available.has(name))) : new Set(current);
    owner = identity(ctx);
    const remembered = restoredToolNames(ctx.sessionManager?.getBranch?.() ?? [], allowed);
    expected = new Set([...allowed].filter((name: string) => CORE_TOOLS.has(name) || remembered.has(name)));
    wireDirty = false;
    applyActive(expected);
  };
  pi.on('session_start', initialize);
  pi.on('session_switch', initialize);
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_shutdown']) pi.on(event, invalidate);
  // turn_end precedes the owned core's next-turn context snapshot. turn_start
  // would be too late; mutating in execute would split a parallel tool batch.
  pi.on('turn_end', flushPending);
  pi.on('before_agent_start', (event: any, ctx: any) => {
    // Stage strong-intent studio bundles only while discovery owns the wire.
    try {
      if (owner && identity(ctx) === owner && same(flushed, new Set(pi.getActiveTools()))) {
        const images = Array.isArray(event?.images) ? event.images.length : 0;
        const names = intentBundleTools(event?.prompt, images).filter(name => allowed.has(name) && !expected.has(name));
        if (names.length) {
          expected = new Set([...expected, ...names]);
          wireDirty = true;
          try { pi.appendEntry?.(RECEIPT, {names, reason: 'intent'}); } catch { /* restoration only */ }
        }
      }
    } catch { /* Staging is an optimization; discovery stays available. */ }
    flushPending();
  });
  pi.on('agent_end', flushPending);
  pi.registerTool({
    name:'tool_search',label:'Find tools',
    description:'Browse compact groups, the ability index, or registered command metadata; preview tool schemas and explicitly enable selected names. Discovery never executes commands or tools.',
    promptGuidelines:[
      'Optional capabilities: tool_search({}) shows compact groups; use kind:"capabilities" for the ability index, kind:"commands" for registered extension, prompt-template, and skill commands, or query/names for tool schemas. Built-in UI commands such as /model and /compact are outside this API. skill_review browse/search finds workflows. Explore when useful; no required sequence.',
      'When browser/screenshot/DOM work, web research, structured-data reads, or past-session/memory questions need a capability that is not active, call tool_search with enable:true: the right tool is usually already installed but off-wire.',
    ],
    parameters:Type.Object({
      kind:Type.Optional(Type.Union([
        Type.Literal('tools'),
        Type.Literal('capabilities'),
        Type.Literal('commands'),
      ],{description:'Discovery surface: tools (default), capabilities, or registered extension/prompt/skill command metadata. Built-in UI slash commands are outside this API.'})),
      group:Type.Optional(Type.String({maxLength:64,description:'Group id from the overview; optional filter.'})),
      enable:Type.Optional(Type.Boolean({description:'Enable query matches explicitly. Exact names enable by default.'})),
      query:Type.Optional(Type.String({maxLength:256,description:'Task or capability, e.g. browser screenshot or symbol references.'})),
      names:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:128}),{maxItems:8,description:'Exact tool names to enable.'})),
      id:Type.Optional(Type.String({maxLength:256,description:'Exact capability or command id for a bounded detail lookup.'})),
      detail:Type.Optional(Type.Boolean({description:'Include bounded source/details for an exact capability or command.'})),
      limit:Type.Optional(Type.Integer({minimum:1,maximum:8})),
      offset:Type.Optional(Type.Integer({minimum:0,description:'Page through matches; any safe non-negative integer is accepted.'})),
    }),
    async execute(_id: string,input: any,_signal: any,_update: any,ctx: any) {
      const answer = (details: any,isError=false) => ({content:[{type:'text',text:JSON.stringify(details)}],details,...(isError?{isError:true}:{})});
      if (_signal?.aborted) return answer({error:'Tool discovery cancelled.'},true);
      const kind = input.kind ?? 'tools';
      const explicitNames = Array.isArray(input.names) && input.names.length > 0;
      const bundleActivationRequested = kind === 'capabilities' && (input.enable === true || (typeof input.id === 'string' && input.id.trim() !== '' && explicitNames && input.enable !== false));
      const activationRequested = (kind === 'tools' && (input.enable === true || (explicitNames && input.enable !== false))) || bundleActivationRequested;
      const ticket = generation, requestOwner = identity(ctx);
      const signal = _signal ? AbortSignal.any([_signal, sessionController.signal]) : sessionController.signal;
      const superseded = () => signal.aborted || ticket !== generation || identity(ctx) !== requestOwner
        || activationRequested && !same(flushed, new Set(pi.getActiveTools()));
      const active = new Set(pi.getActiveTools());
      const ownerMatches = Boolean(owner && identity(ctx)===owner);
      const selectionChanged = !ownerMatches || !same(flushed,active);
      // Read-only metadata discovery remains useful after an external tool
      // selection change. Any request that can alter schemas still requires
      // the discovery-owned active set and therefore fails closed.
      if (activationRequested && selectionChanged)
        return answer({error:'Tool activation is unavailable because the active selection is externally owned or changed outside discovery. Use metadata browsing, or start without an explicit tool restriction.'},true);

      if (kind !== 'tools' && kind !== 'capabilities' && kind !== 'commands')
        return answer({error:'Unknown discovery kind. Use "tools", "capabilities", or "commands".'},true);

      if (kind === 'capabilities') {
        if (explicitNames && !bundleActivationRequested)
          return answer({error:'The capability index is metadata only; use kind:"tools" with names or enable:true to change tool schemas.'},true);
        const groups = browseCapabilities({limit:1}).groups ?? [];
        const group = typeof input.group === 'string' ? input.group.trim() : '';
        if (group && !groups.some((item: any) => item.id === group))
          return answer({error:'Unknown capability index group.',group,groups:groups.map((item: any)=>item.id)},true);
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        // One semantic lookup can activate the complete relevant bundle.
        // An explicitly named capability (id, tool, or entrypoint such as
        // AgentMail) bypasses generic repeated discovery: kind:"capabilities"
        // with id or query plus enable:true stages every available tool in
        // the matched capability records in the same call, instead of
        // requiring a metadata call followed by a separate names call.
        const stageBundle = (records: any[]) => {
          const visible = !selectionChanged ? allowed : active;
          const wanted = new Set<string>();
          for (const record of records) for (const name of record?.tools ?? []) if (typeof name === 'string' && visible.has(name)) wanted.add(name);
          const added = [...wanted].filter(name => !expected.has(name));
          if (added.length) {
            expected = new Set([...expected, ...added]);
            wireDirty = true;
            try { pi.appendEntry?.(RECEIPT, {names: added}); } catch { /* Exposure succeeded; a missing receipt only affects later restoration. */ }
          }
          return added;
        };
        if (id) {
          const detail = getCapabilityDetail(id);
          if (!detail) return answer({error:'Unknown or unavailable capability id.',id},true);
          if (input.enable === true) {
            const added = stageBundle([detail]);
            return answer({capability:capabilityMetadata(detail,pi,true),staged:added,
              note:added.length?'Staged: the complete capability bundle joins the wire on the next model turn in this request. No tool executed.':'Capability bundle already staged for the wire. No tool executed.'});
          }
          return answer({capability:capabilityMetadata(detail,pi,true),note:'Metadata only; the capability was described and nothing was executed. Re-request with enable:true to stage its complete tool bundle in one lookup.'});
        }
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        const page = query
          ? searchCapabilities({query,group,limit:input.limit,offset:input.offset})
          : browseCapabilities({group,limit:input.limit,offset:input.offset});
        let jevRank: { mark: string; top: string; confidence: number } | undefined;
        let ranked = page.results;
        if (query) {
          const reranked = await rerankWithJev('capability', query, page.results,
            (record: any) => String(record?.id ?? ''),
            (record: any) => `${record?.id ?? ''}: ${record?.summary ?? ''} [${[...(record?.entrypoints ?? []), ...(record?.tools ?? [])].slice(0, 6).join(', ')}]`, pi, signal);
          if (superseded()) return answer({error:'Tool discovery was cancelled or superseded; no tools activated.'},true);
          if (reranked) { ranked = reranked.matches; if (reranked.info) jevRank = reranked.info; }
        }
        const results = ranked.map((record: any) => input.detail === true || input.enable === true
          ? getCapabilityDetail(record.id) ?? record
          : record);
        if (input.enable === true) {
          const added = stageBundle(results);
          const availability = availabilitySnapshot(pi);
          return answer({capabilities:results.map((record: any)=>capabilityMetadata(record,pi,true,availability)),staged:added,
          ...(page.groups ? {groups:page.groups} : {}),
          ...(page.query ? {query:page.query} : {}),
          ...(page.group ? {group:page.group} : {}),
          offset:page.offset,limit:page.limit,total:page.total,remaining:page.remaining,
          nextOffset:page.remaining ? page.offset + results.length : null,
          ...(jevRank ? {jev:jevRank} : {}),
          note:added.length?'Staged: the complete matched capability bundle(s) join the wire on the next model turn in this request. No tool executed.':'Matched capability bundle(s) already staged for the wire. No tool executed.'});
        }
        const availability = availabilitySnapshot(pi);
        return answer({capabilities:results.map((record: any)=>capabilityMetadata(record,pi,input.detail === true,availability)),
          ...(page.groups ? {groups:page.groups} : {}),
          ...(page.query ? {query:page.query} : {}),
          ...(page.group ? {group:page.group} : {}),
          offset:page.offset,limit:page.limit,total:page.total,remaining:page.remaining,
          nextOffset:page.remaining ? page.offset + results.length : null,
          ...(jevRank ? {jev:jevRank} : {}),
          note:'Metadata only; the ability index is descriptive and no tool, command, or workflow was executed.'});
      }

      // Slash commands are metadata exposed by the current SDK/runtime. They
      // are intentionally read live on every request so reloads and extension
      // registrations cannot leave a stale command inventory behind.
      if (kind === 'commands') {
        if (Array.isArray(input.names) && input.names.length)
          return answer({error:'names enables tools only; use id or query for commands.'},true);
        const commands = normalizedCommandCatalog(pi);
        if (!commands) return answer({error:'Live command discovery is unavailable in this host.'},true);
        const group = typeof input.group === 'string' ? input.group.trim().toLowerCase() : '';
        if (group && !['extension','prompt','skill'].includes(group))
          return answer({error:'Unknown command source. Use extension, prompt, or skill.'},true);
        const sourceFiltered = group ? commands.filter(command => command.source === group) : commands;
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (id && !sourceFiltered.some(command => command.name === id))
          return answer({error:'Unknown or unavailable command id.',id},true);
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        let matches: any[];
        if (id) {
          matches = sourceFiltered.filter(command => command.name === id);
        } else if (!query && !group) {
          return answer({
            commands:{count:commands.length,sources:commandSourceGroups(commands)},
            next:'Use kind:"commands" with query, group, or id for a short registered command page.',
          });
        } else {
          matches = searchCapabilityMetadata(sourceFiltered, query);
          const reranked = await rerankWithJev('command', query, matches,
            (command: any) => String(command?.name ?? ''),
            (command: any) => `${command?.name ?? ''}: ${command?.description ?? ''}`, pi, signal);
          if (superseded()) return answer({error:'Tool discovery was cancelled or superseded; no tools activated.'},true);
          if (reranked) {
            matches = reranked.matches;
            if (reranked.info) (matches as any).jevRank = reranked.info;
          }
        }
        const offset = id ? 0 : safeOffset(input.offset);
        const limit = pageLimit(input.limit);
        const selected = matches.slice(offset,offset + limit);
        return answer({
          commands:selected.map(command => commandMetadata(command,input.detail === true || Boolean(id))),
          offset,limit,remaining:Math.max(0,matches.length - offset - selected.length),
          ...((matches as any).jevRank ? {jev:(matches as any).jevRank} : {}),
          note:'Metadata only; registered extension, prompt-template, and skill commands are listed for orientation and were not executed.',
        });
      }

      const visibleAuthority = !selectionChanged ? allowed : active;
      let catalog = pi.getAllTools().filter((tool: any) => visibleAuthority.has(tool.name) && tool.name!=='tool_search');
      if (input.group) {
        if (!CAPABILITY_GROUPS.some(group=>group.id === input.group)) return answer({error:'Unknown capability group.'},true);
        catalog = catalog.filter((tool: any)=>capabilityGroup(tool.name,tool.description) === input.group);
      }
      const explicit = Array.isArray(input.names) ? [...new Set(input.names)] : [];
      let matches: any[];
      if (explicit.length) {
        const unknown = explicit.filter(name => !catalog.some((tool: any) => tool.name===name));
        if (unknown.length) return answer({error:'Unknown or unavailable tool names.',names:unknown},true);
        matches = explicit.map(name => catalog.find((tool: any) => tool.name===name));
      } else {
        const query = typeof input.query==='string' ? input.query.trim() : '';
        if (!query && !input.group) {
          const commands = normalizedCommandCatalog(pi);
          return answer({
            groups:groupOverview(catalog.map((tool: any)=>({name:tool.name,description:tool.description}))),
            commands:commands ? {count:commands.length,sources:commandSourceGroups(commands)} : {available:false},
            shortcuts:{skills:{tool:'skill_review',arguments:{action:'browse'}},abilities:{tool:'tool_search',arguments:{kind:'capabilities'}},localAI:{tool:'tool_search',arguments:{kind:'capabilities',id:'local-intelligence'}}},
            next:'Use kind:"capabilities" for the ability index, kind:"commands" for registered command metadata, group or query for tool previews, names to enable tools, or skill_review action:"browse"/"search" for workflows.',
          });
        }
        matches = searchCapabilityMetadata(catalog, query);
        if (!explicit.length) {
          const reranked = await rerankWithJev('tool', query, matches,
            (tool: any) => String(tool?.name ?? ''),
            (tool: any) => `${tool?.name ?? ''}: ${tool?.description ?? ''}`, pi, signal);
          if (superseded()) return answer({error:'Tool discovery was cancelled or superseded; no tools activated.'},true);
          if (reranked) { matches = reranked.matches; if (reranked.info) (matches as any).jevRank = reranked.info; }
        }
      }
      const offset = explicit.length ? 0 : safeOffset(input.offset);
      const limit = pageLimit(input.limit,explicit.length || 3);
      const selected = matches.slice(offset,offset+limit);
      const activate = input.enable === true || (explicit.length > 0 && input.enable !== false);
      const added = activate ? selected.map(tool=>tool.name).filter(name=>!expected.has(name)) : [];
      if (added.length) {
        expected = new Set([...expected,...added]);
        // Stage until the tool batch ends; apply once before the next model turn
        // (see applyActive/flushPending), keeping this turn's provider
        // prefix - and its cache - intact.
        wireDirty = true;
        try { pi.appendEntry?.(RECEIPT,{names:added}); } catch { /* Exposure succeeded; a missing receipt only affects later restoration. */ }
      }
      const resultingActive = new Set(pi.getActiveTools());
      const toolsJevRank = (matches as any).jevRank as { mark: string; top: string; confidence: number } | undefined;
      return answer({tools:selected.map(tool=>({name:tool.name,description:String(tool.description??'').slice(0,160),active:resultingActive.has(tool.name),...(activate&&Array.isArray(tool.promptGuidelines)&&tool.promptGuidelines.length?{guidance:tool.promptGuidelines.slice(0,2).map((text: unknown)=>String(text).slice(0,320))}:{})})),
        offset,limit,remaining:Math.max(0,matches.length-offset-selected.length),
        nextOffset:offset+selected.length<matches.length ? offset+selected.length : null,
        ...(toolsJevRank ? {jev:toolsJevRank} : {}),
        note:activate?(added.length?'Staged: chosen schemas become available on the next model turn in this request. No tool executed.':'Chosen schemas are already active or staged for the next model turn. No tool executed.'):'Preview only. Enable chosen tools with names; use offset for more matches.'});
    },
  });
}

const escapeCatalogText = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

function buildSkillCatalog(skills: any[]): string {
  return ['<available_skills>',...skills.flatMap((skill: any)=>[
    '  <skill>',`    <name>${escapeCatalogText(skill.name)}</name>`,`    <description>${escapeCatalogText(skill.description)}</description>`,`    <location>${escapeCatalogText(skill.filePath)}</location>`,'  </skill>',
  ]),'</available_skills>'].join('\n');
}

/** Skills eligible for projection, or null when projection does not apply. */
function projectionSkills(event: any, activeTools: string[]): any[] | null {
  if (process.env.PI_SKILL_CATALOG === 'full' || process.env.PI_SUBAGENT_CHILD === "1"
    || !activeTools.includes('skill_review')) return null;
  const skills = event.systemPromptOptions?.skills?.filter((skill: any)=>!skill.disableModelInvocation);
  if (!Array.isArray(skills) || !skills.length) return null;
  if (skills.some((skill: any)=>![skill.name,skill.description,skill.filePath].every(value=>typeof value==='string'))) return null;
  return skills;
}

/** Project only the SDK's exact configured skill inventory, after local skill
 * routing has read it. User/project text and custom prompt sections stay intact. */
export function compactSkillCatalog(event: any, activeTools: string[]): string | undefined {
  const skills = projectionSkills(event, activeTools);
  const source = event.systemPrompt;
  if (!skills || typeof source !== 'string') return;
  const catalog = buildSkillCatalog(skills);
  if (source.split(catalog).length!==2) return;
  return source.replace(catalog,`Installed skills are available on demand (${skills.length} workflows). Use skill_review action:"browse" for groups or action:"search" with a query for short matches. Read a chosen workflow when useful. Discovery and workflows are optional.`);
}

/** Explain why projection could not run, so a silent full-catalogue injection
 * becomes a one-time maintenance signal. Foreign catalogue text is never
 * rewritten; the strict match above stays the only rewrite path. */
export function skillCatalogProjectionMiss(event: any, activeTools: string[]): string | null {
  const skills = projectionSkills(event, activeTools);
  const source = event.systemPrompt;
  if (!skills || typeof source !== 'string') return null;
  const occurrences = source.split(buildSkillCatalog(skills)).length - 1;
  if (occurrences === 1) return null;
  if (occurrences > 1) return 'duplicate-blocks';
  if (source.includes('<available_skills>')) return 'block-not-exact';
  return null;
}
