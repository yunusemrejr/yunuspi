import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.join(root, '..', 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/svg-inspect.ts')));
const { measureSvg, svgMatrixRun } = await import(pathToFileURL(path.join(agent, 'extensions/lib/svg-inspect.ts')));
const measure = inner => measureSvg(`<svg viewBox="0 0 100 100">${inner}</svg>`);
const close = (actual, expected) => {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${key}: ${actual[key]} != ${expected[key]}`);
};

test('SVG applies affine transforms in document order, including centered rotation and reflection', () => {
  close(measure('<rect width="10" height="20" transform="translate(30 40) rotate(90)"/>').unionBounds, { x: 10, y: 40, width: 20, height: 10 });
  close(measure('<rect x="10" y="20" width="10" height="20" transform="rotate(90 10 20)"/>').unionBounds, { x: -10, y: 20, width: 20, height: 10 });
  close(measure('<g transform="translate(50 20)"><rect x="2" y="3" width="10" height="20" transform="matrix(-2 0 0 3 0 0)"/></g>').unionBounds, { x: 26, y: 29, width: 20, height: 60 });
  close(measure('<rect width="10" height="20" transform="skewX(45)"/>').unionBounds, { x: 0, y: 0, width: 30, height: 20 });
});

test('transformed line and path bounds use actual vertices, and ellipses use affine extrema', () => {
  const sqrt2 = Math.SQRT2;
  close(measure('<path d="M0 0 L10 10" transform="rotate(45)"/>').unionBounds, { x: 0, y: 0, width: 0, height: 10 * sqrt2 });
  close(measure('<line x1="0" y1="0" x2="10" y2="10" transform="rotate(45)"/>').unionBounds, { x: 0, y: 0, width: 0, height: 10 * sqrt2 });
  close(measure('<circle r="10" transform="rotate(45)"/>').unionBounds, { x: -10, y: -10, width: 20, height: 20 });
  const extent = Math.sqrt(250);
  close(measure('<ellipse rx="20" ry="10" transform="rotate(45)"/>').unionBounds, { x: -extent, y: -extent, width: 2 * extent, height: 2 * extent });
});

test('unused definitions and display-none subtrees do not inflate visible geometry', () => {
  const result = measure('<defs><g><rect width="1000" height="1000"/></g></defs><g display="none"><rect width="900" height="900"/></g><g style="display:none"><circle r="400"/></g><rect x="10" y="10" width="20" height="20"/>');
  close(result.unionBounds, { x: 10, y: 10, width: 20, height: 20 });
  assert.equal(result.elements.rect, 3, 'source inventory still counts definition and hidden shapes');
  const reference = measure('<defs><rect id="shape" width="1000" height="1000"/></defs><use href="#shape"/>');
  assert.equal(reference.unionBounds, null, 'unexpanded use is unknown rather than the definition at the wrong origin');
  assert.equal(reference.boundsApproximate, true);
});

test('unsupported transforms, sampled curves and nested viewports cannot claim exact geometry', () => {
  for (const transform of ['rotate(oops)', 'translate(10 bogus)', 'matrix(1 0 0 1 5)', 'rotate(45deg)', 'unknown(12)', 'translate(1) '.repeat(40)]) {
    const result = measure(`<rect width="10" height="20" transform="${transform}"/>`);
    assert.equal(result.boundsApproximate, true, transform);
    assert.ok(result.approximationCauses.some(cause => /transform/.test(cause)), transform);
  }
  assert.ok(measure('<path d="M0 0 C0 20 20 20 20 0"/>').approximationCauses.some(cause => /sampled/.test(cause)));
  assert.ok(measure('<svg x="20" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').approximationCauses.some(cause => /viewport/.test(cause)));
});

test('SVG render matrix scales intrinsic-size icons into the master and cleans up failed captures', { timeout: 45000 }, async t => {
  const { renderCapture } = await import(pathToFileURL(path.join(agent, 'scripts/render-capture.mjs')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-matrix-fit-'));
  try {
    fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#0066cc"/></svg>');
    let result;
    try { result = await svgMatrixRun({ path: 'icon.svg', sizes: [16, 24, 256] }, dir, undefined, (params, output, _cwd, signal) => renderCapture(params, output, signal)); }
    catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|distribution.*not found|not installed/i.test(error.message)) { t.skip('Browser unavailable'); return; } throw error; }
    for (const cell of result.cells) assert.ok(cell.coverage > 20 && cell.coverage < 50, `${cell.size}px coverage ${cell.coverage}% must represent the icon rather than a mostly empty viewport`);
    const outputs = fs.readdirSync(path.join(dir, '.pi/ui-review'));
    await assert.rejects(svgMatrixRun({ path: 'icon.svg' }, dir, undefined, async () => { throw Error('capture failed'); }), /capture failed/);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.pi/ui-review')), outputs, 'failed captures retain no partial matrix directory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
