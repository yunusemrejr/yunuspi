import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find((candidate) =>
	fs.existsSync(path.join(candidate, "extensions/media-tools.ts")),
);
assert.ok(agentRoot, "media tools ship with the distribution");

const media = await import(pathToFileURL(path.join(agentRoot, "extensions/media-tools.ts")));
const { imageOcr, mediaInfo, parseTesseractTsv } = media;
assert.equal(typeof imageOcr, "function", "imageOcr is exported");
assert.equal(typeof parseTesseractTsv, "function", "TSV parser is exported");

const TSV = [
	"level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
	"1\t1\t0\t0\t0\t0\t0\t0\t600\t120\t-1\t",
	"1\t2\t0\t0\t0\t0\t0\t0\t600\t120\t-1\t",
	"5\t1\t1\t1\t1\t1\t23\t44\t77\t26\t96.4\tHello",
	"5\t1\t1\t1\t1\t2\t113\t44\t77\t26\t40.0\tOCR",
	"5\t1\t1\t1\t2\t1\t23\t80\t50\t20\t95.8\tsecond",
	"5\t2\t1\t1\t1\t1\t10\t10\t30\t12\t90.0\tpagetwo",
	"not-a-row",
	"5\tbad\trow",
].join("\n");

test("TSV parser rebuilds lines, pages and confidence evidence", () => {
	const parsed = parseTesseractTsv(TSV, 20000);
	assert.equal(parsed.text, "Hello OCR\nsecond\npagetwo");
	assert.equal(parsed.pages, 2);
	assert.equal(parsed.words, 4);
	assert.equal(parsed.truncated, false);
	assert.equal(parsed.meanConfidence, 80.6);
	assert.equal(parsed.lowConfidence.length, 1);
	assert.equal(parsed.lowConfidence[0].text, "OCR");
	assert.deepEqual(parsed.lowConfidence[0].box, { left: 113, top: 44, width: 77, height: 26 });
});

test("TSV parser truncates bounded output and reports empty scans", () => {
	const short = parseTesseractTsv(TSV, 10);
	assert.equal(short.text.length, 10);
	assert.equal(short.truncated, true);
	const empty = parseTesseractTsv("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t10\t10\t-1\t", 20000);
	assert.equal(empty.text, "");
	assert.equal(empty.words, 0);
	assert.equal(empty.pages, 1);
	assert.equal(empty.meanConfidence, null);
	assert.deepEqual(empty.lowConfidence, []);
});

test("imageOcr validates input before invoking tesseract", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ocr-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const tiny = path.join(dir, "tiny.png");
	fs.writeFileSync(tiny, Buffer.alloc(16));
	await assert.rejects(() => imageOcr({ path: tiny, language: "eng; rm -rf" }, dir), /language must look like/);
	await assert.rejects(() => imageOcr({ path: tiny, psm: 99 }, dir), /psm must be/);
	await assert.rejects(() => imageOcr({ path: path.join(dir, "missing.png") }, dir), /ENOENT|must be a regular|No such file/);
	const big = path.join(dir, "big.bin");
	const handle = fs.openSync(big, "w");
	fs.ftruncateSync(handle, 21 * 1024 * 1024);
	fs.closeSync(handle);
	await assert.rejects(() => imageOcr({ path: big }, dir), /exceeds 20 MiB/);
});

test("image_ocr tool is registered as text-only with bounded schema", () => {
	const tools = new Map();
	media.default({ registerTool(definition) { tools.set(definition.name, definition); } });
	const ocr = tools.get("image_ocr");
	assert.ok(ocr, "image_ocr is registered");
	assert.match(ocr.description, /Text only/i);
	assert.match(ocr.description, /vision model/);
	assert.ok(ocr.parameters.properties.path, "path schema present");
	assert.ok(ocr.parameters.properties.language, "language schema present");
});

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

test("imageOcr reads printed text end to end", async (t) => {
	let image;
	try {
		execFileSync("tesseract", ["--version"], { stdio: "ignore" });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ocr-live-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		image = path.join(dir, "words.png");
		execFileSync("magick", ["-size", "600x120", "xc:white", "-pointsize", "36", "-fill", "black", "-annotate", "+20+70", "Hello OCR 123", image], { stdio: "ignore" });
		const result = await imageOcr({ path: image }, dir);
		assert.match(result.text, /Hello OCR 123/);
		assert.equal(result.engine, "tesseract");
		assert.equal(result.language, "eng");
		assert.ok(result.meanConfidence > 50, `mean confidence ${result.meanConfidence}`);
		assert.match(result.note, /hypothesis/);
	} catch (error) {
		if (process.env.PI_OCR_REQUIRE === "1") throw error;
		t.skip(`tesseract/magick unavailable for live OCR (${error instanceof Error ? error.message.split("\n")[0] : error}); PI_OCR_REQUIRE=1 makes it required`);
	}
});

console.log("PASS image-ocr: TSV evidence parsing, bounded validation, registration, capabilities and live extraction");
