import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateScene, scenePreset, sampleKeys, SCENE_LIMITS } from '../../scripts/scene-model.mjs';
import { sceneRuntime } from '../../scripts/scene-runtime.mjs';
import { FFMPEG_FLAGS, inputArgs, inputFile, number, outputFolder, probe, produced, requireStream, run } from './media-process.ts';
import { createRenderQueue } from './render-queue.ts';

const require = createRequire(new URL('../../npm/package.json', import.meta.url));
const dataModule = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
export function sceneCapabilities() {
  try {
    const three = require('three');
    require.resolve('playwright');
    return { available: true, threeRevision: three.REVISION, rendering: 'WebGL2 via sandboxed Chromium; availability of an actual browser/GPU backend is verified only by scene_render', formats: ['scene.json', 'standalone HTML', 'PNG', 'H.264 MP4'], styles: ['studio', 'clay', 'toon', 'wireframe', 'luminous'] };
  } catch {
    return { available: false, reason: 'Bundled Three.js/Playwright dependency unavailable; repair the harness dependency installation before rendering.' };
  }
}
let modules: Promise<{ three: string; room: string; license: string }> | undefined;
async function bundledModules() {
  return modules ??= (async () => {
    const directory = path.dirname(require.resolve('three'));
    const core = dataModule(await fs.readFile(path.join(directory, 'three.core.min.js'), 'utf8'));
    const module = await fs.readFile(path.join(directory, 'three.module.min.js'), 'utf8');
    if (!module.includes('./three.core.min.js')) throw Error('Unsupported Three.js bundle layout');
    const three = dataModule(module.replaceAll('./three.core.min.js', core));
    const room = dataModule(await fs.readFile(path.join(directory, '../examples/jsm/environments/RoomEnvironment.js'), 'utf8'));
    return { three, room, license: await fs.readFile(path.join(directory, '../LICENSE'), 'utf8') };
  })().catch(error => { modules = undefined; throw error; });
}
const jsonForHtml = (value: unknown) => JSON.stringify(value, null, 2).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export async function sceneHtml(scene: any, capture = false) {
  const { three, room, license } = await bundledModules();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; object-src 'none'"><title>Local 3D scene studio</title>
<!-- Bundled Three.js license (retained when this standalone HTML is shared):
${license.replaceAll('--', '- -')}
-->
<style>*{box-sizing:border-box}body{margin:0;background:#0d131c;color:#e2eaf2;font:14px system-ui,sans-serif}main{max-width:${scene.width}px;margin:auto}canvas{display:block;width:100%;height:auto;aspect-ratio:${scene.width}/${scene.height}}.stage{position:relative;overflow:hidden}.post{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}header,footer{padding:18px 20px;display:flex;align-items:center;gap:16px}header{justify-content:space-between;font-size:12px;letter-spacing:.08em}h1{font-size:13px;font-weight:500;margin:0}button{background:#e2eaf2;border:0;border-radius:4px;padding:8px 18px;color:#152437;cursor:pointer}input{flex:1;accent-color:#e4b26c}small{color:#91a2b8}body.capture header,body.capture footer{display:none}</style>
<body class="${capture ? 'capture' : ''}"><main><header><h1 id="title"></h1><small>LOCAL 3D / EDIT SCENE JSON IN THIS FILE</small></header><div class="stage"><canvas aria-label="Animated 3D scene"></canvas></div><footer><button id="play">Play</button><input id="seek" aria-label="Animation time" type="range" min="0" step="0.01" value="0"><span id="time"></span></footer></main>
<script id="scene" type="application/json">${jsonForHtml(scene)}</script>
<script type="importmap">${JSON.stringify({ imports: { three } })}</script>
<script type="module">import * as THREE from 'three';import {RoomEnvironment} from '${room}';try{(${sceneRuntime.toString()})(THREE,RoomEnvironment,JSON.parse(document.querySelector('#scene').textContent),${sampleKeys.toString()});}catch(error){window.sceneStudioError=String(error);document.querySelector('#title').textContent='Renderer failed: '+String(error);}</script></body></html>`;
}

export async function sceneCreate(params: any, cwd: string, signal?: AbortSignal) {
  if (params.scene !== undefined && (params.preset !== undefined || params.style !== undefined)) throw Error('Provide scene or preset/style, not both');
  const scene = params.scene === undefined ? scenePreset(params.preset, params.style) : validateScene(params.scene);
  signal?.throwIfAborted();
  const html = await sceneHtml(scene), { license } = await bundledModules();
  signal?.throwIfAborted();
  const dir = await outputFolder(params.outputDir, cwd);
  try {
    await fs.writeFile(path.join(dir, 'scene.json'), JSON.stringify(scene, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'scene.html'), html, { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'THREE-LICENSE.txt'), license, { flag: 'wx' });
    signal?.throwIfAborted();
    return { scene: await produced(path.join(dir, 'scene.json')), preview: await produced(path.join(dir, 'scene.html')), format: 'YunusPi scene v1', style: scene.style, duration: scene.duration, objects: scene.objects.length, tracks: scene.tracks.length, rendered: false, note: 'Editable self-contained HTML and scene JSON. Preview is not render evidence; use scene_render then inspect frames. Rotation uses radians; interpolation ease belongs to the outgoing key. No external assets or scripts.' };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

const acquireRender = createRenderQueue(4);
async function readSceneJson(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw Error('Scene input must be a regular file');
    // Bound the read itself, including a file that grows after inputFile/stat.
    const buffer = Buffer.alloc(SCENE_LIMITS.jsonBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > SCENE_LIMITS.jsonBytes) throw Error('Scene JSON exceeds 256 KiB');
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } finally { await handle.close(); }
}
export async function sceneRender(params: any, cwd: string, signal?: AbortSignal) {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const file = await inputFile(params.path, cwd);
  const source = await readSceneJson(file);
  const scene = validateScene({ ...source, ...(params.width === undefined ? {} : { width: params.width }), ...(params.height === undefined ? {} : { height: params.height }), ...(params.fps === undefined ? {} : { fps: params.fps }) });
  const mode = params.mode ?? 'video';
  if (!['frame', 'video'].includes(mode)) throw Error('mode must be frame or video');
  const time = number(params.time, 0, 0, scene.duration, 'time');
  if (mode === 'video' && params.time !== undefined) throw Error('time is only supported for frame rendering');
  if (mode === 'frame' && params.audio !== undefined) throw Error('audio requires video mode');
  const audio = params.audio === undefined ? undefined : await inputFile(params.audio, cwd);
  if (audio) requireStream(await probe(audio, bounded), 'audio');
  const html = await sceneHtml(scene, true);
  const release = await acquireRender(bounded);
  let browser: any, dir: string | undefined;
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  bounded.addEventListener('abort', closeOnAbort, { once: true });
  try {
    bounded.throwIfAborted();
    dir = await outputFolder(params.outputDir, cwd);
    const { chromium } = require('playwright');
    browser = await chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? 'chrome', headless: true, chromiumSandbox: true, timeout: 15_000, args: ['--use-angle=swiftshader'] });
    bounded.throwIfAborted();
    const context = await browser.newContext({ viewport: { width: scene.width, height: scene.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    await context.route('**/*', (route: any) => route.request().url() === 'http://yunuspi-scene.invalid/' && route.request().isNavigationRequest()
      ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => { if (errors.length < 5) errors.push(String(error).slice(0, 500)); });
    await page.goto('http://yunuspi-scene.invalid/', { waitUntil: 'load', timeout: 20_000 });
    await page.waitForFunction(() => (window as any).sceneStudio || (window as any).sceneStudioError, undefined, { timeout: 20_000 });
    const failure = await page.evaluate(() => (window as any).sceneStudioError);
    if (failure || errors.length) throw Error(`3D renderer failed: ${failure ?? errors.join('; ')}`);
    const frames = mode === 'frame' ? 1 : Math.ceil(scene.duration * scene.fps);
    const frameDir = path.join(dir, 'frames'); await fs.mkdir(frameDir);
    let bytes = 0, metrics: any;
    for (let i = 0; i < frames; i++) {
      bounded.throwIfAborted();
      metrics = await page.evaluate((t: number) => (window as any).sceneStudio.renderAt(t), mode === 'frame' ? time : i / scene.fps);
      const image = await page.locator('.stage').screenshot({ type: 'png', animations: 'disabled', timeout: 15_000 });
      bytes += image.length;
      if (bytes > 512 * 1024 * 1024) throw Error('Rendered frames exceed the 512 MiB disk budget');
      await fs.writeFile(path.join(frameDir, `${String(i).padStart(6, '0')}.png`), image, { flag: 'wx' });
    }
    await browser.close(); browser = undefined;
    bounded.throwIfAborted();
    const poster = path.join(dir, 'poster.png');
    await fs.copyFile(path.join(frameDir, '000000.png'), poster, fs.constants.COPYFILE_EXCL);
    let video: any, output: any;
    if (mode === 'video') {
      const outputPath = path.join(dir, 'scene.mp4');
      const args = [...FFMPEG_FLAGS, '-v', 'error', '-framerate', String(scene.fps), '-i', path.join(frameDir, '%06d.png')];
      if (audio) args.push(...inputArgs(audio, 0));
      args.push('-map', '0:v:0');
      if (audio) args.push('-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k');
      args.push('-t', String(frames / scene.fps), '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', outputPath);
      await run('ffmpeg', args, bounded);
      output = await probe(outputPath, bounded);
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(outputPath, 0), '-f', 'null', '-'], bounded);
      video = await produced(outputPath);
    }
    // Keep a few meaningful samples, not hundreds of temporary frame files.
    const samples = [];
    for (const index of [...new Set(mode === 'frame' ? [0] : [0, Math.floor((frames - 1) / 2), frames - 1])]) {
      const sample = path.join(dir, `sample-${index}.png`);
      await fs.copyFile(path.join(frameDir, `${String(index).padStart(6, '0')}.png`), sample, fs.constants.COPYFILE_EXCL);
      samples.push({ ...await produced(sample), time: mode === 'frame' ? time : index / scene.fps });
    }
    await fs.rm(frameDir, { recursive: true });
    const result = { source: file, mode, poster: await produced(poster), samples, ...(video ? { video, output, decodeVerified: true } : {}), frames, fps: scene.fps, width: scene.width, height: scene.height, duration: mode === 'video' ? frames / scene.fps : 0, metrics, audio: audio ?? null, timing: 'Frames sample absolute time i/fps, ending before duration; encoded duration rounds up to a whole frame. Pixel identity is only expected for the same renderer/platform.', note: 'Actual Three.js/WebGL pixels. Inspect composition and representative motion/audio before calling the result finished.' };
    await fs.writeFile(path.join(dir, 'render.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    bounded.throwIfAborted();
    return result;
  } catch (error) {
    await browser?.close().catch(() => {}); browser = undefined;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    if (bounded.aborted) throw Error('Scene render cancelled or exceeded its 180-second deadline');
    throw error;
  } finally { bounded.removeEventListener('abort', closeOnAbort); await browser?.close().catch(() => {}); release(); }
}
