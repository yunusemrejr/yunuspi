import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCompletionMutationGuard } from "../agent/extensions/pi-subagents/src/runs/shared/completion-guard.ts";
import { planCompletionEvidence } from "../agent/extensions/pi-subagents/src/runs/shared/completion-evidence.ts";

const evidence = { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false };
const options = { completionGuardEnabled: true, mutationCapable: true, implementationMutationExpected: true,
  mutationAttemptObserved: false, mutationEvidence: evidence, agentContractV1: false };
const reply = (text) => [{ role: "assistant", content: [{ type: "text", text }] }];

test("a legitimate no-edit challenge pass cannot report an observed file mutation", () => {
  const task = "You are reviving a previous subagent conversation.\n\nOriginal run: fixture\nOriginal agent: worker\n\nUse the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.\n\nFollow-up:\nRun implementation challenge pass one and implement any better current-scope change.";
  const guard = evaluateCompletionMutationGuard({ agent: "worker", task, tools: ["read", "edit"],
    messages: reply("No better current-scope code changes are needed."), mutationEvidence: evidence });
  assert.equal(guard.expectedMutation, true);
  assert.equal(guard.triggered, false);
  const result = planCompletionEvidence({ ...options, guard });
  assert.equal(result.fileMutation.status, "not-applicable");
  assert.equal(result.fileMutation.attempted, false);
  assert.equal(result.legacyFailureError, undefined);
});

test("ordinary implementation still fails completion without edit evidence", () => {
  const guard = evaluateCompletionMutationGuard({ agent: "worker", task: "Implement the requested code change.",
    tools: ["read", "edit"], messages: reply("Here is the implementation plan."), mutationEvidence: evidence });
  const result = planCompletionEvidence({ ...options, guard });
  assert.equal(result.fileMutation.status, "missing");
  assert.equal(result.guardTriggered, true);
  assert.match(result.legacyFailureError, /without making edits/);
});
