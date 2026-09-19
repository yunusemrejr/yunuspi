// Resolve only repository/installation-owned runtime code. Never ask global npm.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function resolveOwnedCore() {
  const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const candidates = [process.env.YUNUSPI_CORE_ROOT,
    path.join(agent, 'runtime/core/coding-agent'),
    path.resolve(agent, '../core/coding-agent')].filter(Boolean);
  for (const candidate of candidates) {
    const manifest = path.join(candidate, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (metadata.name !== '@yunuspi/coding-agent') throw Error(`Unowned core at ${candidate}`);
    return fs.realpathSync(candidate);
  }
  throw Error('YunusPi-owned core is missing; install or build the YunusPi source checkout');
}
