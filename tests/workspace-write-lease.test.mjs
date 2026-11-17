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

test("starting a nested checkout moves attribution and releases the former checkout lease", (t) => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-nested-checkout-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const child = path.join(parent, "nested");
	fs.mkdirSync(child);
	fs.writeFileSync(path.join(child, "asset.txt"), "fixture");
	const init = (cwd, branch) => {
		git(cwd, "init", "-qb", branch);
		git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	};
	init(parent, "outer");
	const writer = "writer-moving-to-nested-repo";
	assert.equal(readWorkspaceGitState(child).root, parent);
	assert.equal(recordWorkspaceMutation(child, writer, "asset.txt", "edit").path, "nested/asset.txt");
	assert.equal(attributeWorkspacePath(parent, "observer", "nested/asset.txt").status, "another_session");

	init(child, "inner");
	const observed = readWorkspaceGitState(child);
	assert.equal(observed.root, git(child, "rev-parse", "--show-toplevel"));
	assert.equal(observed.branch, "inner");
	assert.equal(recordWorkspaceMutation(child, writer, "asset.txt", "edit").path, "asset.txt");
	assert.equal(attributeWorkspacePath(parent, "observer", "nested/asset.txt").status, "unattributed");
	assert.equal(attributeWorkspacePath(child, "observer", "asset.txt").sessionId, writer);
	releaseWorkspaceWriterLease(child, writer);
	assert.equal(attributeWorkspacePath(child, "observer", "asset.txt").status, "unattributed");
});

test("sibling worktrees sharing a common Git directory own different files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-writer-worktrees-"));
	try {
		const first = path.join(dir, "first");
		const second = path.join(dir, "second");
		fs.mkdirSync(first);
		git(first, "init", "-q");
		git(first, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
		git(first, "worktree", "add", "--detach", "-q", second);
		assert.equal(readWorkspaceGitState(first).commonDir, readWorkspaceGitState(second).commonDir);
		recordWorkspaceMutation(first, "first-session", "src.txt", "edit");
		assert.deepEqual(acquireWorkspaceWriterLease(second, "second-session").conflicts, []);
		assert.deepEqual(recordWorkspaceMutation(second, "second-session", "src.txt", "edit").conflicts, []);
		assert.equal(attributeWorkspacePath(second, "second-session", "src.txt").status, "current_session");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
