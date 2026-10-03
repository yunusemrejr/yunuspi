import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const template = path.resolve(import.meta.dirname, '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')]
  .find((p) => fs.existsSync(path.join(p, 'extensions/session-signals.ts')));
assert.ok(agent, 'agent tree with session-signals.ts is present');
register('data:text/javascript,' + encodeURIComponent(`export function resolve(name,ctx,next){
 const sources={
 '@yunuspi/coding-agent':'export function getAgentDir(){return ${JSON.stringify(path.join(template, 'agentFixture'))}};export class SettingsManager{static create(){return {getCompactionSettings(){return{};}};}}',
 '@yunuspi/ai':'export function StringEnum(v){return v}'};
 return name in sources?{url:'data:text/javascript,'+encodeURIComponent(sources[name]),shortCircuit:true}:next(name,ctx);
}`), import.meta.url);

const theme = await import(pathToFileURL(path.join(agent, 'extensions/lib/popup-theme.ts')));
const signals = await import(pathToFileURL(path.join(agent, 'extensions/session-signals.ts')));
const errorsLib = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-errors.ts')));

const PICTOGRAPH = /\p{Extended_Pictographic}/u;

const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):(#[0-9a-f]{6})/gi)].map(([, k, v]) => [k, v]));

test('text font stacks carry no emoji family and report text uses no pictographs', () => {
  assert.doesNotMatch(theme.POPUP_FONT_SANS, /emoji/i);
  assert.doesNotMatch(theme.POPUP_FONT_MONO, /emoji/i);
  assert.doesNotMatch(theme.POPUP_CSS, /emoji/i, 'an emoji family before the generic fallback renders digits and spaces from its wide glyphs');
  const summary = signals.buildUsedSummary([{ type: 'message', message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } } }], { provider: 'p', id: 'm' });
  const pages = [
    signals.usedSummaryHtml(summary),
    signals.errorsHtml(errorsLib.collectSessionErrors([])),
    signals.commandsHtml([{ name: 'used', description: 'Usage', source: 'extension' }]),
    signals.sysPromptHtml({ at: 'now', system: '# A\ntext\n# B', truncated: false, tools: ['read'], toolCount: 1 }),
  ];
  for (const html of pages) assert.doesNotMatch(html, PICTOGRAPH);
});

test('every text and state color keeps WCAG AA contrast on its surfaces in both themes', () => {
  const css = theme.POPUP_CSS;
  const light = tokens(css.match(/:root\{[^}]*\}/)[0]);
  const dark = tokens(css.match(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)[1]);
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const surface of ['bg', 'panel', 'sunk']) {
      for (const ink of ['ink', 'ink2', 'ink3', 'accent', 'ok', 'warn', 'bad']) {
        assert.ok(contrast(set[ink], set[surface]) >= 4.5, `${name}: --${ink} on --${surface} is ${contrast(set[ink], set[surface]).toFixed(2)}:1`);
      }
    }
    assert.ok(contrast(set.ink, set.bg) >= 12, `${name}: primary text should be comfortably above AA`);
  }
});

test('cache reuse tone follows the 90% / 70% bands and ignores unmeasured values', () => {
  assert.equal(theme.cacheTone(95), 'ok');
  assert.equal(theme.cacheTone(90), 'ok');
  assert.equal(theme.cacheTone(89.9), 'warn');
  assert.equal(theme.cacheTone(70), 'warn');
  assert.equal(theme.cacheTone(69.9), 'bad');
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(theme.cacheTone(value), '');
});

test('token mix bar encodes real shares and prints them, and is absent without traffic', () => {
  assert.equal(theme.tokenMixHtml({ fresh: 0, read: 0, write: 0 }), '');
  const html = theme.tokenMixHtml({ fresh: 100, read: 850, write: 50 });
  assert.match(html, /width:85\.000%/);
  assert.match(html, /width:10\.000%/);
  assert.match(html, /width:5\.000%/);
  assert.match(html, /cache read 850 · 85\.0%/);
  assert.match(html, /uncached input 100 · 10\.0%/);
  const only = theme.tokenMixHtml({ fresh: 0, read: 10, write: 0 });
  assert.equal([...only.matchAll(/<i /g)].length, 1, 'zero-width segments are not drawn');
});

test('used popup surfaces per-route and session cache reuse with their tone', () => {
  const entry = (provider, model, usage) => ({ type: 'message', message: { role: 'assistant', provider, model, content: [{ type: 'text', text: 'ok' }], usage } });
  const summary = signals.buildUsedSummary([
    entry('a', 'strong', { input: 50, cacheRead: 950, cacheWrite: 0, output: 5 }),
    entry('b', 'weak', { input: 800, cacheRead: 200, cacheWrite: 0, output: 5 }),
  ]);
  const html = signals.usedSummaryHtml(summary);
  assert.match(html, /badge complete">cache 95\.0%/);
  assert.match(html, /badge failed">cache 20\.0%/);
  assert.match(html, /class="stat (ok|warn|bad)"><strong>57\.5%<\/strong><span>prompt cache reuse/);
  assert.match(html, /class="tokenbar"/);
  const idle = signals.usedSummaryHtml(signals.buildUsedSummary([]));
  assert.doesNotMatch(idle, /class="tokenbar"/);
  assert.match(idle, /<strong>—<\/strong><span>prompt cache reuse/);
});

test('commands page groups by source in a stable order and escapes the filter index', () => {
  const html = signals.commandsHtml([
    { name: 'zeta', description: 'Skill <b>', source: 'skill' },
    { name: 'alpha', description: 'First', source: 'extension' },
    { name: 'tpl', description: 'Template', source: 'prompt' },
    { name: 'odd', description: '"quoted"', source: 'custom-source' },
  ]);
  const order = ['Extension commands', 'Prompt templates', 'Skill commands', 'custom-source'].map((label) => html.indexOf(label));
  assert.ok(order.every((index) => index >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'known sources first, then others');
  assert.ok(!html.includes('Skill <b>'));
  assert.doesNotMatch(html, /data-cmd="[^"]*"[^>]*"[^"]*">/, 'attribute values cannot be broken out of');
  assert.match(signals.commandsHtml([]), /No slash commands are registered/);
});

test('system prompt page outlines headings but not comment lines inside code fences', () => {
  const html = signals.sysPromptHtml({
    at: 'now', model: 'x/y', truncated: false, tools: ['read'], toolCount: 1,
    system: '# Role\nbe exact\n```sh\n# not a heading\n```\n## Tools\n- read\n',
  });
  assert.match(html, /<nav class="outline">/);
  assert.match(html, /<a href="#h0">Role<\/a>/);
  assert.match(html, /<a href="#h5">Tools<\/a>/);
  assert.doesNotMatch(html, /<a [^>]*>not a heading<\/a>/);
  assert.match(html, /id="copy-prompt"/);
  assert.match(html, /about \d+ tokens \(estimate\)/);
  const flat = signals.sysPromptHtml({ at: 'now', truncated: false, tools: [], toolCount: 0, system: 'plain text only' });
  assert.doesNotMatch(flat, /<nav class="outline">/, 'a prompt without sections gets no outline');
});

test('in a browser the text face is not an emoji font, the filter narrows commands, and nothing overflows', async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(signals.renderPopupHtml('Slash commands', signals.commandsHtml([
    { name: 'used', description: 'Session usage', source: 'extension' },
    { name: 'errors', description: 'Failures list', source: 'extension' },
    { name: 'review', description: 'Run a review', source: 'prompt' },
  ])));
  assert.doesNotMatch(await page.locator('body').evaluate((node) => getComputedStyle(node).fontFamily), /emoji/i);
  assert.equal(await page.locator('[data-cmd]:not([hidden])').count(), 3);
  await page.locator('#cmd-filter').fill('fail');
  assert.equal(await page.locator('[data-cmd]:not([hidden])').count(), 1);
  assert.equal(await page.locator('[data-group]:not([hidden])').count(), 1, 'a group with no match disappears');
  assert.equal(await page.locator('#cmd-count').innerText(), '1 of 3 shown');
  await page.locator('#cmd-filter').fill('zzz');
  assert.equal(await page.locator('#cmd-none').isVisible(), true);
  await page.locator('#cmd-filter').fill('');
  assert.equal(await page.locator('#cmd-count').innerText(), '3 registered');
  for (const width of [360, 720, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal scroll at ${width}px`);
  }
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const background = await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.notEqual(background, 'rgba(0, 0, 0, 0)', `${scheme} theme paints its own background`);
  }
  assert.deepEqual(errors, []);
});

test('system prompt copy button writes the prompt text', async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  // Popups open from file://, which is a secure context; about:blank is not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-theme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sys.html');
  fs.writeFileSync(file, signals.renderPopupHtml('Session system prompt', signals.sysPromptHtml({ at: 'now', truncated: false, tools: [], toolCount: 0, system: '# Role\nYou are exact & careful <b>.' })));
  await page.goto(pathToFileURL(file).href);
  await page.locator('#copy-prompt').click();
  await page.waitForFunction(() => document.getElementById('copy-prompt-status').textContent.length > 0);
  assert.equal(await page.locator('#copy-prompt-status').innerText(), 'Copied.');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '# Role\nYou are exact & careful <b>.');
});
