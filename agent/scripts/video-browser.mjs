// Fixed browser-take worker; no project JavaScript executes in Node. All
// page actions use Playwright in a sandboxed, disposable Chromium context.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { safeBrowserUrl } from './browser-diagnostics.mjs';
const require = createRequire(new URL('../npm/package.json', import.meta.url));
const { chromium } = require('playwright');
const plan = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const emit = (kind, data) => process.stdout.write(`${kind} ${JSON.stringify(data)}\n`);
const urlOf = raw => { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Unsupported browser protocol'); return u.href; };
const ease = t => t * t * t * (t * (6 * t - 15) + 10);

async function main() {
  const rawDir = path.join(plan.out, 'raw'), framesDir = path.join(plan.out, 'frames');
  await fs.mkdir(rawDir); await fs.mkdir(framesDir);
  const browser = await chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? 'chrome', headless: true, chromiumSandbox: true, timeout: 15_000 });
  try {
    const context = await browser.newContext({ viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, permissions: [], colorScheme: 'light' });
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (plan.local) {
        if (url === 'http://yunuspi-take.invalid/') return route.fulfill({ contentType: 'text/html', body: await fs.readFile(plan.local, 'utf8') });
        // Local fixture/preview is self-contained. No home-file server or
        // third-party fetches are opened just to record an HTML artifact.
        return route.abort();
      }
      try { urlOf(url); return route.continue(); } catch { return route.abort(); }
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    context.on('page', other => { if (other !== page) void other.close(); });
    page.on('dialog', dialog => void dialog.dismiss());
    const problems = []; page.on('pageerror', error => { if (problems.length < 10) problems.push(String(error).slice(0, 200)); });
    await page.goto(plan.local ? 'http://yunuspi-take.invalid/' : urlOf(plan.url), { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    if (plan.cursor) await page.evaluate(() => {
      const cursor = document.createElement('div'); cursor.id = '__yunuspi_take_cursor';
      cursor.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:28px;pointer-events:none;z-index:2147483647;filter:drop-shadow(1px 2px 2px #0008)';
      cursor.innerHTML = '<svg viewBox="0 0 22 28"><path d="M2 1L2 23L8 17L13 27L17 25L12 15L21 15Z" fill="white" stroke="#17212a" stroke-width="1.3"/></svg>';
      document.documentElement.append(cursor);
    });
    const cdp = await context.newCDPSession(page), raw = [], writes = new Set(), events = [];
    let bytes = 0, dropped = 0, captureError;
    cdp.on('Page.screencastFrame', frame => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (writes.size >= 8 || bytes > 512 * 1024 * 1024 || raw.length >= 21600) { dropped++; return; }
      const timestamp = frame.metadata.timestamp;
      if (!Number.isFinite(timestamp)) { captureError = Error('Screencast frame has no timestamp'); return; }
      const file = path.join(rawDir, `raw-${String(raw.length).padStart(6, '0')}.jpg`), data = Buffer.from(frame.data, 'base64');
      bytes += data.length; raw.push({ timestamp, file });
      const write = fs.writeFile(file, data, { flag: 'wx' }).catch(error => { captureError = error; }).finally(() => writes.delete(write)); writes.add(write);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: plan.width, maxHeight: plan.height, everyNthFrame: 1 });
    const waitStart = performance.now();
    while (!raw.length && performance.now() - waitStart < 5000) await delay(20);
    if (!raw.length) throw Error('Browser produced no screencast frames');
    const epoch = Date.now() / 1000, start = performance.now();
    const time = () => (performance.now() - start) / 1000;
    const log = (kind, extra = {}) => events.push({ t: time(), kind, ...extra });
    let x = plan.width * 0.75, y = plan.height * 0.75;
    async function point(nx, ny, seconds) {
      const ox = x, oy = y, began = performance.now();
      for (;;) {
        const u = seconds ? Math.min(1, (performance.now() - began) / (seconds * 1000)) : 1, e = ease(u);
        x = ox + (nx - ox) * e; y = oy + (ny - oy) * e;
        await page.mouse.move(x, y);
        if (plan.cursor) await page.evaluate(([px, py]) => { const cursor = document.getElementById('__yunuspi_take_cursor'); if (cursor) cursor.style.transform = `translate(${px}px,${py}px)`; }, [x, y]);
        log('pointer', { x, y }); if (u >= 1) break; await delay(16);
      }
    }
    await point(x, y, 0);
    for (const step of plan.steps) {
      const due = (step.at ?? 0) - time(); if (due > 0) await delay(due * 1000);
      if (time() >= plan.seconds) throw Error('Browser actions overran the take; lengthen seconds or move them earlier');
      let target;
      if (step.selector) {
        const locator = page.locator(step.selector);
        if (await locator.count() !== 1) throw Error('Take selector must identify exactly one observed element');
        await locator.waitFor({ state: 'visible' }); target = await locator.boundingBox();
        if (!target || target.x < 0 || target.y < 0 || target.x + target.width > plan.width || target.y + target.height > plan.height) throw Error('Take target is outside the viewport; add an explicit scroll step');
        log('target', { selector: step.selector, ...target });
      }
      if (['move', 'click'].includes(step.action)) {
        await point(target ? target.x + target.width / 2 : step.x, target ? target.y + target.height / 2 : step.y, step.duration ?? 0.5);
        if (step.action === 'click') {
          log('click', { x, y });
          if (plan.cursor) await page.evaluate(([px, py]) => {
            const ring = document.createElement('div'); ring.style.cssText = `position:fixed;left:${px - 12}px;top:${py - 12}px;width:24px;height:24px;border:2px solid #e76339;border-radius:50%;pointer-events:none;z-index:2147483646`;
            document.documentElement.append(ring); ring.animate([{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(2)', opacity: 0 }], { duration: 500, easing: 'ease-out' }).finished.then(() => ring.remove());
          }, [x, y]);
          await page.mouse.click(x, y);
        }
      } else if (step.action === 'scroll') {
        const began = performance.now(), duration = (step.duration ?? 0.5) * 1000; let last = 0;
        for (;;) { const u = duration ? Math.min(1, (performance.now() - began) / duration) : 1, e = ease(u); await page.mouse.wheel((step.dx ?? 0) * (e - last), (step.dy ?? 0) * (e - last)); last = e; if (u >= 1) break; await delay(16); }
        log('scroll', { dx: step.dx ?? 0, dy: step.dy ?? 0 });
      } else if (step.action === 'type') { await page.keyboard.type(step.text, { delay: 40 }); log('type', { characters: step.text.length }); }
      else if (step.action === 'press') { await page.keyboard.press(step.text); log('press', { key: step.text }); }
      else if (step.action === 'wait_text') { await page.getByText(step.text, { exact: false }).first().waitFor({ state: 'visible', timeout: Math.max(1, Math.min(15000, (plan.seconds - time()) * 1000)) }); log('text-visible'); }
      else if (step.action === 'mark') log('mark', { name: step.text });
      emit('BROWSER_TAKE_PROGRESS', `${step.action} at ${time().toFixed(2)}s`);
    }
    if (time() > plan.seconds) throw Error('Last action overran the take duration');
    if (time() < plan.seconds) await delay((plan.seconds - time()) * 1000);
    await cdp.send('Page.stopScreencast'); await Promise.all([...writes]);
    if (captureError) throw captureError;
    if (bytes > 512 * 1024 * 1024) throw Error('Browser take exceeds the 512 MiB raw frame budget');
    raw.sort((a, b) => a.timestamp - b.timestamp);
    const count = Math.round(plan.seconds * plan.fps), sources = []; let source = 0;
    for (let i = 0; i < count; i++) {
      const requested = i / plan.fps;
      while (source + 1 < raw.length && raw[source + 1].timestamp <= epoch + requested) source++;
      await fs.copyFile(raw[source].file, path.join(framesDir, `frame-${String(i).padStart(6, '0')}.jpg`));
      sources.push({ frame: i, t: requested, sourceT: raw[source].timestamp - epoch });
    }
    await fs.rm(rawDir, { recursive: true });
    const result = { frames: count, capturedFrames: raw.length, droppedFrames: dropped, sourceUrl: safeBrowserUrl(page.url()), sourceFrames: sources, eventLog: events, problems,
      maxSourceAgeSeconds: Math.max(...sources.map(s => s.t - s.sourceT)), clock: 'CDP timestamps relative to capture epoch; actions use monotonic elapsed wall time. Output selects the most recent observed frame.' };
    await fs.writeFile(path.join(plan.out, 'take-data.json'), JSON.stringify(result));
    emit('BROWSER_TAKE_RESULT', { frames: count });
  } finally { await browser.close(); }
}
main().catch(error => { emit('BROWSER_TAKE_RESULT', { error: String(error.message).slice(0, 500) }); process.exitCode = 1; });
