#!/usr/bin/env node
import {resolveOwnedCore} from '../agent/scripts/lib/owned-core.mjs';
// Public screenshots use only these synthetic fixtures, never live session data.
// Run with Node >=22.19 and an installed harness that provides Playwright/Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
const agent = path.resolve(process.env.PI_DEMO_AGENT_DIR || path.join(os.homedir(), '.pi/agent'));
const output = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/assets'));
const core = resolveOwnedCore();
const { chromium } = await import(pathToFileURL(path.join(agent, 'extensions/node_modules/playwright/index.mjs')));
const { buildSessionReport } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-report.ts')));
const panelSource = stripTypeScriptTypes(fs.readFileSync(path.join(agent, 'extensions/lib/metrics-panel.ts'), 'utf8'))
  .replace("'@yunuspi/tui'", JSON.stringify(pathToFileURL(path.join(core, '../tui/dist/index.js')).href));
const { createMetricsPanel } = await import('data:text/javascript;base64,' + Buffer.from(panelSource).toString('base64'));
const message = (role, fields) => ({ type: 'message', message: { role, ...fields } });
const entries = [];
for (let index = 0; index < 3; index++) {
  entries.push(message('assistant', { content: [{ type: 'toolCall', id: `search-${index}`, name: 'web_search', arguments: { query: 'fixture documentation' } }] }));
  entries.push(message('toolResult', { toolCallId: `search-${index}`, toolName: 'web_search', isError: true, content: [{ type: 'text', text: '429 capacity limit; retry after the recorded cooldown.' }] }));
}
entries.push({ type: 'custom', customType: 'subagent-lifecycle-v1', data: { runId: 'demo-review', mode: 'single', results: [{ index: 0, status: 'failed', timedOut: true }] } });
for (let index = 0; index < 3; index++) {
  entries.push(message('assistant', { content: [{ type: 'toolCall', id: `source-${index}`, name: 'module_report', arguments: { path: 'src/cart.ts' } }] }));
  entries.push(message('toolResult', { toolCallId: `source-${index}`, toolName: 'module_report', content: [{ type: 'text', text: 'Synthetic source inspection result. '.repeat(40) }] }));
}
const report = buildSessionReport(entries, entries, undefined, ['project_report', 'module_report', 'context_slice', 'context_score', 'quality_review', 'render_see']);
const panel = createMetricsPanel(report.lines, { terminal: { rows: 32 }, requestRender() {} }, { fg: (_color, text) => text }, () => {});
const text = panel.render(112).map(stripVTControlCharacters).join('\n');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-demo-'));
let viewer;
const browser = await chromium.launch({ headless: true });
try {
  fs.mkdirSync(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>YunusPi metrics demo</title><style>body{margin:0;background:#151719;color:#e7e9ec;font-family:monospace;padding:36px}header{font:16px system-ui;color:#a8b4bf;margin-bottom:24px}pre{font:17px/1.45 "DejaVu Sans Mono",monospace;white-space:pre;margin:0}</style><header>YunusPi /metrics · synthetic demonstration · native panel text</header><pre>${escape(text)}</pre></html>`);
  await page.screenshot({ path: path.join(output, 'metrics-demo.png') });

  const { openStore } = await import(pathToFileURL(path.join(agent, 'extensions/lib/project-intelligence/store.mjs')));
  const { openProjectViewer } = await import(pathToFileURL(path.join(agent, 'extensions/lib/project-intelligence/viewer.mjs')));
  const identity = { id: 'public-demo', checkoutId: 'demo-main', root: temp, name: 'Storefront · synthetic demo', branch: 'main', git: true, stateDir: temp };
  const dbPath = path.join(temp, 'demo.sqlite'), store = openStore(dbPath);
  const specs = [['storefront', 'project', 'Storefront'], ['catalog', 'component', 'Product catalog'], ['cart', 'component', 'Shopping cart'], ['checkout', 'component', 'Checkout'], ['orders', 'api', 'Orders API'], ['inventory', 'api', 'Inventory API'], ['pricing', 'file', 'pricing.ts'], ['payments', 'dependency', 'Payment adapter'], ['database', 'dependency', 'Order store'], ['cart-tests', 'file', 'cart.test.ts'], ['order-tests', 'file', 'orders.test.ts'], ['review', 'decision', 'Review checkout failures']];
  const nodes = specs.map(([id, type, label]) => ({ id, key: id, type, label }));
  const relations = [['catalog', 'inventory'], ['cart', 'catalog'], ['cart', 'pricing'], ['checkout', 'cart'], ['checkout', 'orders'], ['orders', 'payments'], ['orders', 'database'], ['cart-tests', 'cart'], ['order-tests', 'orders'], ['review', 'checkout'], ['storefront', 'catalog'], ['storefront', 'checkout']];
  store.ensureProject(identity);
  store.replaceSource({ id: 'demo-source', scope: identity.checkoutId, kind: 'file', locator: 'demo/architecture.json', fingerprint: 'synthetic-demo-v1', observedAt: '2026-09-13T12:00:00.000Z', nodes,
    claims: relations.map(([subject, object]) => ({ subject, predicate: 'depends_on', object, relation: true, status: 'verified', confidence: 1 })) }, { expectedVersion: 0 });
  store.close();
  viewer = await openProjectViewer({ dbPath, identity, launch: false });
  await page.goto(viewer.url, { waitUntil: 'networkidle' });
  await page.locator('#projectTitle').filter({ hasText: 'Storefront' }).waitFor();
  await page.locator('#focusSelect').selectOption('checkout');
  await page.locator('#inspectorTitle').filter({ hasText: 'Checkout' }).waitFor();
  await page.locator('#fitButton').click();
  await page.screenshot({ path: path.join(output, 'graph-demo.png') });
  console.log('Captured metrics-demo.png and graph-demo.png from synthetic fixtures. Review pixels before updating their public fingerprints.');
} finally {
  await browser.close();
  if (viewer?.pid) { try { process.kill(viewer.pid, 'SIGTERM'); } catch {} }
  fs.rmSync(temp, { recursive: true, force: true });
}
