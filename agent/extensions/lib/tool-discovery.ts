/** Keep specialized schemas out of the initial prompt without removing their
 * capabilities. Discovery changes schema exposure only; it never runs a tool
 * or grants access outside the host's original active/allowed tool set. */
import { Type } from 'typebox';
import { CAPABILITY_GROUPS, capabilityGroup, groupOverview } from './capability-groups.ts';
const RECEIPT = 'harness-tool-activation-v1';
const RESUME_TOOLS = 6;
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
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
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
    description:'Browse capability groups or search short tool previews. Enable chosen schemas with names or enable:true; no underlying tool runs. Search never enables tools by default.',
    promptGuidelines:[
      'Optional capabilities: source/AST/LSP, browser/web, media, memory, jobs, data/API/Git and coordination. tool_search({}) shows groups; a query previews matches; names enables chosen tools. skill_review browse/search finds workflows. Explore when useful; no required sequence.',
    ],
    parameters:Type.Object({
      group:Type.Optional(Type.String({maxLength:64,description:'Group id from the overview; optional filter.'})),
      enable:Type.Optional(Type.Boolean({description:'Enable query matches explicitly. Exact names enable by default.'})),
      query:Type.Optional(Type.String({maxLength:256,description:'Task or capability, e.g. browser screenshot or symbol references.'})),
      names:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:128}),{maxItems:8,description:'Exact tool names to enable.'})),
      limit:Type.Optional(Type.Integer({minimum:1,maximum:8})),
      offset:Type.Optional(Type.Integer({minimum:0,maximum:1000,description:'Page through query matches.'})),
    }),
    async execute(_id: string,input: any,_signal: any,_update: any,ctx: any) {
      const answer = (details: any,isError=false) => ({content:[{type:'text',text:JSON.stringify(details)}],details,...(isError?{isError:true}:{})});
      if (_signal?.aborted) return answer({error:'Tool discovery cancelled.'},true);
      if (!owner || identity(ctx)!==owner || !same(expected,new Set(pi.getActiveTools())))
        return answer({error:'Tool selection changed outside discovery; preserve the current tool set. Start a new session to reset discovery.'},true);
      let catalog = pi.getAllTools().filter((tool: any) => allowed.has(tool.name) && tool.name!=='tool_search');
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
        if (!query && !input.group) return answer({groups:groupOverview(catalog.map((tool: any)=>({name:tool.name,description:tool.description}))),next:'Use group or query for short previews; names enables chosen tools.'});
        const terms = [...new Set(words(query))].filter(term => term.length>1);
        matches = catalog.map((tool: any) => {
          const name = tool.name.toLowerCase(), text = String(tool.description??'').toLowerCase();
          const score = !query ? 1 : name===query.toLowerCase() ? 10000 : terms.reduce((sum,term)=>sum+(name.includes(term)?8:0)+(text.includes(term)?1:0),0);
          return {tool,score};
        }).filter((row: any)=>row.score>0).sort((a: any,b: any)=>b.score-a.score||a.tool.name.localeCompare(b.tool.name)).map((row: any)=>row.tool);
      }
      const offset = explicit.length ? 0 : Math.min(1000,Math.max(0,input.offset??0));
      const selected = matches.slice(offset,offset+Math.min(8,Math.max(1,input.limit??(explicit.length || 3))));
      const activate = input.enable === true || (explicit.length > 0 && input.enable !== false);
      const added = activate ? selected.map(tool=>tool.name).filter(name=>!expected.has(name)) : [];
      if (added.length) {
        const next = new Set([...expected,...added]);
        pi.setActiveTools([...next]);
        expected = next;
        try { pi.appendEntry?.(RECEIPT,{names:added}); } catch { /* Exposure succeeded; a missing receipt only affects later restoration. */ }
      }
      return answer({tools:selected.map(tool=>({name:tool.name,description:String(tool.description??'').slice(0,160),active:expected.has(tool.name),...(activate&&Array.isArray(tool.promptGuidelines)&&tool.promptGuidelines.length?{guidance:tool.promptGuidelines.slice(0,2).map((text: unknown)=>String(text).slice(0,320))}:{})})),
        remaining:Math.max(0,matches.length-offset-selected.length),
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
