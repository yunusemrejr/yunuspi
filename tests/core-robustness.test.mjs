import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

test("a throwing cleanup still lets remaining cleanups run", async () => {
	const { registerSessionResourceCleanup, cleanupSessionResources } = await importFrom(
		"core/ai/src/session-resources.js",
	);
	let secondRan = false;
	registerSessionResourceCleanup(() => {
		throw new Error("boom");
	});
	registerSessionResourceCleanup(() => {
		secondRan = true;
	});
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
