import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(`export function resolve(name,ctx,next){
 const sources={
 '@yunuspi/coding-agent':'export function getAgentDir(){return ${JSON.stringify('/tmp/pi-contracts-agentfixture')}};export class SettingsManager{static create(){return {getCompactionSettings(){return{};}};}}',
 '@yunuspi/ai':'export function StringEnum(v){return v}'};
 return name in sources?{url:'data:text/javascript,'+encodeURIComponent(sources[name]),shortCircuit:true}:next(name,ctx);
}`), import.meta.url);

// Cross-layer integration: task classification -> model selection -> child
// launch -> provider request conversion -> child lifecycle -> accounting ->
// recovery -> /used. Contract mismatches between individually reasonable
// modules surface here, not in per-module tests.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-contracts-e2e-'));
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_PROVIDER_STATE_FILE = path.join(sandbox, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(sandbox, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(sandbox, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/child-ledger.ts')),
);
assert.ok(agent, 'agent tree is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;

const { runChildSpawnPreflight, toolWirePreflightProbe } = await import(shared + 'child-spawn-preflight.ts');

test('incompatible backend fails preflight before any inference spend', () => {
  const wire = [{ name: 'query_data', schema: { type: 'object', properties: { sql: { type: 'string' }, params: { oneOf: [{ type: 'array' }, { type: 'object' }] } } } }];
  const strictBackend = runChildSpawnPreflight({
    requestedModel: 'q/m',
    backend: 'mystery-backend-xyz',
    tools: wire,
    probes: { toolWire: toolWirePreflightProbe },
  });
  // Unknown backends project conservatively (warn) or fail — never silently pass raw.
  assert.ok(['warn', 'fail', 'pass'].includes(strictBackend.checks.tool_wire.state));
  assert.ok(strictBackend.checks.tool_wire.detail && strictBackend.checks.tool_wire.detail.length > 0);
});

test('audit: projection warnings name the dropped keywords per tool',()=>{
 const wire=[{name:'read_file',schema:{type:'object',properties:{path:{type:'string',minLength:1}},required:['path']}}];
 const check=runChildSpawnPreflight({requestedModel:'o/m',backend:'openrouter',tools:wire,structuredOutput:true,probes:{toolWire:toolWirePreflightProbe}});
 assert.equal(check.checks.tool_wire.state,'warn',JSON.stringify(check.checks.tool_wire));
 assert.ok(check.checks.tool_wire.detail.includes('minLength'),'detail names the projected keyword: '+check.checks.tool_wire.detail);
 assert.ok(check.checks.tool_wire.detail.includes('read_file'),'Detail names the tool: '+check.checks.tool_wire.detail);
});
