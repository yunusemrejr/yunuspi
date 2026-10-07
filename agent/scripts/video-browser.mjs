// Fixed browser-take worker; no project JavaScript executes in Node. All
// page actions use Playwright in a sandboxed, disposable Chromium context.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { safeBrowserUrl } from './browser-diagnostics.mjs';
const require = createRequire(new URL('../npm/package.json', import.meta.url));
const { chromium } = require('playwright');
const emit = (kind, data) => process.stdout.write(`${kind} ${JSON.stringify(data)}\n`);
const urlOf = raw => { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Unsupported browser protocol'); return u.href; };
const ease = t => t * t * t * (t * (6 * t - 15) + 10);

/** Hardlinks retain observed bytes after raw cleanup without rewriting a
 * held JPEG. Unsupported filesystems fall back to exclusive copies. */
export async function resampleBrowserFrames(raw, seconds, fps, epoch, framesDir) {
  if (!raw.length || raw.some(frame => !Number.isFinite(frame.timestamp)) || !Number.isFinite(epoch)) throw Error('Browser source frame clock is invalid');
  raw.sort((a, b) => a.timestamp - b.timestamp);
  const count = Math.round(seconds * fps), sources = [], used = new Set(), linked = new Set();
  let source = 0, repeatedFrameBytes = 0, storedFrameBytes = 0, linkedFrames = 0, copiedFrames = 0, linksSupported = true;
  for (let i = 0; i < count; i++) {
    const requested = i / fps;
    while (source + 1 < raw.length && raw[source + 1].timestamp <= epoch + requested) source++;
    const frame = raw[source];
    const output = path.join(framesDir, 'frame-' + String(i).padStart(6, '0') + '.jpg');
    const size = frame.bytes ?? (await fs.stat(frame.file)).size;
    let wasLinked = false;
    if (linksSupported) {
      try { await fs.link(frame.file, output); wasLinked = true; }
      catch (error) {
        if (!['EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EMLINK'].includes(error.code)) throw error;
        linksSupported = false;
      }
    }
    if (wasLinked) {
      linkedFrames++;
      if (!linked.has(frame.file)) { storedFrameBytes += size; linked.add(frame.file); }
    } else {
      await fs.copyFile(frame.file, output, constants.COPYFILE_EXCL);
      copiedFrames++; storedFrameBytes += size;
    }
    repeatedFrameBytes += size;
    used.add(frame.file);
    sources.push({ frame: i, t: requested, sourceT: frame.timestamp - epoch });
  }
  return { sources, frames: count, resampling: { method: copiedFrames ? linkedFrames ? 'mixed' : 'copies' : 'hardlinks', linkedFrames, copiedFrames, uniqueSourceFrames: used.size, storedFrameBytes, copyBytesAvoided: repeatedFrameBytes - storedFrameBytes } };
}
const inViewport = (box, plan) => box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= plan.width && box.y + box.height <= plan.height;

async function main() {
  const plan = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const rawDir = path.join(plan.out, 'raw'), framesDir = path.join(plan.out, 'frames');
  await fs.mkdir(rawDir); await fs.mkdir(framesDir);
  const browser = await chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? 'chrome', headless: true, chromiumSandbox: true, timeout: 15_000 });
  try {
    const context = await browser.newContext({ viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 1, isMobile: plan.mobile, hasTouch: plan.mobile || plan.steps.some(s => s.action === 'tap'), serviceWorkers: 'block', acceptDownloads: false, permissions: [], colorScheme: 'light' });
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
    const installPointer = async () => { if (plan.cursor) await page.evaluate(mobile => {
      if (document.getElementById('__yunuspi_take_cursor')) return;
      const cursor = document.createElement('div'); cursor.id = '__yunuspi_take_cursor';
      cursor.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:28px;pointer-events:none;z-index:2147483647;filter:drop-shadow(1px 2px 2px #0008)';
      cursor.innerHTML = mobile ? '<svg viewBox="0 0 22 28"><circle cx="11" cy="14" r="9" fill="#fff6" stroke="white" stroke-width="2"/></svg>' : '<svg viewBox="0 0 22 28"><path d="M2 1L2 23L8 17L13 27L17 25L12 15L21 15Z" fill="white" stroke="#17212a" stroke-width="1.3"/></svg>';
      document.documentElement.append(cursor);
    }, plan.mobile); };
    await installPointer();
    page.on('domcontentloaded', () => { void installPointer().catch(() => {}); });
    const cdp = await context.newCDPSession(page), raw = [], writes = new Set(), events = [];
    let bytes = 0, dropped = 0, captureError;
    cdp.on('Page.screencastFrame', frame => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (writes.size >= 8 || bytes > 512 * 1024 * 1024 || raw.length >= 21600) { dropped++; return; }
      const timestamp = frame.metadata.timestamp;
      if (!Number.isFinite(timestamp)) { captureError = Error('Screencast frame has no timestamp'); return; }
      const file = path.join(rawDir, `raw-${String(raw.length).padStart(6, '0')}.jpg`), data = Buffer.from(frame.data, 'base64');
      bytes += data.length; raw.push({ timestamp, file, bytes: data.length });
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
      await installPointer();
      const ox = x, oy = y, began = performance.now();
      for (;;) {
        const u = seconds ? Math.min(1, (performance.now() - began) / (seconds * 1000)) : 1, e = ease(u);
        const bend = Math.sin(Math.PI*e)*.045;
        x = ox + (nx - ox) * e - (ny-oy)*bend; y = oy + (ny - oy) * e + (nx-ox)*bend;
        await page.mouse.move(x, y);
        if (plan.cursor) await page.evaluate(([px, py, mobile]) => { const cursor = document.getElementById('__yunuspi_take_cursor'); if (cursor) cursor.style.transform = `translate(${px-(mobile?11:0)}px,${py-(mobile?14:0)}px)`; }, [x, y, plan.mobile]);
        log('pointer', { x, y }); if (u >= 1) break; await delay(16);
      }
    }
    await point(x, y, 0);
    for (const step of plan.steps) {
      const due = (step.at ?? 0) - time(); if (due > 0) await delay(due * 1000);
      if (time() >= plan.seconds) throw Error('Browser actions overran the take; lengthen seconds or move them earlier');
      let target;
      if (step.selector && step.action !== 'wait_text') {
        const locator = page.locator(step.selector);
        if (await locator.count() !== 1) throw Error('Take selector must identify exactly one observed element');
        await locator.waitFor({ state: 'visible' }); target = await locator.boundingBox();
        if (!inViewport(target, plan)) throw Error('Take target is outside the viewport; add an explicit scroll step');
        log('target', { selector: step.selector, ...target });
      }
      if (step.action === 'highlight') {
        log('highlight', { selector: step.selector, ...target });
        await page.evaluate(([box, accent, seconds]) => {
          const el = document.createElement('div');
          el.style.cssText = `position:fixed;left:${box.x-5}px;top:${box.y-5}px;width:${box.width+10}px;height:${box.height+10}px;border:3px solid ${accent};border-radius:10px;box-shadow:0 0 0 9999px #08131b66;pointer-events:none;z-index:2147483645`;
          document.documentElement.append(el);
          el.animate([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .82 }, { opacity: 0 }], { duration: seconds*1000 }).finished.then(() => el.remove());
        }, [target, plan.accent, step.duration ?? 1.2]);
      } else if (['move', 'click', 'tap'].includes(step.action)) {
        await point(target ? target.x + target.width / 2 : step.x, target ? target.y + target.height / 2 : step.y, step.duration ?? 0.5);
        if (step.action === 'click' || step.action === 'tap') {
          if (step.selector) {
            const locator = page.locator(step.selector);
            const hit = await locator.evaluate((element, point) => {
              const observed = document.elementFromPoint(point.x, point.y);
              return observed === element || element.contains(observed);
            }, { x, y });
            if (!hit || !await locator.isEnabled()) throw Error('Take target moved, is covered or disabled at the observed pointer; inspect the page and update the take steps');
          }
          log(step.action === 'tap' || plan.mobile ? 'tap' : 'click', { x, y });
          if (plan.cursor) await page.evaluate(([px, py, accent]) => {
            const ring = document.createElement('div'); ring.style.cssText = `position:fixed;left:${px - 12}px;top:${py - 12}px;width:24px;height:24px;border:2px solid ${accent};border-radius:50%;pointer-events:none;z-index:2147483646`;
            document.documentElement.append(ring); ring.animate([{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(2)', opacity: 0 }], { duration: 500, easing: 'ease-out' }).finished.then(() => ring.remove());
          }, [x, y, plan.accent]);
          if (plan.mobile || step.action === 'tap') await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
        }
      } else if (step.action === 'scroll') {
        const began = performance.now(), duration = (step.duration ?? 0.5) * 1000; let last = 0;
        for (;;) { const u = duration ? Math.min(1, (performance.now() - began) / duration) : 1, e = ease(u); await page.mouse.wheel((step.dx ?? 0) * (e - last), (step.dy ?? 0) * (e - last)); last = e; if (u >= 1) break; await delay(16); }
        log('scroll', { dx: step.dx ?? 0, dy: step.dy ?? 0 });
      } else if (step.action === 'type') {
        if (step.selector) await page.locator(step.selector).focus();
        log('type', { characters: step.text.length });
        for (const character of step.text) { log('key'); await page.keyboard.type(character); await delay(40); }
      }
      else if (step.action === 'press') { if (step.selector) await page.locator(step.selector).focus(); log('press', { key: step.text }); await page.keyboard.press(step.text); }
      else if (step.action === 'wait_text') {
        const locator = step.selector ? page.locator(step.selector).filter({ hasText: step.text }) : page.getByText(step.text, { exact: false }).first();
        await locator.waitFor({ state: 'visible', timeout: Math.max(1, Math.min(15000, (plan.seconds - time()) * 1000)) });
        if (step.selector && await page.locator(step.selector).count() !== 1) throw Error('Take selector must identify exactly one observed element');
        const box = await locator.boundingBox();
        if (!inViewport(box, plan)) throw Error('Take response is outside the viewport; add an explicit scroll step');
        log('target', { selector: step.selector, ...box }); log('text-visible', { selector: step.selector });
      }
      else if (step.action === 'mark') log('mark', { name: step.text });
      emit('BROWSER_TAKE_PROGRESS', `${step.action} at ${time().toFixed(2)}s`);
    }
    if (time() > plan.seconds) throw Error('Last action overran the take duration');
    if (time() < plan.seconds) await delay((plan.seconds - time()) * 1000);
    await cdp.send('Page.stopScreencast'); await Promise.all([...writes]);
    if (captureError) throw captureError;
    if (bytes > 512 * 1024 * 1024) throw Error('Browser take exceeds the 512 MiB raw frame budget');
    const { frames: count, sources, resampling } = await resampleBrowserFrames(raw, plan.seconds, plan.fps, epoch, framesDir);
    await fs.rm(rawDir, { recursive: true });
    const result = { frames: count, capturedFrames: raw.length, droppedFrames: dropped, resampling, sourceUrl: safeBrowserUrl(page.url()), sourceFrames: sources, eventLog: events, problems,
      maxSourceAgeSeconds: Math.max(...sources.map(s => s.t - s.sourceT)), clock: 'CDP timestamps relative to capture epoch; actions use monotonic elapsed wall time. Output selects the most recent observed frame.' };
    await fs.writeFile(path.join(plan.out, 'take-data.json'), JSON.stringify(result));
    emit('BROWSER_TAKE_RESULT', { frames: count });
  } finally { await browser.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  const message = String(error.message).split('\n').filter(line => !/<launching>|--disable-field-trial-config/.test(line)).join('\n');
  emit('BROWSER_TAKE_RESULT', { error: message.length > 1800 ? message.slice(0, 400) + '\n…\n' + message.slice(-1300) : message });
  process.exitCode = 1;
});
