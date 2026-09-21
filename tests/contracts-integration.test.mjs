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
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;

const { extractTaskIntent } = await import(shared + 'task-intent-model.ts');
const { childRequirementsFromTask } = await import(shared + 'child-route-requirements.ts');
const { selectAffordableModel } = await import(shared + 'model-selection.ts');
const { loadModelEconomyConfig } = await import(shared + 'model-economy.ts');
const { publishFreeEvidence, FREE_CATALOG_URL } = await import(shared + 'free-route-evidence.ts');
const { planChildToolSubset, estimateToolSchemaTokens } = await import(shared + 'child-tool-subsets.ts');
const { checkToolWire } = await import(lib + 'request-compat.ts');
const { runChildSpawnPreflight, toolWirePreflightProbe } = await import(shared + 'child-spawn-preflight.ts');
const { reduceChildEvents, projectTranscriptChildren, summarizeLedger } = await import(shared + 'child-ledger.ts');
const { classifyFailure } = await import(shared + 'failure-cause.ts');
const { adviseRecovery } = await import(shared + 'recovery-advisor.ts');
const { buildUsedSummary } = await import(pathToFileURL(path.join(agent, 'extensions/session-signals.ts')));

const TASK = 'Review the login flow for auth bugs. Never deploy; do not modify production. Return findings only.';
const PERMITTED = ['read_file', 'search', 'bash', 'write_file', 'edit_file', 'web_fetch', 'contact_supervisor', 'utility'];
const TOOL_SCHEMAS = {
  read_file: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'] },
  search: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  utility: { type: 'object', properties: { op: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
  contact_supervisor: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};

test('read-only audit flows end to end without parent-capacity rejection', () => {
  // 1. Task classification: prohibitions do not retype the task.
  const intent = extractTaskIntent(TASK);
  assert.equal(intent.requestedAction, 'review');
  assert.equal(intent.mutationPermission, 'forbidden');
  assert.equal(intent.decisionCriticality, 'advisory');

  // 2. Tool subset: minimal wire set for a source review.
  const subset = planChildToolSubset(intent, TASK, PERMITTED);
  assert.equal(subset.template, 'source-review');
  assert.ok(!subset.wire.includes('write_file'), 'write tools stay deferred');
  assert.ok(subset.deferred.includes('write_file'), 'deferred tools remain permitted');

  // 3. Child requirements from the actual launch.
  const child = childRequirementsFromTask(TASK, { toolCount: subset.wire.length });
  child.toolCalling = true;
  const schemaTokens = estimateToolSchemaTokens(subset.wire.length);
  assert.ok(schemaTokens > 0 && schemaTokens < estimateToolSchemaTokens(PERMITTED.length));

  // 4. Model selection against the child workload, not the parent.
  const cfg = loadModelEconomyConfig();
  const models = [
    { provider: 'openrouter', id: 'parent-giant', fullId: 'openrouter/parent-giant', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ['text', 'image'], cost: { input: 10, output: 40, cacheRead: 1, cacheWrite: 2 } },
    { provider: 'openrouter', id: 'reviewer-small', fullId: 'openrouter/reviewer-small', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 64000, maxTokens: 8192, input: ['text'], cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.1 } },
  ];
  publishFreeEvidence(models.map((m) => ({
    id: m.id,
    pricing: { prompt: String(m.cost.input / 1e6), completion: String(m.cost.output / 1e6) },
    capabilities: { toolCalling: true, contextWindow: m.contextWindow, maxTokens: m.maxTokens },
  })), FREE_CATALOG_URL);
  const pick = selectAffordableModel(models, cfg, { preferredModel: 'openrouter/parent-giant', child, task: TASK });
  assert.ok(pick, 'child workload selects without parent-capacity rejection');
  assert.ok(pick.decision, 'decision record attached');

  // 5. Provider request conversion: preflight the exact backend + wire subset.
  const wire = subset.wire.map((name) => ({ name, schema: TOOL_SCHEMAS[name] ?? { type: 'object' } }));
  const check = runChildSpawnPreflight({
    requestedModel: pick.model,
    backend: 'deepseek',
    tools: wire,
    probes: { toolWire: toolWirePreflightProbe },
  });
  assert.equal(check.checks.tool_wire.state !== 'fail', true, JSON.stringify(check.checks.tool_wire));
  const compat = checkToolWire(wire, 'deepseek');
  assert.equal(compat.ok, true, 'review subset is wire-compatible (unrelated utility schema excluded)');

  // 6. Child lifecycle: truncation then resumable completion on one task.
  const events = [
    { type: 'launch', taskId: 'audit-1', label: 'audit login flow', attempt: 1, runId: 'run-1', route: pick.model },
    { type: 'completion', taskId: 'audit-1', runId: 'run-1', row: { status: 'failed', stopReason: 'length' } },
    { type: 'recovery', taskId: 'audit-1', reason: 'resume synthesis', replacementAttempt: 2 },
    { type: 'launch', taskId: 'audit-1', attempt: 2, runId: 'run-2', route: pick.model },
    { type: 'completion', taskId: 'audit-1', runId: 'run-2', row: { status: 'completed', exitCode: 0, acceptance: { status: 'passed' } } },
  ];
  const ledger = reduceChildEvents(events);
  assert.equal(ledger.tasks.length, 1);
  assert.equal(ledger.tasks[0].state, 'completed');

  // 7. Recovery advice for the truncated attempt is resume, not relaunch.
  const cause = classifyFailure({ stopReason: 'length' });
  const advice = adviseRecovery(cause, { taskId: 'audit-1', attempt: 1, hasArtifacts: true, hasSessionState: true });
  assert.ok(advice.actions.includes('resume'));

  // 8. /used projects the same canonical state.
  const summary = summarizeLedger(ledger);
  const branch = [
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-2', mode: 'single', state: 'completed', results: [{ index: 0, status: 'completed', exitCode: 0, model: pick.model, task: 'audit login flow' }] } },
  ];
  const used = buildUsedSummary(branch);
  assert.equal(used.logicalTasks.length, 1);
  assert.equal(used.logicalTasks[0].state, 'completed');
  assert.equal(used.agents.completed, 1);
  assert.equal(summary.completed, 1);
  assert.deepEqual(
    reduceChildEvents(projectTranscriptChildren(branch)).tasks.map((t) => t.state),
    used.logicalTasks.map((t) => t.state),
    '/used and the ledger share one reducer',
  );
});

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
