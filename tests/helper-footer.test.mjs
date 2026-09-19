import test from 'node:test';
import assert from 'node:assert/strict';
import { FooterComponent } from '../core/coding-agent/dist/modes/interactive/components/footer.js';
import { initTheme } from '../core/coding-agent/dist/modes/interactive/theme/theme.js';
import { visibleWidth } from '@yunuspi/tui';
import { AgentSession } from '@yunuspi/coding-agent';
import { registerToolDiscovery } from '../agent/extensions/lib/tool-discovery.ts';
initTheme('dark', false);

test('actual terminal footer retains named powers and helper/catalog status at narrow and wide widths',()=>{
 const entries=['subagent','quality_review','project_tests','skill_review','session_self','browser_session','bg_run','tool_search'].map((toolName,index)=>({type:'message',message:{role:'toolResult',toolName,toolCallId:String(index),content:[]}}));
 const session={state:{model:{id:'example-model',provider:'example',contextWindow:128000},thinkingLevel:'high'},getContextUsage:()=>({percent:12.5,contextWindow:128000}),modelRuntime:{isUsingSubscription:()=>false},sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getCwd:()=>'/workspace/example',getSessionName:()=>undefined,getSessionId:()=> 'example-session'}};
 const statuses=new Map([['00-harness-activity','✓ JEV returned · 25ms'],['model-catalog','Model list: example · updated 1d 14h ago · stale · /catalog-status']]);
 const footer=new FooterComponent(session,{getGitBranch:()=> 'main',getAvailableProviderCount:()=>1,getExtensionStatuses:()=>statuses});
 for(const width of [40,80,120]){
  const lines=footer.render(width);
  assert.ok(lines.every(line=>visibleWidth(line)<=width),`width ${width}`);
  const text=lines.join('\n');
  for(const word of ['Agents','Review','Tests','Skills','Self','Browser','Jobs','Tools','JEV','/catalog-status'])assert.ok(text.includes(word),`${word} at ${width}`);
 }
});

test('owned next-turn snapshot includes a discovered tool without another user prompt',async()=>{
 const session=Object.create(AgentSession.prototype), hooks=new Map(), definitions=new Map();
 session.agent={state:{tools:[],model:{id:'example'},thinkingLevel:'off'}};
 session._toolRegistry=new Map(['read','tool_search','browser_session'].map(name=>[name,{name,description:name,parameters:{type:'object',properties:{}}}]));
 session._rebuildSystemPrompt=()=> 'fixture system prompt';
 session._compactBeforeNextAssistantResponse=async context=>context;
 session.setActiveToolsByName([...session._toolRegistry.keys()]);
 session._installAgentNextTurnRefresh();
 const pi={on:(name,fn)=>hooks.set(name,fn),registerTool:def=>definitions.set(def.name,def),getAllTools:()=>[...session._toolRegistry.values()],getActiveTools:()=>session.agent.state.tools.map(tool=>tool.name),setActiveTools:names=>session.setActiveToolsByName(names),appendEntry(){}};
 registerToolDiscovery(pi);
 const ctx={cwd:'/fixture',sessionManager:{getSessionId:()=> 'fixture',getBranch:()=>[]}};
 hooks.get('session_start')({},ctx);
 await definitions.get('tool_search').execute('call',{names:['browser_session']},undefined,undefined,ctx);
 assert.ok(!pi.getActiveTools().includes('browser_session'));
 hooks.get('turn_end')({},ctx);
 const next=await session.agent.prepareNextTurnWithContext({context:{messages:[],tools:[]}},new AbortController().signal);
 assert.ok(next.context.tools.some(tool=>tool.name==='browser_session'));
});
