import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find((candidate) =>
	fs.existsSync(path.join(candidate, "extensions/media-tools.ts")),
);
assert.ok(agentRoot, "media tools ship with the distribution");

const media = await import(pathToFileURL(path.join(agentRoot, "extensions/media-tools.ts")));
const { mediaInfo } = media;

test("media_info capabilities report tesseract availability", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ocr-"));
	try {
		const result = await mediaInfo({ action: "capabilities" }, dir);
		assert.ok(result.tesseract, "tesseract capability is reported");
		assert.equal(typeof result.tesseract.available, "boolean");
		if (result.tesseract.available) {
			assert.ok(result.tesseract.version.startsWith("tesseract"), `version line: ${result.tesseract.version}`);
			assert.ok(Array.isArray(result.tesseract.languages), "installed languages are listed");
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log("PASS image-ocr: media_info reports tesseract availability");
