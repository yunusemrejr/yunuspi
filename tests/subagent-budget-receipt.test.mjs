import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";

for (const [stepCount, parallel] of [[1, false], [2, false], [2, true]]) test(`background budget receipt and recovery persist with ${stepCount} requested step(s), parallel=${parallel}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-budget-receipt-"));
  const asyncDir = path.join(root, "async");
  const marker = path.join(root, "child-invocations");
  const resultPath = path.join(root, "result.json");
  const template = path.resolve(import.meta.dirname, "..");
  const agentRoot = [
    path.join(template, "agent"),
    path.resolve(template, "..", "agent"),
    path.resolve(template, ".."),
  ].find((candidate) => fs.existsSync(path.join(candidate, "extensions/pi-subagents/src/runs/background/subagent-runner.ts")));
  assert.ok(agentRoot, "public template resolves the subagent runner source");
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const installRoots = [
    path.join(template, "node_modules"),
    path.join(agentRoot, "npm/node_modules"),
    path.join(globalRoot, "@yunuspi/coding-agent/node_modules"),
  ];
  const jiti = [
    path.join(template, "node_modules/jiti/lib/jiti-cli.mjs"),
    path.join(template, "node_modules/@yunuspi/coding-agent/node_modules/jiti/lib/jiti-cli.mjs"),
    path.join(agentRoot, "npm/node_modules/jiti/lib/jiti-cli.mjs"),
    path.join(globalRoot, "@yunuspi/coding-agent/node_modules/jiti/lib/jiti-cli.mjs"),
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(jiti, "installed jiti runtime is available for the TypeScript runner");
  const extensionModules = path.join(agentRoot, "extensions/node_modules");
  let createdExtensionModules = false;
  const sourceHasAncestorModules = [
    extensionModules,
    path.join(agentRoot, "node_modules"),
    path.join(path.dirname(agentRoot), "node_modules"),
  ].some((candidate) => fs.existsSync(candidate));
  if (!sourceHasAncestorModules) {
    const moduleRoot = installRoots.find((candidate) => fs.existsSync(candidate));
    assert.ok(moduleRoot, "installed runtime dependencies are available for the TypeScript runner");
    fs.symlinkSync(moduleRoot, extensionModules, "dir");
    createdExtensionModules = true;
  }
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  const previousEnvironment = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SUBAGENT_PI_BINARY"].map((key) => [key, process.env[key]]));
  const events = [
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "REPORT" }],
        stopReason: "stop",
        provider: "openrouter",
        model: "free/test",
        usage: { input: 2, output: 2 },
      },
    },
  ];
  const child = path.join(root, "fake-pi");
  fs.writeFileSync(child, `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(marker)},"1\\n");for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));\n`, { mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_SUBAGENT_PI_BINARY = child;
  let stderr = "";
  const readReceipt = async () => {
    // A clean distribution compiles the runner's TypeScript dependency graph
    // on its first invocation; the live installation usually has a warm cache.
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      try { return JSON.parse(fs.readFileSync(resultPath, "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    throw new Error(`timed out waiting for the background runner receipt: ${stderr}`);
  };
  let runnerProcess, fanout;
  try {
    const runner = path.join(agentRoot, "extensions/pi-subagents/src/runs/background/subagent-runner.ts");
    const { createRunFanoutBudget } = await import(new URL("file://" + path.join(agentRoot, "extensions/pi-subagents/src/runs/shared/run-fanout-budget.ts")));
    fanout = createRunFanoutBudget("budget-receipt", 8);
    const steps = [
      { agent: "automatic-free-assistant", task: "emit the first report", model: "openrouter/free/test" },
      { agent: "automatic-free-assistant", task: parallel ? "emit the second report" : "this step must remain unscheduled", model: "openrouter/free/test" },
    ].slice(0, stepCount).map((step,index) => {
      const sessionFile=path.join(root,`session-${index}.jsonl`);fs.writeFileSync(sessionFile,"{}\n");
      return {...step,sessionFile,runFanoutPath:`tasks[${index}]`,tools:["read"],inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false};
    });
    const config = {
      id: "budget-receipt",
      steps: parallel ? [{parallel:steps}] : steps,
      runFanoutBudget: fanout,
      resultMode: parallel ? "parallel" : "chain",
      resultPath,
      cwd: root,
      placeholder: "{{previous}}",
      asyncDir,
      artifactConfig: { enabled: false },
      usageBudget: { tokens: { hard: parallel ? 100 : 1 } },
      sessionId: "budget-receipt-session",
    };
    runnerProcess = spawn(process.execPath, [jiti, runner], {
      cwd: agentRoot,
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    runnerProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    runnerProcess.stdin.end(JSON.stringify(config));
    const receipt = await readReceipt();
    assert.equal(receipt.state, parallel || stepCount === 1 ? "complete" : "failed");
    assert.equal(receipt.success, parallel || stepCount === 1);
    assert.equal(receipt.usageBudget?.exhausted, !parallel);
    if (stepCount === 2 && !parallel) assert.match(receipt.summary, /Usage budget exhausted/);
    assert.match(receipt.summary, /REPORT/);
    assert.equal(receipt.results?.length, parallel ? 2 : 1);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), parallel ? "1\n1" : "1");
    const { readAsyncRecoveryDescriptor, resolveAsyncResumeTarget, asyncReviveRequiresRecoveryDescriptor } = await import(new URL("file://" + path.join(agentRoot, "extensions/pi-subagents/src/runs/background/async-resume.ts")));
    for(let index=0;index<(parallel?2:1);index++) {
      const descriptor=readAsyncRecoveryDescriptor(asyncDir,index);
      assert.equal(descriptor.sourceRunId,"budget-receipt");
      assert.equal(descriptor.childIndex,index);
      assert.equal(descriptor.runFanoutBudget.directory,fanout.directory);
      assert.equal(descriptor.runFanoutBudget.parentPath,`tasks[${index}]`);
      assert.deepEqual(descriptor.tools,["read"]);
      const target=resolveAsyncResumeTarget({dir:asyncDir,index},{asyncDirRoot:root,resultsDir:root});
      assert.equal(target.sessionFile,steps[index].sessionFile);
      assert.equal(asyncReviveRequiresRecoveryDescriptor(target),false);
    }
    if (runnerProcess.exitCode === null && runnerProcess.signalCode === null) runnerProcess.kill("SIGTERM");
    if (runnerProcess.exitCode === null && runnerProcess.signalCode === null) await new Promise((resolve) => runnerProcess.once("close", resolve));
    assert.equal(stderr, "", `runner emitted unexpected diagnostics: ${stderr}`);
  } finally {
    if (runnerProcess && runnerProcess.exitCode === null && runnerProcess.signalCode === null) {
      runnerProcess.kill("SIGTERM");
      await new Promise((resolve) => runnerProcess.once("close", resolve));
    }
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (createdExtensionModules) fs.unlinkSync(extensionModules);
    if(fanout) fs.rmSync(fanout.directory, {recursive:true,force:true});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
