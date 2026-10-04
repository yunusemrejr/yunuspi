/** Per-route aggregate of observed slip rates, shared by every session on this
 * installation. Advisory data: a missing, corrupt or unwritable store only
 * means a session starts from the neutral prior. Writes are commutative
 * additions merged into whatever is on disk, so concurrent sessions cannot
 * overwrite each other's evidence (a lost race drops one small increment). */
import fs from 'node:fs';
import path from 'node:path';
import { mergeCompetence, type CompetenceAggregate, type CompetenceDelta } from './model-competence.ts';

export const COMPETENCE_STORE_VERSION = 1;
/** Key of the all-routes aggregate that defines the fleet rate. */
export const FLEET_KEY = '*';
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9_./:~+@-]{0,199}$/;
const validRoute = (route: string) => ROUTE.test(route) && !route.includes('..');
const MAX_ROUTES = 64;

export type CompetenceStore = Record<string, CompetenceAggregate>;

export const competenceStoreFile = (agentDir: string) => path.join(agentDir, 'competence', 'routes.json');

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function readCompetenceStore(file: string): CompetenceStore {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== COMPETENCE_STORE_VERSION || !parsed.routes || typeof parsed.routes !== 'object') return {};
    const out: CompetenceStore = {};
    for (const [route, value] of Object.entries<any>(parsed.routes)) {
      const slip = finite(value?.slip), mass = finite(value?.mass), updatedAt = finite(value?.updatedAt);
      if ((route === FLEET_KEY || validRoute(route)) && slip !== undefined && mass !== undefined && updatedAt !== undefined && slip <= mass) out[route] = { slip, mass, updatedAt };
      if (Object.keys(out).length >= MAX_ROUTES + 1) break;
    }
    return out;
  } catch { return {}; }
}

/** Fold increments into the stored aggregates (and the fleet aggregate) and write them back atomically. Returns the merged store. */
export function writeCompetenceDeltas(file: string, deltas: Record<string, CompetenceDelta>, now: number): CompetenceStore {
  const store = readCompetenceStore(file);
  let changed = false;
  for (const [route, delta] of Object.entries(deltas)) {
    if (!validRoute(route) || !(delta.mass > 0)) continue;
    store[route] = mergeCompetence(store[route], delta, now);
    store[FLEET_KEY] = mergeCompetence(store[FLEET_KEY], delta, now);
    changed = true;
  }
  if (!changed) return store;
  // Keep the fleet row and the most recently updated routes.
  const routes = Object.entries(store).filter(([key]) => key !== FLEET_KEY).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ROUTES);
  const bounded: CompetenceStore = Object.fromEntries(routes);
  if (store[FLEET_KEY]) bounded[FLEET_KEY] = store[FLEET_KEY];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: COMPETENCE_STORE_VERSION, routes: bounded }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch { /* advisory evidence: the session keeps its in-memory estimate */ }
  return bounded;
}
