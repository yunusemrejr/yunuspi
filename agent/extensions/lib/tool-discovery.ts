/** Keep specialized schemas out of the initial prompt without removing their
 * capabilities. Discovery changes schema exposure only; it never runs a tool
 * or grants access outside the host's original active/allowed tool set. */
import { Type } from 'typebox';
import { CAPABILITY_GROUPS, capabilityGroup, groupOverview, searchCapabilityMetadata } from './capability-groups.ts';
import { browseCapabilities, searchCapabilities, getCapabilityDetail } from './harness-capabilities.ts';
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
]);
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

/** Add live availability to the static ability index without presenting its
 * pointers as a claim that a configured tool is currently registered. */
function capabilityMetadata(record: any, pi: any, detail = false): any {
  const tools = Array.isArray(record?.tools) ? record.tools.filter((name: any) => typeof name === 'string') : [];
  const registered = new Set<string>();
  try {
    for (const tool of pi.getAllTools?.() ?? []) if (typeof tool?.name === 'string') registered.add(tool.name);
  } catch { /* A descriptive index remains useful if a host cannot expose schemas. */ }
  const active = new Set<string>();
  try {
    for (const name of pi.getActiveTools?.() ?? []) if (typeof name === 'string') active.add(name);
  } catch { /* Treat current activity as unknown rather than granting it. */ }
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
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_TOOL_DISCOVERY === 'off'
    || typeof pi.getAllTools !== 'function' || typeof pi.setActiveTools !== 'function'
    || typeof pi.getActiveTools !== 'function') return;
  let allowed = new Set<string>(), expected = new Set<string>(), owner: string | undefined;
  const identity = (ctx: any) => JSON.stringify([ctx.cwd,ctx.sessionManager?.getSessionId?.()]);
  const initialize = (_event: any, ctx: any) => {
    // Explicit CLI tool selections belong to the caller, including --no-tools.
    if (process.argv.some(arg => arg === '--tools' || arg.startsWith('--tools=') || arg === '--no-tools')) return;
    const current = pi.getActiveTools();
    if (!current.includes('tool_search')) return;
    const available = new Set(pi.getAllTools().map((tool: any) => tool.name));
    allowed = owner && same(expected,new Set(current))
      ? new Set([...allowed].filter(name => available.has(name))) : new Set(current);
    owner = identity(ctx);
    const remembered = restoredToolNames(ctx.sessionManager?.getBranch?.() ?? [], allowed);
    expected = new Set([...allowed].filter((name: string) => CORE_TOOLS.has(name) || remembered.has(name)));
    pi.setActiveTools([...expected]);
  };
  pi.on('session_start', initialize);
  pi.on('session_switch', initialize);
  pi.registerTool({
    name:'tool_search',label:'Find tools',
    description:'Browse compact groups, the ability index, or registered command metadata; preview tool schemas and explicitly enable selected names. Discovery never executes commands or tools.',
    promptGuidelines:[
      'Optional capabilities: tool_search({}) shows compact groups; use kind:"capabilities" for the ability index, kind:"commands" for registered extension, prompt-template, and skill commands, or query/names for tool schemas. Built-in UI commands such as /model and /compact are outside this API. skill_review browse/search finds workflows. Explore when useful; no required sequence.',
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
      const activationRequested = kind === 'tools' && (input.enable === true || (explicitNames && input.enable !== false));
      const active = new Set(pi.getActiveTools());
      const ownerMatches = Boolean(owner && identity(ctx)===owner);
      const selectionChanged = !ownerMatches || !same(expected,active);
      // Read-only metadata discovery remains useful after an external tool
      // selection change. Any request that can alter schemas still requires
      // the discovery-owned active set and therefore fails closed.
      if (activationRequested && selectionChanged)
        return answer({error:'Tool activation is unavailable because the active selection is externally owned or changed outside discovery. Use metadata browsing, or start without an explicit tool restriction.'},true);

      if (kind !== 'tools' && kind !== 'capabilities' && kind !== 'commands')
        return answer({error:'Unknown discovery kind. Use "tools", "capabilities", or "commands".'},true);

      if (kind === 'capabilities') {
        if (explicitNames || input.enable === true)
          return answer({error:'The capability index is metadata only; use kind:"tools" with names or enable:true to change tool schemas.'},true);
        const groups = browseCapabilities({limit:1}).groups ?? [];
        const group = typeof input.group === 'string' ? input.group.trim() : '';
        if (group && !groups.some((item: any) => item.id === group))
          return answer({error:'Unknown capability index group.',group,groups:groups.map((item: any)=>item.id)},true);
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (id) {
          const detail = getCapabilityDetail(id);
          if (!detail) return answer({error:'Unknown or unavailable capability id.',id},true);
          return answer({capability:capabilityMetadata(detail,pi,true),note:'Metadata only; the capability was described and nothing was executed.'});
        }
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        const page = query
          ? searchCapabilities({query,group,limit:input.limit,offset:input.offset})
          : browseCapabilities({group,limit:input.limit,offset:input.offset});
        const results = page.results.map((record: any) => input.detail === true
          ? getCapabilityDetail(record.id) ?? record
          : record);
        return answer({capabilities:results.map((record: any)=>capabilityMetadata(record,pi,input.detail === true)),
          ...(page.groups ? {groups:page.groups} : {}),
          ...(page.query ? {query:page.query} : {}),
          ...(page.group ? {group:page.group} : {}),
          offset:page.offset,limit:page.limit,total:page.total,remaining:page.remaining,
          nextOffset:page.remaining ? page.offset + results.length : null,
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
        }
        const offset = id ? 0 : safeOffset(input.offset);
        const limit = pageLimit(input.limit);
        const selected = matches.slice(offset,offset + limit);
        return answer({
          commands:selected.map(command => commandMetadata(command,input.detail === true || Boolean(id))),
          offset,limit,remaining:Math.max(0,matches.length - offset - selected.length),
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
      }
      const offset = explicit.length ? 0 : safeOffset(input.offset);
      const limit = pageLimit(input.limit,explicit.length || 3);
      const selected = matches.slice(offset,offset+limit);
      const activate = input.enable === true || (explicit.length > 0 && input.enable !== false);
      const added = activate ? selected.map(tool=>tool.name).filter(name=>!expected.has(name)) : [];
      if (added.length) {
        const next = new Set([...expected,...added]);
        pi.setActiveTools([...next]);
        expected = next;
        try { pi.appendEntry?.(RECEIPT,{names:added}); } catch { /* Exposure succeeded; a missing receipt only affects later restoration. */ }
      }
      const resultingActive = new Set(pi.getActiveTools());
      return answer({tools:selected.map(tool=>({name:tool.name,description:String(tool.description??'').slice(0,160),active:resultingActive.has(tool.name),...(activate&&Array.isArray(tool.promptGuidelines)&&tool.promptGuidelines.length?{guidance:tool.promptGuidelines.slice(0,2).map((text: unknown)=>String(text).slice(0,320))}:{})})),
        offset,limit,remaining:Math.max(0,matches.length-offset-selected.length),
        nextOffset:offset+selected.length<matches.length ? offset+selected.length : null,
        note:activate?'Chosen schemas are available next. No tool executed.':'Preview only. Enable chosen tools with names; use offset for more matches.'});
    },
  });
}

/** Project only the SDK's exact configured skill inventory, after local skill
 * routing has read it. User/project text and custom prompt sections stay intact. */
export function compactSkillCatalog(event: any, activeTools: string[]): string | undefined {
  if (process.env.PI_SKILL_CATALOG === 'full' || process.env.PI_SUBAGENT_CHILD
    || !activeTools.includes('skill_review')) return;
  const source = event.systemPrompt;
  const skills = event.systemPromptOptions?.skills?.filter((skill: any)=>!skill.disableModelInvocation);
  if (typeof source!=='string' || !Array.isArray(skills) || !skills.length) return;
  const escape = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  if (skills.some((skill: any)=>![skill.name,skill.description,skill.filePath].every(value=>typeof value==='string'))) return;
  const catalog = ['<available_skills>',...skills.flatMap((skill: any)=>[
    '  <skill>',`    <name>${escape(skill.name)}</name>`,`    <description>${escape(skill.description)}</description>`,`    <location>${escape(skill.filePath)}</location>`,'  </skill>',
  ]),'</available_skills>'].join('\n');
  if (source.split(catalog).length!==2) return;
  return source.replace(catalog,`Installed skills are available on demand (${skills.length} workflows). Use skill_review action:"browse" for groups or action:"search" with a query for short matches. Read a chosen workflow when useful. Discovery and workflows are optional.`);
}
