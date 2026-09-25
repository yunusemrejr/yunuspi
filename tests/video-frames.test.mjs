import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find((candidate) =>
	fs.existsSync(path.join(candidate, "extensions/media-tools.ts")),
);
assert.ok(agentRoot, "media tools ship with the distribution");

const media = await import(pathToFileURL(path.join(agentRoot, "extensions/media-tools.ts")));
const { videoFrames, gridForFrames } = media;
assert.equal(typeof videoFrames, "function", "videoFrames is exported");
assert.equal(typeof gridForFrames, "function", "gridForFrames is exported");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("contact-sheet grid prefers landscape and covers every frame", () => {
	assert.deepEqual(gridForFrames(1), { cols: 2, rows: 1 });
	assert.deepEqual(gridForFrames(4), { cols: 3, rows: 2 });
	assert.deepEqual(gridForFrames(6), { cols: 4, rows: 2 });
	assert.deepEqual(gridForFrames(12), { cols: 5, rows: 3 });
	for (let n = 1; n <= 12; n++) {
		const { cols, rows } = gridForFrames(n);
		assert.ok(cols * rows >= n, `${n} frames fit`);
		assert.ok(cols >= rows, `${n} frames prefer landscape`);
	}
});

test("frame extraction stays ordered with timestamps and a manifest", { skip: !hasFfmpeg }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-frames-"));
	try {
		const source = path.join(dir, "source.mp4");
		const rendered = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
		assert.equal(rendered.status, 0, "synthetic source renders");
		const result = await videoFrames({ path: source, times: [0.5, 1.5, 2.5, 3.5], width: 160 }, dir);
		assert.equal(result.frames.length, 4);
		assert.deepEqual(result.frames.map((f) => f.requestedSeconds), [0.5, 1.5, 2.5, 3.5]);
		for (const frame of result.frames) {
			assert.ok(frame.path.endsWith(".png") && fs.existsSync(frame.path), "frame file exists");
			assert.ok(frame.bytes > 0, "frame is nonempty");
			assert.ok(Math.abs(frame.decodedSeconds - frame.requestedSeconds) < 0.25, "decoded timestamp stays near the request");
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(result.frames[0].path), "frames.json"), "utf8"));
		assert.equal(manifest.frames.length, 4);
		assert.equal(result.contactSheet, undefined, "no sheet unless requested");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("contact sheet tiles every frame into one image with a cell map", { skip: !hasFfmpeg }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-sheet-"));
	try {
		const source = path.join(dir, "source.mp4");
		const rendered = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
		assert.equal(rendered.status, 0, "synthetic source renders");
		const result = await videoFrames({ path: source, count: 6, width: 160, contactSheet: true }, dir);
		assert.equal(result.frames.length, 6);
		const sheet = result.contactSheet;
		assert.ok(sheet.path.endsWith("contact-sheet.png") && fs.existsSync(sheet.path), "sheet file exists");
		assert.ok(sheet.bytes > 0, "sheet is nonempty");
		const probed = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", sheet.path], { encoding: "utf8" });
		assert.equal(probed.status, 0, "sheet probes");
		assert.equal(probed.stdout.trim(), "1940,732", "4x2 grid of 480x360 cells with 4px margin/padding");
		assert.deepEqual(sheet.grid, { cols: 4, rows: 2, cellWidth: 480 });
		assert.equal(sheet.cells.length, 6);
		assert.deepEqual(sheet.cells.map((c) => c.frame), [1, 2, 3, 4, 5, 6]);
		assert.deepEqual(sheet.cells[0], { frame: 1, row: 0, col: 0, requestedSeconds: result.frames[0].requestedSeconds, decodedSeconds: result.frames[0].decodedSeconds });
		assert.deepEqual([sheet.cells[5].row, sheet.cells[5].col], [1, 1]);
		const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(sheet.path), "frames.json"), "utf8"));
		assert.ok(manifest.contactSheet.path.endsWith("contact-sheet.png"), "manifest records the sheet");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("frame validation still rejects bad timestamps", { skip: !hasFfmpeg }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-frames-bad-"));
	try {
		const source = path.join(dir, "source.mp4");
		spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
		await assert.rejects(() => videoFrames({ path: source, times: [5] }, dir), /outside the source duration/);
		await assert.rejects(() => videoFrames({ path: source, times: [] }, dir), /1\.\.12 timestamps/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log("PASS video-frames: ordered parallel extraction, contact sheet with cell map, validation");
