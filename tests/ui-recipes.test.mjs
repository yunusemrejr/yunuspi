import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { uiRecipe } from '../agent/extensions/lib/ui-recipes.ts';
import { blenderWebAsset } from '../agent/extensions/lib/blender-studio.ts';

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'agent/npm/package.json'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'yunuspi-ui-recipes-'));
const positions = Buffer.from(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer);
const model = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [10, 0, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.1, 0.4, 0.2, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }], buffers: [{ byteLength: positions.length, uri: `data:application/octet-stream;base64,${positions.toString('base64')}` }], bufferViews: [{ buffer: 0, byteLength: positions.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }] };
await fs.writeFile(path.join(work, 'model.gltf'), JSON.stringify(model));
test.after(async () => fs.rm(work, { recursive: true, force: true }));

test('plans expose mechanisms and gaps without writing or selecting a visual skin', async () => {
  const before = await fs.readdir(work), catalog = await uiRecipe({}, work);
  assert.equal(catalog.patterns.length, 3);
  const plan = await uiRecipe({ pattern: 'three-model', assetPath: 'model.gltf' }, work);
  assert.equal(plan.asset.counts.triangles, 1);
  assert.equal(plan.verification.appearance, 'unverified');
  assert.deepEqual(await fs.readdir(work), before);
});

test('scaffolds preserve originals, are parseable, and record exact mechanics and hashes', async () => {
  const source = await fs.readFile(path.join(work, 'model.gltf'));
  for (const input of [
    { pattern: 'scroll-reveal', selector: '[data-enter]' },
    { pattern: 'scroll-story', section: '#story', stickySelector: '#panel', tracks: [{ selector: '.layer', keyframes: [{ transform: 'translateX(-50px)' }, { transform: 'translateX(50px)' }] }] },
    { pattern: 'three-model', assetPath: 'model.gltf', modelUrl: '/model.gltf' },
  ]) {
    const receipt = await uiRecipe({ action: 'scaffold', ...input }, work);
    assert.equal(receipt.verification.interaction, 'unverified');
    const module = receipt.files.find(file => file.path.endsWith('.mjs'));
    const bytes = await fs.readFile(path.join(work, module.path), 'utf8');
    require('acorn').parse(bytes, { ecmaVersion: 'latest', sourceType: 'module' });
    assert.match(module.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!/lorem|indigo|gradient|glassmorphism/i.test(bytes));
  }
  assert.deepEqual(await fs.readFile(path.join(work, 'model.gltf')), source);
});

test('invalid selectors, overlapping tracks, decoder assets and cancellation fail before output', async () => {
  const inputs = [
    { pattern: 'scroll-reveal', selector: '.x {color:red}' },
    { pattern: 'scroll-reveal', selector: '.x', keyframes: [{ width: '0px' }, { width: '10px' }] },
    { pattern: 'scroll-reveal', selector: '.x', easing: 'cubic-bezier(2, 0, 1, 1)' },
    { pattern: 'scroll-story', section: '#story', tracks: [{ selector: '.x', start: 0.7, end: 0.3, keyframes: [{ opacity: 0 }, { opacity: 1 }] }] },
    { pattern: 'scroll-story', section: '#story', tracks: [1, 2].map(() => ({ selector: '.x', keyframes: [{ opacity: 0 }, { opacity: 1 }] })) },
    { pattern: 'three-model', modelUrl: '/model.gltf' },
    { pattern: 'three-model', assetPath: 'model.gltf', modelUrl: 'javascript:alert(1)' },
  ];
  for (const input of inputs) await assert.rejects(uiRecipe({ action: 'scaffold', ...input }, work));
  const compressed = { ...model, extensionsRequired: ['KHR_draco_mesh_compression'] };
  await fs.writeFile(path.join(work, 'compressed.gltf'), JSON.stringify(compressed));
  await assert.rejects(uiRecipe({ action: 'scaffold', pattern: 'three-model', assetPath: 'compressed.gltf', modelUrl: '/compressed.gltf' }, work), /decoder loaders/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uiRecipe({ action: 'scaffold', pattern: 'scroll-reveal', selector: '.x' }, work, controller.signal));
});

test('Blender browser preflight carries current bundles and preserves a failed export', async () => {
  const good = await blenderWebAsset(path.join(work, 'model.gltf'));
  assert.equal(good.status, 'inspected'); assert.equal(good.verification.browser, 'unverified');
  assert.match(good.bundleSha256, /^[a-f0-9]{64}$/);
  const bad = path.join(work, 'broken.gltf'); await fs.writeFile(bad, '{');
  const failure = await blenderWebAsset(bad);
  assert.equal(failure.status, 'blocked'); assert.equal(failure.artifactPreserved, true);
  assert.equal(await fs.readFile(bad, 'utf8'), '{');
});

test('generated browser mechanics handle scroll, reduced motion, repeated mount and Three.js cleanup', { timeout: 60000 }, async () => {
  const recipes = [];
  recipes.push(await uiRecipe({ action: 'scaffold', pattern: 'scroll-reveal', selector: '[data-enter]', durationMs: 80 }, work));
  recipes.push(await uiRecipe({ action: 'scaffold', pattern: 'scroll-story', section: '#story', tracks: [{ selector: '.layer', keyframes: [{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }] }] }, work));
  recipes.push(await uiRecipe({ action: 'scaffold', pattern: 'three-model', assetPath: 'model.gltf', modelUrl: '/model.gltf', scrollSection: '#story' }, work));
  const modules = await Promise.all(recipes.map(receipt => fs.readFile(path.join(work, receipt.files.find(file => file.path.endsWith('.mjs')).path))));
  const html = '<!doctype html><style>body{margin:0}#story{height:2400px}.layer{position:sticky;top:0;width:120px;height:120px;background:#126d56}#model{height:320px;width:480px}[data-enter]{margin:0}</style><h1 data-enter>Explore this collection</h1><section id="story"><div class="layer"></div></section><div id="model"></div><p id="fallback">A triangle model, with an accessible static description.</p><script type="importmap">{"imports":{"three":"/three.mjs"}}</script>';
  const libraryRoot = path.resolve(path.dirname(require.resolve('three')), '..');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), recipe = /^\/recipe([0-2])\.mjs$/.exec(url.pathname);
      if (recipe) { res.setHeader('content-type', 'text/javascript'); res.end(modules[Number(recipe[1])]); }
      else if (url.pathname === '/three.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(await fs.readFile(path.join(libraryRoot, 'build/three.module.js'))); }
      else if (url.pathname === '/three.core.js') { res.setHeader('content-type', 'text/javascript'); res.end(await fs.readFile(path.join(libraryRoot, 'build/three.core.js'))); }
      else if (url.pathname.startsWith('/addons/')) { const file = path.resolve(libraryRoot, 'examples/jsm', url.pathname.slice(8)); if (!file.startsWith(path.join(libraryRoot, 'examples/jsm') + path.sep)) throw Error('escape'); res.setHeader('content-type', 'text/javascript'); res.end(await fs.readFile(file)); }
      else if (url.pathname === '/model.gltf') { res.setHeader('content-type', 'model/gltf+json'); res.end(JSON.stringify(model)); }
      else { res.setHeader('content-type', 'text/html'); res.end(html); }
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await require('playwright').chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const recipe = await import('/recipe0.mjs'); const first = recipe.mount(), second = recipe.mount();
      first.dispose(); window.revealHandle = second;
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).opacity === '1' && document.getAnimations().length === 0, null, { timeout: 5000 });
    const reveal = await page.evaluate(() => { const result = { opacity: getComputedStyle(document.querySelector('h1')).opacity, running: document.getAnimations().length }; window.revealHandle.dispose(); return result; });
    assert.equal(reveal.opacity, '1'); assert.equal(reveal.running, 0);
    const normal = await page.evaluate(async () => {
      const recipe = await import('/recipe1.mjs'); window.motionHandle = recipe.mount(); scrollTo(0, 800);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return getComputedStyle(document.querySelector('.layer')).transform;
    });
    assert.match(normal, /matrix/); assert.notEqual(normal, 'matrix(1, 0, 0, 1, 0, 0)');
    const sought = await page.evaluate(async () => {
      const node = document.querySelector('.layer'), style = () => getComputedStyle(node).transform;
      window.motionHandle.seek(0); const start = style();
      window.motionHandle.seek(.5); const middle = style();
      scrollTo(0,1200); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const afterScroll = style(); window.motionHandle.refresh(); const afterRefresh = style();
      window.motionHandle.seek(1); const end = style();
      window.motionHandle.seek(.5); window.motionHandle.resume();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let invalid; try { window.motionHandle.seek(NaN); } catch { invalid = true; }
      return { start,middle,end,afterScroll,afterRefresh,resumed:style(),invalid };
    });
    assert.equal(sought.start,'matrix(1, 0, 0, 1, 0, 0)');
    assert.equal(sought.middle,'matrix(1, 0, 0, 1, 50, 0)');
    assert.equal(sought.end,'matrix(1, 0, 0, 1, 100, 0)');
    assert.equal(sought.afterScroll,sought.middle); assert.equal(sought.afterRefresh,sought.middle);
    assert.notEqual(sought.resumed,sought.middle); assert.equal(sought.invalid,true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.layer')).transform === 'none', null, { timeout: 5000 });
    assert.equal(await page.locator('.layer').evaluate(node => getComputedStyle(node).transform), 'none');
    assert.equal(await page.evaluate(() => window.motionHandle.seek(.7)),false,'video clock cannot bypass the static reduced-motion state');
    await page.evaluate(() => window.motionHandle.dispose());
    assert.equal(await page.evaluate(() => { try { window.motionHandle.seek(.5); } catch { return true; } }),true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(async () => { const recipe = await import('/recipe1.mjs'); const handle = recipe.mount(); const count = document.getAnimations().length; handle.dispose(); return count; }), 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    const loaded = await page.evaluate(async () => {
      const recipe = await import('/recipe2.mjs'), THREE = await import('three'), { GLTFLoader } = await import('/addons/loaders/GLTFLoader.js');
      const handle = recipe.mount(document.querySelector('#model'), { THREE, GLTFLoader }); await handle.ready;
      window.modelHandle = handle;
      const ready = { status: handle.status, canvases: document.querySelectorAll('canvas').length };
      return { ...ready, fallback: document.querySelector('#fallback').textContent };
    });
    assert.equal(loaded.status, 'ready'); assert.equal(loaded.canvases, 1); assert.match(loaded.fallback, /static description/);
    await page.locator('#model').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const { decodeImage } = await import('../agent/extensions/lib/design-studio.ts');
    const rendered = await decodeImage(await page.locator('canvas').screenshot(), { maxWidth: 480, maxPixels: 480 * 480 });
    let green = 0;
    for (let i = 0; i < rendered.data.length; i += 4) if (rendered.data[i + 1] > rendered.data[i] * 1.3 && rendered.data[i + 1] > rendered.data[i + 2] * 1.1) green++;
    assert.ok(green > 100, 'the off-center imported mesh stays in frame after scroll rotation');
    await page.evaluate(() => window.modelHandle.dispose());
    assert.equal(await page.locator('canvas').count(), 0);
    const overlap = await page.evaluate(async () => {
      const recipe = await import('/recipe1.mjs'), original = recipe.config.tracks;
      const keyframes = [{ transform: 'none' }, { transform: 'translateX(10px)' }];
      recipe.config.tracks = [
        { selector: '.layer', start: 0, end: 1, keyframes },
        { selector: 'div.layer', start: 0, end: 1, keyframes },
      ];
      try { recipe.mount(document); return {}; } catch (error) { return { message: error.message, animations: document.getAnimations().length }; }
      finally { recipe.config.tracks = original; }
    });
    assert.match(overlap.message, /same element/); assert.equal(overlap.animations, 0);
    const loadingCleanup = await page.evaluate(async () => {
      const recipe = await import('/recipe2.mjs'), THREE = await import('three');
      let finish, disposedGeometry = 0;
      const geometry = new THREE.BoxGeometry(); geometry.addEventListener('dispose', () => disposedGeometry++);
      const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      class SlowLoader { loadAsync() { return new Promise(resolve => { finish = resolve; }); } }
      const handle = recipe.mount(document.querySelector('#model'), { THREE, GLTFLoader: SlowLoader });
      handle.dispose(); finish({ scene }); await handle.ready;
      return { canvases: document.querySelectorAll('canvas').length, disposedGeometry };
    });
    assert.equal(loadingCleanup.canvases, 0); assert.equal(loadingCleanup.disposedGeometry, 1);
    await page.evaluate(async () => {
      const recipe = await import('/recipe2.mjs'), THREE = await import('three'), { GLTFLoader } = await import('/addons/loaders/GLTFLoader.js');
      window.lostHandle = recipe.mount(document.querySelector('#model'), { THREE, GLTFLoader }); await window.lostHandle.ready;
      document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    });
    await page.waitForFunction(() => window.lostHandle.status === 'context-lost', null, { timeout: 5000 });
    assert.equal(await page.locator('canvas').count(), 0);
    const failure = await page.evaluate(async () => {
      const recipe = await import('/recipe2.mjs'), THREE = await import('three');
      class FailingLoader { loadAsync() { return Promise.reject(Error('unavailable model')); } }
      const handle = recipe.mount(document.querySelector('#model'), { THREE, GLTFLoader: FailingLoader });
      try { await handle.ready; } catch {} return { state: handle.status, canvases: document.querySelectorAll('canvas').length };
    });
    assert.equal(failure.state, 'unavailable'); assert.equal(failure.canvases, 0);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
