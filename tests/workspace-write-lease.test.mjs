import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((candidate) =>
	fs.existsSync(path.join(candidate, "extensions/lib/workspace-write-lease.ts")),
);
const {
	acquireWorkspaceWriterLease,
	attributeWorkspacePath,
	recordWorkspaceMutation,
	releaseWorkspaceWriterLease,
	readWorkspaceGitState,
	workspaceFileSha256,
	workspaceGitDrift,
} = await import(pathToFileURL(path.join(agent, "extensions/lib/workspace-write-lease.ts")));

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("writer leases attribute concrete paths and surface overlap without blocking", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-writer-"));
	try {
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@example.invalid");
		git(dir, "config", "user.name", "YunusPi test");
		fs.writeFileSync(path.join(dir, "src.txt"), "before");
		git(dir, "add", "src.txt");
		git(dir, "commit", "-qm", "fixture");
		const first = acquireWorkspaceWriterLease(dir, "session-a");
		assert.equal(first.conflicts.length, 0);
		const second = acquireWorkspaceWriterLease(dir, "session-b");
		assert.equal(second.conflicts[0]?.sessionId, "session-a");
		const mutation = recordWorkspaceMutation(dir, "session-a", "src.txt", "write");
		assert.equal(mutation?.path, "src.txt");
		assert.equal(mutation?.sha256, workspaceFileSha256(path.join(dir, "src.txt")));
		const overlap = recordWorkspaceMutation(dir, "session-b", "src.txt", "edit");
		assert.equal(overlap?.conflicts[0]?.sessionId, "session-a");
		assert.equal(attributeWorkspacePath(dir, "session-b", "src.txt").status, "another_session");
		releaseWorkspaceWriterLease(dir, "session-a");
		assert.equal(attributeWorkspacePath(dir, "session-b", "src.txt").status, "current_session");
		// Shell-made changes never name a path; while another writer is active they stay ambiguous.
		acquireWorkspaceWriterLease(dir, "session-c");
		assert.equal(attributeWorkspacePath(dir, "session-b", "generated.txt").status, "unattributed");
		releaseWorkspaceWriterLease(dir, "session-c");
		const sole = attributeWorkspacePath(dir, "session-b", "generated.txt");
		assert.deepEqual([sole.status, sole.detail], ["current_session", "sole active writer in this checkout"]);
		releaseWorkspaceWriterLease(dir, "session-b");
		assert.equal(attributeWorkspacePath(dir, "session-b", "generated.txt").status, "unattributed", "no lease, no ownership claim");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Git drift reports a moved HEAD between observations", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-git-drift-"));
	try {
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@example.invalid");
		git(dir, "config", "user.name", "YunusPi test");
		fs.writeFileSync(path.join(dir, "state.txt"), "one");
		git(dir, "add", "state.txt");
		git(dir, "commit", "-qm", "one");
		const before = readWorkspaceGitState(dir);
		fs.writeFileSync(path.join(dir, "state.txt"), "two");
		git(dir, "add", "state.txt");
		git(dir, "commit", "-qm", "two");
		const warnings = workspaceGitDrift(before, readWorkspaceGitState(dir));
		assert.ok(warnings.some((warning) => /HEAD moved/.test(warning)));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
