import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let agent = path.join(root, "agent");
try { await fs.access(agent); } catch { agent = path.resolve(root, ".."); }
const modulePath = (name) => path.join(agent, "extensions/lib/project-intelligence", name);
const { nodeId } = await import(pathToFileURL(modulePath("store.mjs")));
const { IntelligenceClient } = await import(pathToFileURL(modulePath("client.mjs")));
const {
  buildChangeProvenance,
  buildReviewProvenance,
  changeRecordKey,
  normalizeWorkflow,
} = await import(pathToFileURL(modulePath("workflow-record.mjs")));

const head = "a".repeat(40);
const after = "b".repeat(40);

function workflow(projectId = "project", checkoutId = "checkout", sessionId = "session") {
  return {
    projectId,
    checkoutId,
    conversation: {
      sessionId,
      branchHead: "branch-head",
      latestUserEntry: "user-entry",
      nativeCheckpoint: { entryId: "checkpoint-entry", beforeCommit: head, afterCommit: after },
    },
    projectGit: { status: "observed", head, branch: "main" },
    scope: { requestHash: "c".repeat(24) },
  };
}

test("workflow references validate ownership and keep native checkpoints separate from Git", () => {
  const normalized = normalizeWorkflow(workflow(), {
    identity: { id: "project", checkoutId: "checkout" },
    sessionId: "session",
  });
  const branchId = nodeId("branch", "project:branch:main");
  const commitId = nodeId("change", `project:commit:${head}`);
  const changeId = nodeId("change", "observed-change");
  const change = buildChangeProvenance({
    workflow: normalized,
    changeId,
    existingNodes: [branchId, commitId],
  });
  const review = buildReviewProvenance({
    workflow: normalized,
    sample: { aspect: "content", outcome: "changes" },
    existingNodes: [branchId, commitId],
  });
  const request = change.claims.find((claim) => claim.predicate === "for_request").object;
  assert.equal(review.claims.find((claim) => claim.predicate === "review_content").subject, request);
  assert.ok(change.nodes.some((node) => node.type === "checkpoint"));
  assert.ok(change.claims.some((claim) => claim.predicate === "observed_project_git_branch" && claim.object === branchId));
  assert.ok(change.claims.some((claim) => claim.predicate === "observed_project_git_commit" && claim.object === commitId));
  assert.ok(change.claims.some((claim) => claim.predicate === "native_after_commit" && claim.object === after));
  assert.doesNotMatch(JSON.stringify({ change, review }), /prompt|council|approved|private/i);
  assert.notEqual(
    changeRecordKey({ sessionId: "session", files: ["src/app.ts"], workflow: normalized }),
    changeRecordKey({ sessionId: "session", files: ["src/app.ts"], workflow: { ...normalized, conversation: { ...normalized.conversation, branchHead: "other-branch" } } }),
  );
  assert.match(changeRecordKey({ sessionId: "session", files: ["src/app.ts"] }), /^session-change:session:[a-f0-9]{16}$/);
});

test("worker links observed changes and review outcomes to the owning conversation", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-record-"));
  const cwd = path.join(temp, "project");
  const stateDir = path.join(temp, "state");
  await fs.mkdir(cwd);
  const git = (...args) => exec("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  let client;
  try {
    await git("init", "-q", "-b", "main");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "app.ts"), "export const app = true;\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture commit");
    client = new IntelligenceClient({ cwd, stateDir, sessionId: "session-1" });
    const ready = await client.ready;
    await client.request("refresh", {}, { timeout: 30000 });
    const observed = {
      ...workflow(ready.identity.id, ready.identity.checkoutId, "session-1"),
      projectGit: { status: "observed", head, branch: "main" },
    };
    // The fixture's actual commit is used for the existing Git edge; the
    // separate after value exercises a valid but not-yet-discovered reference.
    const actualHead = (await git("rev-parse", "HEAD")).stdout.trim();
    observed.projectGit.head = actualHead;
    observed.conversation.nativeCheckpoint.beforeCommit = actualHead;
    const first = await client.request("changes", { files: ["src/app.ts"], workflow: observed });
    assert.equal(first.changed, true);
    const secondWorkflow = { ...observed, conversation: { ...observed.conversation, branchHead: "other-branch" } };
    await client.request("changes", { files: ["src/app.ts"], workflow: secondWorkflow });
    const reviewResult = await client.request("review_history", {
      samples: [{ aspect: "content", outcome: "changes" }],
      workflow: observed,
    });
    assert.ok(Array.isArray(reviewResult));

    const { openStore } = await import(pathToFileURL(modulePath("store.mjs")));
    const db = openStore(ready.identity.dbPath);
    try {
      const sources = db.sources(ready.identity.checkoutId);
      const changeSources = sources.filter((source) => source.kind === "session" && source.locator === "session:session-1");
      assert.equal(changeSources.length, 2, "conversation branch identity keeps same-file changes distinct");
      const changeSummary = changeSources.find((source) => source.id.includes("session-change:session-1:"));
      const changeSource = db.source(changeSummary.id);
      assert.ok(changeSource.nodes.some((node) => node.type === "checkpoint"));
      assert.ok(changeSource.claims.some((claim) => claim.predicate === "observed_project_git_head" && claim.object === actualHead));
      assert.ok(changeSource.claims.some((claim) => claim.predicate === "observed_project_git_branch"));
      const request = changeSource.claims.find((claim) => claim.predicate === "for_request").object;
      const reviewSummary = sources.find((source) => source.locator.includes("session-review:") && source.locator.endsWith(":content"));
      const reviewSource = reviewSummary && db.source(reviewSummary.id);
      assert.ok(reviewSource);
      assert.ok(reviewSource.claims.some((claim) => claim.predicate === "review_content" && claim.subject === request && claim.object === "changes"));
      assert.doesNotMatch(JSON.stringify(sources), /approved|council|prompt|Fixture commit/);
    } finally {
      db.close();
    }
    await assert.rejects(
      client.request("changes", {
        files: ["src/app.ts"],
        workflow: { ...observed, checkoutId: "other-checkout" },
      }),
      (error) => error.code === "WORKFLOW_SCOPE_MISMATCH",
    );
  } finally {
    await client?.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
