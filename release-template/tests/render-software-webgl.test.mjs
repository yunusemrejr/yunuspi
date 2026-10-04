import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A page that draws with WebGL used to be a verification dead end for render_see, ui_explore,
// visual_diff, visual_review, motion_inspect and creative_compare: the isolated browser ran with
// WebGL off and rejected the page ("open it in browser_session"). A Three.js hero is exactly the
// kind of page a rich site is built around. The capture now retries once with software WebGL
// (SwiftShader: CPU rasterization, still sandboxed, no GPU device access).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "scripts/render-capture.mjs")));
const { renderCapture } = await import(pathToFileURL(path.join(agent, "scripts/render-capture.mjs")));

function skipWithoutBrowser(t, error) {
	if (process.env.PI_BROWSER_REQUIRE === "1" || !/browserType\.launch|browser startup failure/i.test(String(error?.message))) throw error;
	t.skip("Chromium unavailable; PI_BROWSER_REQUIRE=1 requires it");
}
const WEBGL_PAGE = `<!doctype html><meta charset="utf-8"><title>pending</title><body style="margin:0"><canvas id="c" width="64" height="64"></canvas><script>
const gl = document.getElementById("c").getContext("webgl", { preserveDrawingBuffer: true });
if (gl) { gl.clearColor(0.9, 0.3, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); const px = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); document.title = "px:" + Array.from(px).join(","); }
else document.title = "no-webgl";
</script>`;
const PLAIN_PAGE = `<!doctype html><meta charset="utf-8"><title>plain</title><body><h1>No canvas here</h1>`;
const WEBGPU_PAGE = `<!doctype html><meta charset="utf-8"><title>gpu</title><script>void navigator.gpu;</script><body>WebGPU probe`;

function fixtures(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-webgl-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const write = (name, html) => { const file = path.join(dir, name); fs.writeFileSync(file, html); return file; };
	return { dir, webgl: write("webgl.html", WEBGL_PAGE), plain: write("plain.html", PLAIN_PAGE), webgpu: write("webgpu.html", WEBGPU_PAGE) };
}

test("a WebGL page is captured in software instead of being rejected, with real pixels", { timeout: 120000 }, async (t) => {
	const { dir, webgl } = fixtures(t);
	try {
		const inspected = await renderCapture({ source: webgl, output: "text", width: 320, height: 200 }, path.join(dir, "t.png"));
		assert.equal(inspected.pageState.title, "px:230,77,51,255", "the page read its own rendered pixel back: the clear color, not a blank canvas");
		assert.equal(inspected.conditions.webgl, "software", "the receipt says how WebGL was rendered");
		assert.match(inspected.renderer, /SwiftShader/);
		assert.deepEqual(inspected.errors, [], "the rasterizer's own performance notes are not reported as page errors");

		const image = await renderCapture({ source: webgl, output: "image", width: 320, height: 200 }, path.join(dir, "i.png"));
		assert.equal(image.status, "captured");
		assert.match(image.limitations, /software.*no GPU access/s);
		assert.match(image.limitations, /frame timing and shader cost are not representative/);
		assert.ok(fs.statSync(path.join(dir, "i.png")).size > 200);
	} catch (error) { skipWithoutBrowser(t, error); }
});

test("an ordinary page keeps the strict first pass: no WebGL, no software label", { timeout: 120000 }, async (t) => {
	const { dir, plain } = fixtures(t);
	try {
		const image = await renderCapture({ source: plain, output: "image", width: 320, height: 200 }, path.join(dir, "p.png"));
		assert.equal(image.conditions.webgl, undefined);
		assert.match(image.limitations, /WebGL\/GPU disabled and attempts rejected/);
		assert.doesNotMatch(image.renderer, /SwiftShader/);
	} catch (error) { skipWithoutBrowser(t, error); }
});

test("WebGPU stays rejected, and a budget too small for a second pass keeps the original rejection", { timeout: 120000 }, async (t) => {
	const { dir, webgl, webgpu } = fixtures(t);
	try {
		await assert.rejects(renderCapture({ source: webgpu, output: "image", width: 320, height: 200 }, path.join(dir, "g.png")), /unsupported gpu\/webgl/i);
		await assert.rejects(renderCapture({ source: webgl, output: "image", width: 320, height: 200, timeoutMs: 3000 }, path.join(dir, "s.png")), /unsupported gpu\/webgl/i,
			"with under four seconds there is no room for a retry, so the page is rejected as before");
	} catch (error) { skipWithoutBrowser(t, error); }
});

test("software WebGL can also be requested up front and is not retried again", { timeout: 120000 }, async (t) => {
	const { dir, webgl, webgpu } = fixtures(t);
	try {
		const direct = await renderCapture({ source: webgl, output: "text", width: 320, height: 200, webgl: "software" }, path.join(dir, "d.png"));
		assert.equal(direct.pageState.title, "px:230,77,51,255");
		await assert.rejects(renderCapture({ source: webgpu, output: "text", width: 320, height: 200, webgl: "software" }, path.join(dir, "w.png")), /unsupported gpu\/webgl/i,
			"WebGPU is rejected in software mode too");
	} catch (error) { skipWithoutBrowser(t, error); }
});
