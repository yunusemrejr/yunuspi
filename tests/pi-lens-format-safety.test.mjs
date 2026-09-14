import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Resolve either the live source tree or the standalone release being tested.
const candidates = [
	path.resolve(import.meta.dirname, "../agent"),
	path.resolve(import.meta.dirname, "../.."),
	path.resolve(import.meta.dirname, "../../agent"),
];
const agentRoot = candidates.find((dir) =>
	fs.existsSync(path.join(dir, "scripts/patches/pi-lens-format-safety.mjs")),
);

test("pi-lens formatter safety patch is applied and idempotent", async (t) => {
	if (!agentRoot) {
		t.skip("bundled pi-lens fork is not part of this standalone public export");
		return;
	}
	const patchPath = path.join(agentRoot, "scripts/patches/pi-lens-format-safety.mjs");
	const distPath = path.join(agentRoot, "extensions/pi-lens/dist/index.js");
	if (!fs.existsSync(distPath)) {
		t.skip("bundled pi-lens dist is unavailable on this host");
		return;
	}
	const { isAppliedSource, patchSource } = await import(pathToFileURL(patchPath));
	const source = fs.readFileSync(distPath, "utf8");
	assert.equal(isAppliedSource(source), true);
	assert.equal(patchSource(source), source, "the source-owned patch remains idempotent");
	assert.match(source, /findUp\(\["\.prettierignore"\], cwd\)/);
	assert.match(source, /embedded-language-formatting/, "on-write embedded formatting guard is present");
	assert.match(source, /inline SVG preservation/, "inline SVG byte-preservation guard is present");
});
