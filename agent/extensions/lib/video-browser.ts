/** Reusable website takes: bounded real-time capture and the same event
 * clock for pointers, clicks, callouts and sound. Uses the existing guarded
 * process owner and browser isolation rather than a logged-in profile. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, outputFolder, probe, produced, run } from './media-process.ts';
import { runGuarded, type Progress } from './guarded-process.ts';
import { isolatedBrowserEnvironment } from './browser-session.ts';
import { createRenderQueue } from './render-queue.ts';
const acquire = createRenderQueue(2);
const WORKER = new URL('../../scripts/video-browser.mjs', import.meta.url).pathname;
const ACTIONS = ['move', 'click', 'scroll', 'type', 'press', 'mark', 'wait_text'];

export function planBrowserTake(params: any) {
  if (Boolean(params.url) === Boolean(params.path)) throw Error('Give exactly one url or local HTML path');
  if (params.url) {
    const url = new URL(params.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Browser take URL must use HTTP(S) without credentials');
  }
  const seconds = number(params.seconds, 10, 1, 120, 'seconds'), fps = integer(params.fps, 30, 1, 60, 'fps');
  const width = integer(params.width, 1280, 64, 1920, 'width'), height = integer(params.height, 720, 64, 1080, 'height');
  if (width % 2 || height % 2) throw Error('Browser take dimensions must be even');
  const steps = params.steps ?? [];
  if (!Array.isArray(steps) || steps.length > 100) throw Error('steps accepts at most 100 entries');
  let at = -1;
  for (const step of steps) {
    if (!step || !ACTIONS.includes(step.action)) throw Error('Unsupported browser take action');
    number(step.at, 0, 0, seconds, 'step.at');
    if ((step.at ?? 0) < at || (step.at ?? 0) >= seconds) throw Error('steps must be ordered and start before the take ends');
    at = step.at ?? 0;
    number(step.duration, 0.5, 0, 5, 'step.duration');
    if (step.selector !== undefined && (typeof step.selector !== 'string' || !step.selector || step.selector.length > 500)) throw Error('Invalid observed selector');
    if (['move', 'click'].includes(step.action) && !step.selector && (typeof step.x !== 'number' || typeof step.y !== 'number')) throw Error('move/click needs an observed selector or x/y');
    if (step.x !== undefined) number(step.x, 0, 0, width, 'step.x');
    if (step.y !== undefined) number(step.y, 0, 0, height, 'step.y');
    if (step.action === 'scroll') { number(step.dx, 0, -10000, 10000, 'step.dx'); number(step.dy, 0, -10000, 10000, 'step.dy'); }
    if (['type', 'press', 'wait_text', 'mark'].includes(step.action) && (typeof step.text !== 'string' || !step.text || step.text.length > 2000)) throw Error('Action needs text of 1..2000 characters');
  }
  return { seconds, fps, width, height, steps, cursor: params.cursor !== false };
}

export async function videoBrowser(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const plan = planBrowserTake(params);
  const local = params.path ? await inputFile(params.path, cwd) : undefined;
  if (local && !/\.html?$/i.test(local)) throw Error('Local browser takes require an HTML file');
  const release = await acquire(signal);
  let dir: string | undefined, profile: string | undefined, request: string | undefined;
  try {
    dir = await outputFolder(params.outputDir, cwd);
    // Chromium creates a Unix-domain socket under TMPDIR. Keep this private
    // path short even when the video/output project is deeply nested.
    profile = await fs.mkdtemp('/tmp/pi-take-');
    request = path.join(dir, 'take-request.json');
    await fs.writeFile(request, JSON.stringify({ ...plan, url: params.url, local, out: dir }));
    let result: any;
    // The fixed Node worker does not execute project code. Like browser_session,
    // launch Chromium directly with its own sandbox and disposable environment:
    // nesting its sandbox in the harness filesystem namespace prevents startup.
    // The shared process owner still enforces memory, deadlines and cancellation.
    await runGuarded(process.execPath, [WORKER, request], { cwd, signal, timeoutMs: Math.round((plan.seconds + 90) * 1000), nice: 5, guard: false, replaceEnv: true,
      env: isolatedBrowserEnvironment(profile), onLine: line => {
        if (line.startsWith('BROWSER_TAKE_RESULT ')) result = JSON.parse(line.slice(20));
        else if (line.startsWith('BROWSER_TAKE_PROGRESS ')) progress?.(line.slice(22));
      } });
    if (!result || result.error) throw Error(`Browser take failed: ${result?.error ?? 'no result'}`);
    const dataPath = path.join(dir, 'take-data.json');
    if ((await fs.stat(dataPath)).size > 8 * 1024 * 1024) throw Error('Browser take metadata exceeds 8 MiB');
    result = JSON.parse(await fs.readFile(dataPath, 'utf8')); await fs.rm(dataPath);
    const video = path.join(dir, 'take.mp4');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-framerate', String(plan.fps), '-i', path.join(dir, 'frames', 'frame-%06d.jpg'), '-frames:v', String(result.frames), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], signal, 180_000);
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(video, 0), '-f', 'null', '-'], signal);
    const info = await probe(video, signal);
    const delivery = { ...result, artifact: await produced(video), seconds: Number(info.format?.duration), fps: plan.fps, decodeVerified: true, events: path.join(dir, 'take.json'),
      note: 'Real-time site capture resampled to a constant frame clock. Events record observed times, not planned times. Inspect missing/dropped-source frames and replay the take; capture does not prove the website response was correct.' };
    await fs.writeFile(path.join(dir, 'take.json'), JSON.stringify({ ...delivery, sourceFrames: result.sourceFrames, eventLog: result.eventLog }, null, 2) + '\n');
    await fs.rm(path.join(dir, 'frames'), { recursive: true, force: true });
    return { ...delivery, sourceFrames: undefined, eventLog: result.eventLog.slice(0, 30), eventLogTruncated: result.eventLog.length > 30 };
  } catch (error) { if (dir) await fs.rm(dir, { recursive: true, force: true }); throw error; }
  finally {
    try { if (profile) await fs.rm(profile, { recursive: true, force: true }); if (request) await fs.rm(request, { force: true }); }
    finally { release(); }
  }
}
