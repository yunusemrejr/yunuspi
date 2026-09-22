#!/usr/bin/env node
// Repeatable, offline Guardian microbenchmark. No model calls, user files or
// shared relay directories. Run: node --expose-gc scripts/guardian/benchmark.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GuardianSupervisor, tagGuardianRequestMessage } from "../../core/coding-agent/dist/core/guardian/guardian-supervisor.js";
import { GuardianKernelRuntime } from "../../core/coding-agent/dist/core/guardian/guardian-kernels.js";

function cpuMs(start) { const cpu = process.cpuUsage(start); return (cpu.user + cpu.system) / 1000; }
function sampleLatency(run, count = 5000) {
	for (let index = 0; index < 250; index++) run();
	const samples = [];
	for (let index = 0; index < count; index++) { const start = performance.now(); run(); samples.push((performance.now() - start) * 1000); }
	samples.sort((a, b) => a - b);
	return { iterations: count, medianUs: samples[Math.floor(count / 2)], p95Us: samples[Math.floor(count * 0.95)] };
}
async function scenario(sessionCount, cycles = 500) {
	global.gc?.();
	const before = process.memoryUsage();
	const supervisors = [];
	let interventions = 0;
	for (let index = 0; index < sessionCount; index++) {
		const sessionId = `bench-${process.pid}-${index}`;
		const supervisor = new GuardianSupervisor({ sessionId, emit: () => { interventions++; } });
		const meta = supervisor.beginRequest({ requestId: `request-${index}`, source: "rpc", originalText: "Fix the parser." });
		supervisor.acceptRequest(meta.requestId);
		await supervisor.observeAgentEvent({ type: "message_start", message: tagGuardianRequestMessage({ role: "user", content: [{ type: "text", text: "Fix the parser." }] }, meta) });
		supervisors.push(supervisor);
	}
	const start = performance.now(), cpu = process.cpuUsage();
	await Promise.all(supervisors.map(async (supervisor) => {
		for (let cycle = 0; cycle < cycles; cycle++) {
			const toolCallId = `call-${cycle}`;
			await supervisor.observeAgentEvent({ type: "tool_execution_start", toolName: "edit", toolCallId, args: { path: "src/parser.js", oldText: "a", newText: "b" } });
			await supervisor.observeAgentEvent({ type: "tool_execution_end", toolName: "edit", toolCallId, isError: true, result: { content: [{ type: "text", text: "ENOENT" }] } });
			await supervisor.observeAgentEvent({ type: "message_end", message: { role: "assistant", content: [] } });
		}
	}));
	const wallMs = performance.now() - start, activeCpuMs = cpuMs(cpu);
	global.gc?.();
	const after = process.memoryUsage();
	assert.equal(interventions, sessionCount);
	const result = { sessions: sessionCount, events: sessionCount * cycles * 3, wallMs, activeCpuMs, meanEventUs: wallMs * 1000 / (sessionCount * cycles * 3), interventions,
		heapBytesPerSession: (after.heapUsed - before.heapUsed) / sessionCount,
		arrayBufferBytesPerSession: (after.arrayBuffers - before.arrayBuffers) / sessionCount,
		wasmMemoryBytesPerSession: 2 * 131072,
	};
	const idleCpu = process.cpuUsage(), idleStart = performance.now();
	await new Promise((resolve) => setTimeout(resolve, 250));
	result.idle = { wallMs: performance.now() - idleStart, cpuMs: cpuMs(idleCpu), note: "Process-wide CPU; one benchmark sleep timer, Guardian has no idle timer." };
	for (const supervisor of supervisors) supervisor.dispose();
	return result;
}
if (process.argv.includes("--worker")) {
	console.log(JSON.stringify(await scenario(8)));
} else {
	const kernel = new GuardianKernelRuntime();
	const coldStart = performance.now();
	await kernel.initialize();
	const coldInitMs = performance.now() - coldStart;
	const features = new Array(12).fill(1000);
	assert.ok(kernel.evaluate(features).probability >= 9500);
	const wasm = { coldInitMs, classifier: sampleLatency(() => kernel.evaluate(features)), similarity: sampleLatency(() => kernel.similarity("edit|newText:string|oldText:string|path:string", "edit|newText:string|oldText:string|path:string")) };
	const sessions = [];
	for (const count of [1, 16, 64]) sessions.push(await scenario(count));
	const workersStarted = performance.now();
	const workers = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker"], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "", error = "";
		child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
		child.on("error", reject); child.on("close", (code) => { if (code !== 0) reject(new Error(error || `worker exited ${code}`)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
	})));
	console.log(JSON.stringify({ format: "yunuspi-guardian-benchmark-v1", node: process.version, platform: process.platform, gcAvailable: Boolean(global.gc), wasm, sessions,
		processes: { count: workers.length, sameWorkingDirectory: true, wallMs: performance.now() - workersStarted, workers },
		limits: "Offline supervisor and kernel measurements, not whole-agent inference or child-relay UI latency. Heap deltas include allocator/JIT noise; WASM memory is reported separately. CPU includes Node runtime and GC." }, null, 2));
}
