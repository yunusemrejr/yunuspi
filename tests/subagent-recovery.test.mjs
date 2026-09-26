import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getEventListeners } from "node:events";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((dir) =>
	fs.existsSync(path.join(dir, "extensions/pi-subagents/src/agents/agents.ts")),
);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-recovery-"));
process.env.HOME = work;
process.env.PI_CODING_AGENT_DIR = path.join(work, "agent");
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
const load = (name) => import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src", name)).href);
const discovery = await load("agents/agents.ts");
const { handleManagementAction } = await load("agents/agent-management.ts");
const retry = await load("shared/file-system-retry.ts");
const { combinedAbortSignal, runWorkflowScript } = await load("workflows/scripted-workflow.ts");

test("invalid user overrides retain the builtin and expose the broken file", () => {
	const directory = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
	fs.mkdirSync(directory, { recursive: true });
	const brokenFile = path.join(directory, "worker.md");
	fs.writeFileSync(brokenFile, "---\nname: worker\ndescription: Broken override\nallowNestedSubagents: invalid\n---\nWorker\n");
	discovery.clearAgentDiscoveryCache();
	const found = discovery.discoverAgents(work, "user");
	const worker = found.agents.find((entry) => entry.name === "worker");
	assert.equal(worker?.source, "builtin");
	assert.equal(discovery.findBlockingAgentDiagnostic("worker", worker, found.agentDiagnostics), undefined);
	assert.equal(discovery.findShadowedAgentDiagnostic("worker", worker, found.agentDiagnostics)?.filePath, brokenFile);
	const context = { cwd: work, modelRegistry: { getAvailable: () => [] } };
	for (const action of ["get", "list", "models"]) {
		const result = handleManagementAction(action, { agent: "worker", agentScope: "user" }, context);
		assert.notEqual(result.isError, true, action);
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		assert.ok(text.includes(brokenFile), action);
		assert.match(text, /Warning: ignoring invalid user agent definition/);
	}
});

test("fallback diagnostics follow aliases and preserve package namespaces", () => {
	const worker = { name: "worker", aliases: ["helper"], source: "builtin" };
	const broken = { name: "worker", source: "user", filePath: "/test/worker.md", error: "invalid tools" };
	assert.equal(discovery.findShadowedAgentDiagnostic("helper", worker, [broken]), broken);
	assert.equal(discovery.findBlockingAgentDiagnostic("worker", undefined, [broken]), broken);
	assert.match(discovery.formatBlockingAgentError("worker", broken), /invalid tools.*\/test\/worker\.md/);
	const packaged = { ...broken, packageSpecified: true, runtimeName: "other/worker" };
	assert.equal(discovery.findShadowedAgentDiagnostic("worker", worker, [packaged]), undefined);
	assert.equal(discovery.findBlockingAgentDiagnostic("other/worker", undefined, [packaged]), packaged);
});

test("filesystem retries bound parent stalls and preserve child durability", () => {
	const total = (delays) => delays.reduce((sum, delay) => sum + delay, 0);
	const parent = retry.resolveFileSystemRetryDelays({});
	const child = retry.resolveFileSystemRetryDelays({ PI_SUBAGENT_CHILD: "1" });
	assert.equal(total(parent), 100);
	assert.equal(total(child), 7885);
	assert.equal(parent.length, child.length);
	assert.equal(total(retry.resolveFileSystemRetryDelays({ [retry.FS_RETRY_MAX_TOTAL_MS_ENV]: "0", PI_SUBAGENT_CHILD: "1" })), 0);
	assert.throws(() => retry.resolveFileSystemRetryDelays({ [retry.FS_RETRY_MAX_TOTAL_MS_ENV]: "9007199254740992" }));
	const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
	const waits = [];
	let attempts = 0;
	assert.throws(() => retry.runFileSystemOperationWithRetry(() => { attempts++; throw busy; }, {
		retryDelaysMs: parent, wait: (ms) => waits.push(ms),
	}), (error) => error === busy);
	assert.equal(attempts, child.length + 1);
	assert.equal(total(waits), 100);
	assert.equal(retry.runFileSystemOperationWithRetry(() => "written"), "written");
});

test("combined workflow cancellation detaches every source listener when disposed", () => {
	const parent = new AbortController();
	const child = new AbortController();
	const combined = combinedAbortSignal([parent.signal, child.signal]);
	// Inspect registration directly instead of relying on GC timing.
	assert.equal(getEventListeners(parent.signal, "abort").length, 1);
	child.abort(new Error("child stopped"));
	assert.equal(combined.signal.reason.message, "child stopped");
	combined.dispose();
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	assert.equal(getEventListeners(child.signal, "abort").length, 0);
});

test("combined workflow cancellation deduplicates sources and disposal is idempotent", () => {
	const source = new AbortController();
	const combined = combinedAbortSignal([source.signal, source.signal]);
	assert.equal(getEventListeners(source.signal, "abort").length, 1);
	combined.dispose();
	combined.dispose();
	assert.equal(getEventListeners(source.signal, "abort").length, 0);
	source.abort(new Error("after disposal"));
	assert.equal(combined.signal.aborted, false);
});

test("combined workflow cancellation preserves an already aborted source reason", () => {
	const live = new AbortController();
	const stopped = new AbortController();
	const reason = new Error("already stopped");
	stopped.abort(reason);
	const combined = combinedAbortSignal([live.signal, stopped.signal, live.signal]);
	assert.equal(combined.signal.aborted, true);
	assert.equal(combined.signal.reason, reason);
	combined.dispose();
	assert.equal(getEventListeners(live.signal, "abort").length, 0);
	assert.equal(getEventListeners(stopped.signal, "abort").length, 0);
});

test("workflow child success, failure and cancellation release their source listeners", async () => {
	const OriginalController = globalThis.AbortController;
	for (const mode of ["success", "failure", "cancel", "stop-child", "already-aborted"]) {
		const parent = new OriginalController();
		const controllers = [];
		let launched = 0;
		let stopChild;
		if (mode === "already-aborted") parent.abort(new Error("fixture pre-cancelled"));
		// Track controllers created by the real workflow without changing signal semantics.
		globalThis.AbortController = class extends OriginalController {
			constructor() { super(); controllers.push(this); }
		};
		try {
			const running = runWorkflowScript({
				script: 'const child = await runs.run("one", { agent: "worker", task: "fixture" }); return child.ok;',
				timeoutMs: 2000,
				signal: parent.signal,
				registerStopChild: (stop) => { stopChild = stop; },
				launch: async (key, _params, signal) => {
					launched++;
					if (mode === "failure") throw new Error("fixture failure");
					if (mode === "cancel") parent.abort(new Error("fixture cancelled"));
					if (mode === "stop-child") assert.equal(stopChild(key, "fixture stopped"), true);
					signal.throwIfAborted();
					return { key, ok: true, output: "fixture", artifactPaths: [] };
				},
				status: async () => { throw new Error("unused status"); },
			});
			if (mode === "success") assert.equal((await running).value, true);
			else if (mode === "stop-child") {
				const result = await running;
				assert.equal(result.value, false);
				assert.equal(result.children[0].stopped, true);
				assert.equal(result.children[0].error, "fixture stopped");
			}
			else await assert.rejects(running, /fixture (?:failure|cancelled|stopped|pre-cancelled)/);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(launched, mode === "already-aborted" ? 0 : 1, mode);
			assert.equal(getEventListeners(parent.signal, "abort").length, 0, mode);
			for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0, mode);
		} finally {
			globalThis.AbortController = OriginalController;
		}
	}
});

test("model listings put the cheapest eligible routes first so explicit picks start there", () => {
	const context = { cwd: work, modelRegistry: { getAvailable: () => [
		{ provider: "openrouter", id: "~anthropic/premium", api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } },
		{ provider: "openrouter", id: "~zz/cheap-vision", api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 0.05, output: 0.3, cacheRead: 0.01, cacheWrite: 0 } },
		{ provider: "openrouter", id: "~mm/mid-vision", api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0 } },
	] } };
	const result = handleManagementAction("models", { model: "input:image" }, context);
	const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
	const order = ["~zz/cheap-vision", "~mm/mid-vision", "~anthropic/premium"].map((id) => text.indexOf(`openrouter/${id}`));
	assert.ok(order.every((index) => index > 0), text);
	assert.deepEqual([...order].sort((a, b) => a - b), order, "cheapest worst case first, premium last");
});


test("native parallel recovery preserves each child contract, rejects swapped identities and supports explicit stopped follow-up", async () => {
 const { writeAsyncStepRecoveryDescriptor, readAsyncRecoveryDescriptor, resolveAsyncResumeTarget, asyncReviveRequiresRecoveryDescriptor, applySteeringRecoveryAgentConfig } = await load("runs/background/async-resume.ts");
 const { createRunFanoutBudget } = await load("runs/shared/run-fanout-budget.ts");
 const { inspectSubagentStatus } = await load("runs/background/run-status.ts");
 const asyncDirRoot = path.join(work, "recovery-runs"), resultsDir = path.join(work, "recovery-results");
 const runId = "parallel-recovery", dir = path.join(asyncDirRoot, runId);
 fs.mkdirSync(dir, {recursive:true}); fs.mkdirSync(resultsDir, {recursive:true});
 const runFanoutBudget = createRunFanoutBudget(runId, 12);
 try {
  const sessions = [0,1].map(index => {const file=path.join(dir,`child-${index}.jsonl`);fs.writeFileSync(file,"{}\n");return file;});
  const now=Date.now();
  const status={runId,sessionId:"recovery-session",mode:"parallel",state:"failed",startedAt:now-20,lastUpdate:now,endedAt:now,
   steps:[{agent:"worker",status:"complete",sessionFile:sessions[0],exitCode:0},{agent:"worker",status:"stopped",sessionFile:sessions[1],stopped:true}]};
  fs.writeFileSync(path.join(dir,"status.json"),JSON.stringify(status));
  const deps={asyncDirRoot,resultsDir};
  const missing=resolveAsyncResumeTarget({id:runId,index:0},deps);
  assert.equal(asyncReviveRequiresRecoveryDescriptor(missing),true,"a session alone cannot reconstruct launch authority");
  assert.match(inspectSubagentStatus({id:runId},deps).content[0].text,/no retained child has a usable recovery contract/);
  for(let index=0;index<2;index++) writeAsyncStepRecoveryDescriptor(dir,index,{
   agent:"worker",task:"bounded synthetic inspection",cwd:work,model:`fixture/model-${index}`,fast:true,
   tools:index===0?["read"]:["read","grep"],excludeTools:["write","edit"],allowNestedSubagents:false,
   systemPromptMode:"replace",systemPrompt:"Inspect only the specified fixture.",inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,
   sessionFile:sessions[index],maxSubagentDepth:2,runFanoutPath:`tasks[${index}]`,thinking:"low",outputMode:"inline",agentFilePath:path.join(work,"worker.md"),
  },{sourceRunId:runId,runFanoutBudget,cwd:work});
  assert.throws(()=>resolveAsyncResumeTarget({id:runId,index:1},deps),/stopped; automatic recovery is disabled/);
  for(let index=0;index<2;index++) {
   const target=resolveAsyncResumeTarget({id:runId,index},deps,{allowStopped:true});
   assert.equal(asyncReviveRequiresRecoveryDescriptor(target),false);
   assert.equal(target.recoveryDescriptor.childIndex,index);
   assert.equal(target.recoveryDescriptor.model,`fixture/model-${index}`);
   assert.equal(target.recoveryDescriptor.runFanoutBudget.directory,runFanoutBudget.directory);
   assert.equal(target.recoveryDescriptor.runFanoutBudget.parentPath,`tasks[${index}]`);
   assert.equal(fs.statSync(path.join(dir,`recovery-descriptor-${index}.json`)).mode&0o777,0o600);
   const recovered=applySteeringRecoveryAgentConfig({tools:["bash","write"],systemPrompt:"changed"},target.recoveryDescriptor);
   assert.deepEqual(recovered.tools,index===0?["read"]:["read","grep"]);
   assert.equal(recovered.fast,true);
  }
  const inspected=inspectSubagentStatus({id:runId},deps);
  assert.equal(inspected.details.runId,runId);
  assert.deepEqual(inspected.details.statusResults.map(x=>x.status),["complete","stopped"]);
  assert.equal(inspected.details.statusResults[1].exitCode,undefined,"unknown exit is not fabricated");
  assert.equal(inspected.details.statusResults[0].usage,undefined,"status does not invent usage");
  assert.match(inspected.content[0].text,/Revive child:/);
  fs.copyFileSync(path.join(dir,"recovery-descriptor-0.json"),path.join(dir,"recovery-descriptor-1.json"));
  assert.throws(()=>readAsyncRecoveryDescriptor(dir,1),/childIndex does not match/);
  const swapped=JSON.parse(fs.readFileSync(path.join(dir,"recovery-descriptor-0.json")));
  swapped.sourceRunId="other-run";fs.writeFileSync(path.join(dir,"recovery-descriptor-0.json"),JSON.stringify(swapped));
  assert.throws(()=>resolveAsyncResumeTarget({id:runId,index:0},deps),/different source run/);
 } finally { fs.rmSync(runFanoutBudget.directory,{recursive:true,force:true}); }
});

test("get with a run id points directly to status instead of requesting an agent", () => {
 const result=handleManagementAction("get",{id:"retained-run"},{cwd:work,modelRegistry:{getAvailable:()=>[]}});
 assert.equal(result.isError,true);
 assert.match(result.content[0].text,/action: "status", id: "retained-run"/);
 assert.match(result.content[0].text,/view: "transcript"/);
});


test("async launch notices preserve independent work and native wake without polling", async () => {
 const {formatAsyncStartedMessage}=await load("runs/background/async-execution.ts");
 const notice=formatAsyncStartedMessage("Started",true);
 assert.match(notice,/Continue useful independent work/);
 assert.match(notice,/only when the remaining work depends on its result/);
 assert.match(notice,/native completion notification/);
 assert.match(notice,/Do not run sleep\/polling loops/);
 assert.doesNotMatch(notice,/Return control to the user now/);
});
