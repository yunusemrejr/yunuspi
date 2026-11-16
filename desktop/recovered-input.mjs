import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const kinds = new Set(['steer', 'followUp']);
const maxImageData = 14_000_000;
const maxManifestBytes = 256 * 1024;
const maxMessageBytes = 15 * 1024 * 1024;

export function validateDesktopImages(images) {
  if (!Array.isArray(images) || images.length > 6 || images.some(image => image?.type !== 'image' ||
      !imageTypes.has(image.mimeType) || typeof image.data !== 'string' || image.data.length > maxImageData ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) throw Error('Invalid image attachment.');
  if (images.reduce((sum, image) => sum + image.data.length, 0) > maxImageData) throw Error('Attachments together must be smaller than 10 MiB.');
  return images.map(({ type, mimeType, data }) => ({ type, mimeType, data }));
}

const isId = value => typeof value === 'string' && UUID.test(value);
const owned = stat => (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
const unsafe = () => Error('Saved queued messages could not be read safely. Their files were retained.');

async function directory(filename) {
  const stat = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat && (!stat.isDirectory() || !owned(stat))) throw unsafe();
  return stat;
}

async function privateJson(filename, maxBytes, withDigest = false) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => { throw unsafe(); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || stat.size <= 0 || stat.size > maxBytes) throw unsafe();
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw unsafe();
      offset += bytesRead;
    }
    const after = await file.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw unsafe();
    return { value: JSON.parse(bytes.toString('utf8')), digest: withDigest ? createHash('sha256').update(bytes).digest('hex') : undefined };
  } catch (error) {
    throw new Error(unsafe().message, { cause: error });
  } finally {
    await file.close();
  }
}

async function readManifest(root, sessionId, batchId) {
  if (!isId(batchId)) throw Error('Invalid saved queue receipt.');
  const batch = path.join(root, batchId);
  if (!await directory(batch)) return null;
  const { value } = await privateJson(path.join(batch, 'manifest.json'), maxManifestBytes);
  if (value?.version !== 1 || value.sessionId !== sessionId || value.id !== batchId ||
      !Array.isArray(value.entries) || value.entries.length > 128) throw unsafe();
  const ids = new Set();
  for (const entry of value.entries) {
    if (!isId(entry?.id) || ids.has(entry.id) || !kinds.has(entry.kind) || typeof entry.preview !== 'string' ||
        entry.preview.length > 160 || !Number.isInteger(entry.imageCount) || entry.imageCount < 0 || entry.imageCount > 6) throw unsafe();
    ids.add(entry.id);
  }
  return value.entries;
}

async function deliveredIds(root) {
  const delivered = path.join(root, '.delivered');
  const ids = new Set();
  if (!await directory(delivered)) return ids;
  for await (const entry of await opendir(delivered)) {
    if (entry.isFile() && isId(entry.name)) ids.add(entry.name);
    if (ids.size > 32768) throw unsafe();
  }
  return ids;
}

export async function listRecoveredInput(transcriptDirectory, sessionId) {
  const root = path.join(transcriptDirectory, '.queue-recovery');
  if (!await directory(root)) return [];
  const delivered = await deliveredIds(root);
  const batches = [];
  for await (const entry of await opendir(root)) {
    if (!isId(entry.name)) continue;
    const stat = await directory(path.join(root, entry.name));
    if (stat) batches.push({ id: entry.name, time: stat.mtimeMs });
    if (batches.length > 512) throw unsafe();
  }
  batches.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const saved = new Map();
  for (const batch of batches) {
    for (const entry of await readManifest(root, sessionId, batch.id) ?? []) {
      if (!delivered.has(entry.id) && !saved.has(entry.id)) saved.set(entry.id, { ...entry, batchId: batch.id });
    }
  }
  return [...saved.values()];
}

export async function getRecoveredInput(transcriptDirectory, sessionId, batchId, id) {
  if (!isId(id) || !isId(batchId)) throw Error('Invalid saved message.');
  const root = path.join(transcriptDirectory, '.queue-recovery');
  if (!await directory(root)) throw Error('This saved message is unavailable.');
  const entries = await readManifest(root, sessionId, batchId);
  const item = entries?.find(entry => entry.id === id);
  if (!item) throw Error('This saved message is unavailable.');
  const delivered = path.join(root, '.delivered');
  if (await directory(delivered) && await lstat(path.join(delivered, id)).then(stat => stat.isFile() && owned(stat), error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  })) throw Error('This saved message was already delivered.');
  const { value, digest } = await privateJson(path.join(root, batchId, `${id}.json`), maxMessageBytes, true);
  if (value?.id !== id || value.kind !== item.kind || typeof value.text !== 'string' || value.text.length > 100_000) throw unsafe();
  const images = validateDesktopImages(value.images);
  if (images.length !== item.imageCount || !value.text.trim() && !images.length) throw unsafe();
  return { id, kind: value.kind, text: value.text, images, digest };
}
