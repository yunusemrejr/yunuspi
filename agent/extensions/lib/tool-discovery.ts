/** Keep specialized schemas out of the initial prompt without removing their
 * capabilities. Discovery changes schema exposure only; it never runs a tool
 * or grants access outside the host's original active/allowed tool set. */
import { Type } from 'typebox';
const RECEIPT = 'harness-tool-activation-v1';
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
    const remembered = new Set<string>();
    for (const entry of (ctx.sessionManager?.getBranch?.() ?? []).slice(-2000)) {
      if (entry.type === 'custom' && entry.customType === RECEIPT && Array.isArray(entry.data?.names))
        for (const name of entry.data.names.slice(0,128)) if (typeof name === 'string' && allowed.has(name)) remembered.add(name);
    }
    expected = new Set([...allowed].filter((name: string) => CORE_TOOLS.has(name) || remembered.has(name)));
    pi.setActiveTools([...expected]);
  };
  pi.on('session_start', initialize);
  pi.on('session_switch', initialize);
  pi.registerTool({
    name:'tool_search',label:'Find tools',
    description:'Find and enable specialized harness tools by query or exact names. Their full schemas become available on the next response. This only exposes tools; it does not execute them. Use when a needed capability is not currently listed. Ordinary tools remain appropriate for simple work.',
    promptGuidelines:[
      'The harness has optional source/AST/LSP inspection, browser/web, media, memory, background jobs, data/API/Git and coordination tools. tool_search discovers and enables them on demand. Choose tools and relevant skills when they help; no discovery call, tool variety or workflow sequence is required.',
    ],
    parameters:Type.Object({
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
      const catalog = pi.getAllTools().filter((tool: any) => allowed.has(tool.name) && tool.name!=='tool_search');
      const explicit = Array.isArray(input.names) ? [...new Set(input.names)] : [];
      let matches: any[];
      if (explicit.length) {
        const unknown = explicit.filter(name => !catalog.some((tool: any) => tool.name===name));
        if (unknown.length) return answer({error:'Unknown or unavailable tool names.',names:unknown},true);
        matches = explicit.map(name => catalog.find((tool: any) => tool.name===name));
      } else {
        const query = typeof input.query==='string' ? input.query.trim() : '';
        if (!query) return answer({error:'Supply a capability query or exact tool names.'},true);
        const terms = [...new Set(words(query))].filter(term => term.length>1);
        matches = catalog.map((tool: any) => {
          const name = tool.name.toLowerCase(), text = String(tool.description??'').toLowerCase();
          const score = name===query.toLowerCase() ? 10000 : terms.reduce((sum,term)=>sum+(name.includes(term)?8:0)+(text.includes(term)?1:0),0);
          return {tool,score};
        }).filter((row: any)=>row.score>0).sort((a: any,b: any)=>b.score-a.score||a.tool.name.localeCompare(b.tool.name)).map((row: any)=>row.tool);
      }
      const offset = explicit.length ? 0 : Math.min(1000,Math.max(0,input.offset??0));
      const selected = matches.slice(offset,offset+Math.min(8,Math.max(1,input.limit??5)));
      const added = selected.map(tool=>tool.name).filter(name=>!expected.has(name));
      if (added.length) {
        const next = new Set([...expected,...added]);
        pi.setActiveTools([...next]);
        expected = next;
        try { pi.appendEntry?.(RECEIPT,{names:added}); } catch { /* Exposure succeeded; a missing receipt only affects later restoration. */ }
      }
      return answer({tools:selected.map(tool=>({name:tool.name,description:String(tool.description??'').slice(0,240),active:true,...(Array.isArray(tool.promptGuidelines)&&tool.promptGuidelines.length?{guidance:tool.promptGuidelines.slice(0,2).map((text: unknown)=>String(text).slice(0,320))}:{})})),
        remaining:Math.max(0,matches.length-offset-selected.length),
        note:'Selected tool schemas are available next. No underlying tool was executed.'});
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
  return source.replace(catalog,`Installed skills are available on demand (${skills.length} workflows). Use skill_review with action:"search" and a task-specific query to find names, descriptions and file paths; read the relevant workflow when useful. Local routing can also offer optional suggestions. No skill-reading quota or fixed workflow is required.`);
}
