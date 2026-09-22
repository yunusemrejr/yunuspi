import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEventListeners } from "node:events";

const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-core-robustness-"));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

const importFrom = (rel) => import(pathToFileURL(path.join(root, rel)).href);

test("session resource cleanups follow every session and are removable", async () => {
	const { registerSessionResourceCleanup, cleanupSessionResources } = await importFrom(
		"core/ai/src/session-resources.js",
	);
	const seen = [];
	const off = registerSessionResourceCleanup((sessionId) => {
		seen.push(sessionId);
	});
	assert.equal(typeof off, "function");
	cleanupSessionResources("s1");
	// A later dispose in the same process must still clean that session's
	// resources; a registry that empties itself on first use leaves every
	// subsequent session in the process with no cleanup at all.
	cleanupSessionResources("s2");
	assert.deepEqual(seen, ["s1", "s2"]);
	// The disposer is what prevents process-lifetime accumulation.
	off();
	cleanupSessionResources("s3");
	assert.deepEqual(seen, ["s1", "s2"]);
});

test("a throwing cleanup still lets remaining cleanups run", async (t) => {
	const { registerSessionResourceCleanup, cleanupSessionResources } = await importFrom(
		"core/ai/src/session-resources.js",
	);
	let secondRan = false;
	t.after(registerSessionResourceCleanup(() => {
		throw new Error("boom");
	}));
	t.after(registerSessionResourceCleanup(() => {
		secondRan = true;
	}));
	assert.throws(
		() => cleanupSessionResources("s3"),
		(error) =>
			error instanceof AggregateError &&
			error.message.includes("Failed to cleanup session resources") &&
			error.errors?.[0]?.message === "boom",
	);
	assert.equal(secondRan, true);
});

test("oauth migration forces the oauth discriminator even if the entry lies", async () => {
	const agentDir = path.join(work, "agent-auth");
	fs.mkdirSync(agentDir, { recursive: true });
	// Corrupt/hand-edited entry: type claims api_key, body is an oauth shape.
	// Values are obvious placeholders so the public scanner never reads them
	// as credentials.
	fs.writeFileSync(
		path.join(agentDir, "oauth.json"),
		JSON.stringify({
			openai: { type: "api_key", key: "REDACTED", refreshToken: "REDACTED" },
		}),
	);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// Import after workspace links exist so @yunuspi/* core packages resolve.
		const { migrateAuthToAuthJson } = await importFrom("core/coding-agent/src/migrations.js");
		const providers = migrateAuthToAuthJson();
		assert.deepEqual(providers, ["openai"]);
		const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		assert.equal(auth.openai.type, "oauth");
		assert.equal(auth.openai.refreshToken, "REDACTED");
		assert.equal(auth.openai.key, "REDACTED");
		// oauth.json is retired only after auth.json exists.
		assert.equal(fs.existsSync(path.join(agentDir, "oauth.json")), false);
		assert.equal(fs.existsSync(path.join(agentDir, "oauth.json.migrated")), true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("autocomplete applyCompletion does not turn absolute path items into slash commands", async () => {
	const { CombinedAutocompleteProvider } = await importFrom("core/tui/src/autocomplete.js");
	const provider = new CombinedAutocompleteProvider([], work);
	const item = { value: "/usr/", label: "/usr/" };
	const result = provider.applyCompletion(["/u"], 0, 2, item, "/u");
	const line = result.lines[0];
	assert.equal(line.includes("//"), false, `doubled slash in ${JSON.stringify(line)}`);
	assert.ok(line.startsWith("/usr"), `expected absolute path insert, got ${JSON.stringify(line)}`);
});

test("slash-command completion still inserts a command name at line start", async () => {
	const { CombinedAutocompleteProvider } = await importFrom("core/tui/src/autocomplete.js");
	const provider = new CombinedAutocompleteProvider([], work);
	const item = { value: "help", label: "help" };
	const result = provider.applyCompletion(["/he"], 0, 3, item, "/he");
	assert.equal(result.lines[0], "/help ");
});

test("vertex ADC false is not cached permanently across a later credential mount", async () => {
	// Import a fresh module instance so the module-level cache starts empty.
	const url = pathToFileURL(path.join(root, "core/ai/src/env-api-keys.js")).href + `?t=${Date.now()}`;
	const { getEnvApiKey } = await import(url);
	// env-api-keys lazily loads node:fs/os/path; give them a tick to bind
	// before the first probe (the same window a real startup sees).
	await new Promise((resolve) => setTimeout(resolve, 25));
	const adcPath = path.join(work, "missing-adc.json");
	const env = { GOOGLE_APPLICATION_CREDENTIALS: adcPath };
	assert.equal(getEnvApiKey("google-vertex", env), undefined);
	// Mount the credentials file mid-process (gcloud login / late bind).
	fs.writeFileSync(adcPath, "{}");
	const env2 = {
		GOOGLE_APPLICATION_CREDENTIALS: adcPath,
		GOOGLE_CLOUD_PROJECT: "demo",
		GOOGLE_CLOUD_LOCATION: "us-central1",
	};
	assert.equal(getEnvApiKey("google-vertex", env2), "<authenticated>");
});

test("skill defaults diagnose collisions and ordered external overrides keep their winner", async () => {
	const { loadSkills } = await importFrom("core/coding-agent/src/core/skills.js");
	const { CONFIG_DIR_NAME } = await importFrom("core/coding-agent/src/config.js");
	const cwd = path.join(work, "skill-project");
	const agentDir = path.join(work, "skill-agent");
	const external = path.join(work, "skill-external");
	const user = path.join(agentDir, "skills");
	const project = path.join(cwd, CONFIG_DIR_NAME, "skills");
	for (const dir of [user, project, external]) {
		fs.mkdirSync(path.join(dir, "example"), { recursive: true });
		fs.writeFileSync(path.join(dir, "example", "SKILL.md"), `---\nname: example\ndescription: Test skill.\n---\n${dir}\n`);
	}
	const defaults = loadSkills({ cwd, agentDir, includeDefaults: true, skillPaths: [] });
	assert.equal(defaults.diagnostics.filter((item) => item.type === "collision").length, 1);
	assert.equal(defaults.skills[0].filePath, path.join(user, "example", "SKILL.md"));
	const ordered = loadSkills({ cwd, agentDir, includeDefaults: false, skillPaths: [external, user] });
	assert.deepEqual(ordered.diagnostics, []);
	assert.equal(ordered.skills[0].filePath, path.join(external, "example", "SKILL.md"));
	const projectCollision = loadSkills({ cwd, agentDir, includeDefaults: false, skillPaths: [project, user] });
	assert.equal(projectCollision.diagnostics.filter((item) => item.type === "collision").length, 1);
});

test("skill discovery and package scanning visit symlink cycles only once", async () => {
	const { loadSkillsFromDir } = await importFrom("core/coding-agent/src/core/skills.js");
	const { DefaultPackageManager } = await importFrom("core/coding-agent/src/core/package-manager.js");
	const dir = path.join(work, "skill-cycle");
	fs.mkdirSync(path.join(dir, "example"), { recursive: true });
	const file = path.join(dir, "example", "SKILL.md");
	fs.writeFileSync(file, "---\nname: example\ndescription: Test skill.\n---\n");
	fs.symlinkSync(dir, path.join(dir, "loop"), "dir");
	assert.deepEqual(loadSkillsFromDir({ dir, source: "user" }).skills.map((skill) => skill.filePath), [file]);
	assert.deepEqual(DefaultPackageManager.prototype.collectFilesFromPaths([dir], "skills"), [file]);
});

test("retry without extension hooks uses the built-in retry policy", async () => {
	const { AgentSession } = await importFrom("core/coding-agent/src/core/agent-session.js");
	const message = { role: "assistant", content: [], errorMessage: "500 temporary failure" };
	const session = {
		settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
		agent: { state: { messages: [message] } },
		_retryAttempt: 0,
		_emit() {},
	};
	assert.equal(await AgentSession.prototype._prepareRetry.call(session, message), true);
	assert.equal(session._retryAttempt, 1);
	assert.equal(session._retryAbortController, undefined);
});

test("abortable sleep removes listeners after completion and cancellation", async () => {
	const { sleep } = await importFrom("core/coding-agent/src/utils/sleep.js");
	const controller = new AbortController();
	await sleep(0, controller.signal);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	const pending = sleep(60_000, controller.signal);
	controller.abort();
	await assert.rejects(pending, /Aborted/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("new, forked, and rewritten session transcripts are private under a permissive umask", async () => {
	const { SessionManager } = await importFrom("core/coding-agent/src/core/session-manager.js");
	const oldUmask = process.umask(0);
	try {
		const dir = path.join(work, "private-sessions");
		const session = SessionManager.create(work, dir);
		session.appendMessage({ role: "user", content: "Synthetic test prompt", timestamp: 1 });
		assert.equal(fs.existsSync(session.getSessionFile()), false);
		session.appendMessage({ role: "assistant", content: [], timestamp: 2 });
		session.appendCustomEntry("fixture", { ok: true });
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(session.getSessionFile()).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(session.getSessionFile(), "utf8").trim().split("\n").length, 4);
		const fork = SessionManager.forkFrom(session.getSessionFile(), work, path.join(work, "private-forks"));
		assert.equal(fs.statSync(fork.getSessionFile()).mode & 0o777, 0o600);
		fs.unlinkSync(session.getSessionFile());
		session._rewriteFile();
		assert.equal(fs.statSync(session.getSessionFile()).mode & 0o777, 0o600);
	} finally {
		process.umask(oldUmask);
	}
});

test("changing HTTP settings gracefully closes only the previously owned dispatcher", async () => {
	const undici = await import("undici");
	const { configureHttpDispatcher } = await importFrom("core/coding-agent/src/core/http-dispatcher.js");
	const original = undici.getGlobalDispatcher();
	let first;
	let second;
	try {
		configureHttpDispatcher(1000);
		first = undici.getGlobalDispatcher();
		let closed = 0;
		const close = first.close.bind(first);
		first.close = (...args) => { if (args.length === 0) closed++; return close(...args); };
		configureHttpDispatcher(2000);
		second = undici.getGlobalDispatcher();
		assert.notEqual(first, second);
		assert.equal(closed, 1);
		assert.equal(original.closed, false);
	} finally {
		undici.setGlobalDispatcher(original);
		await first?.close();
		await second?.close();
	}
});
