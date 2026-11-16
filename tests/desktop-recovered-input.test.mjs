import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRecoveredInput, listRecoveredInput } from '../desktop/recovered-input.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'c3ludGhldGlj' };
const write = (filename, value) => writeFile(filename, JSON.stringify(value), { mode: 0o600 });
async function fixture(t) {
  const sessionId = randomUUID(), dir = await mkdtemp(path.join(tmpdir(), 'desktop-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, '.queue-recovery');
  await mkdir(root, { mode: 0o700 });
  const batch = async (items, owner = sessionId) => {
    const id = randomUUID(), folder = path.join(root, id);
    await mkdir(folder, { mode: 0o700 });
    for (const item of items) await write(path.join(folder, `${item.id}.json`), item);
    const entries = items.map(item => ({ id: item.id, kind: item.kind, preview: item.text.slice(0, 160), imageCount: item.images.length }));
    await write(path.join(folder, 'manifest.json'), { version: 1, sessionId: owner, id, entries });
    return { id, folder };
  };
  return { sessionId, dir, root, batch };
}

test('one saved image-only message has a bounded preview and immutable review, across duplicate saved copies', async t => {
  const { sessionId, dir, root, batch } = await fixture(t);
  const item = { id: randomUUID(), kind: 'followUp', text: '', images: [image] };
  const first = await batch([item]); await batch([item]);
  const listed = await listRecoveredInput(dir, sessionId);
  assert.equal(listed.length, 1);
  const [preview] = listed;
  assert.equal(preview.id, item.id);
  assert.equal(preview.imageCount, 1);
  assert.equal(preview.images, undefined);
  const loaded = await getRecoveredInput(dir, sessionId, first.id, item.id);
  assert.deepEqual(loaded.images, [image]);
  assert.equal(loaded.text, '');
  assert.match(loaded.digest, /^[a-f0-9]{64}$/);

  await mkdir(path.join(root, '.delivered'), { mode: 0o700 });
  await write(path.join(root, '.delivered', item.id), {});
  assert.deepEqual(await listRecoveredInput(dir, sessionId), []);
  await assert.rejects(getRecoveredInput(dir, sessionId, first.id, item.id), /already delivered/);
});

test('another session and substituted payloads cannot supply a saved message', async t => {
  const { sessionId, dir, batch } = await fixture(t);
  const item = { id: randomUUID(), kind: 'steer', text: 'Fixture input', images: [] };
  const other = await batch([item], randomUUID());
  await assert.rejects(getRecoveredInput(dir, sessionId, other.id, item.id), /read safely/);
  const requested = await batch([item]);
  const file = path.join(requested.folder, `${item.id}.json`);
  const old = await getRecoveredInput(dir, sessionId, requested.id, item.id);
  await write(file, { ...item, text: 'Changed fixture input' });
  assert.notEqual((await getRecoveredInput(dir, sessionId, requested.id, item.id)).digest, old.digest);
  await rm(file);
  await symlink(path.join(other.folder, `${item.id}.json`), file);
  await assert.rejects(getRecoveredInput(dir, sessionId, requested.id, item.id));
  await assert.rejects(getRecoveredInput(dir, sessionId, '../elsewhere', item.id), /Invalid saved message/);
});
