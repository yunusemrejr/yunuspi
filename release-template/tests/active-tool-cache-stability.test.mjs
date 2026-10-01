import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../core/coding-agent/src/core/agent-session.js';

test('restoring an identical active tool set preserves prompt and schema order',()=>{
 const tools=['read','bash','edit'].map(name=>({name,parameters:{type:'object',properties:{}}}));
 const owner={_toolRegistry:new Map(tools.map(tool=>[tool.name,tool])),agent:{state:{}},
  _rebuildSystemPrompt:names=>names.join('\n')};
 AgentSession.prototype.setActiveToolsByName.call(owner,['read','bash','edit']);
 const prompt=owner.agent.state.systemPrompt,wire=JSON.stringify(owner.agent.state.tools);
 AgentSession.prototype.setActiveToolsByName.call(owner,['edit','read','bash','read','not_registered']);
 assert.equal(owner.agent.state.systemPrompt,prompt);assert.equal(JSON.stringify(owner.agent.state.tools),wire);
 assert.deepEqual(owner.agent.state.tools.map(tool=>tool.name),['bash','edit','read']);
 AgentSession.prototype.setActiveToolsByName.call(owner,['read']);
 assert.equal(owner.agent.state.systemPrompt,'read');
 assert.equal(owner.agent.state.tools.length,1,'real tool-set changes remain effective');
});
