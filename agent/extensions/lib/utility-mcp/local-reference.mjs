import fs from 'node:fs';
import path from 'node:path';
import { digest, within } from './files.mjs';

/** Inspect only the components of an explicit path; never follow outside roots. */
export function localReference(files, root, requested, directory = false) {
  const target = path.resolve(root, requested);
  if (!within(root, target)) return { status: 'outside-root' };
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  if (parts.length > 32) return { status: 'limit', reason: 'Path exceeds 32 components' };
  let at = root, mismatch = false;
  for (const part of parts) {
    let next = path.join(at, part);
    try { fs.lstatSync(next); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { status: 'unavailable' };
      let handle;
      const matches = [];
      try {
        handle = fs.opendirSync(at);
        for (let n = 0;; n++) {
          const entry = handle.readSync();
          if (!entry) break;
          if (n >= 2048) return { status: 'limit', reason: 'Case lookup exceeds 2048 directory entries' };
          if (entry.name.toLowerCase() === part.toLowerCase()) matches.push(entry.name);
        }
      } catch { return { status: 'missing' }; }
      finally { handle?.closeSync(); }
      if (matches.length !== 1) return { status: matches.length ? 'ambiguous-case' : 'missing' };
      mismatch = true;
      next = path.join(at, matches[0]);
    }
    try { at = fs.realpathSync(next); }
    catch { return { status: 'unavailable' }; }
    if (!within(root, at) || !within(files.root, at)) return { status: 'outside-root' };
  }
  try {
    const stat = fs.statSync(at);
    if (directory ? !stat.isDirectory() : !stat.isFile()) return { status: 'wrong-type' };
    return { status: mismatch ? 'case-mismatch' : 'present', path: path.relative(root, at).split(path.sep).join('/'), size: stat.size };
  } catch { return { status: 'unavailable' }; }
}

export function referenceEvidence(files, root, requested, directory = false) {
  const result = localReference(files, root, requested, directory);
  // Existence/case changes affect the evidence hash even when source bytes do not.
  files.inputs.set(`reference:${path.relative(files.root, root)}:${requested}:${directory}`, digest(JSON.stringify(result)));
  return result;
}
