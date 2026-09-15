/** Shared per-capability health: seven states, usefulness ratios, auto-gating.
 * Pure transition core plus a tiny bounded store. Observations flow in shadow:
 * recording never blocks, gates or delays any caller. Enforcement belongs to
 * future control-plane phases; this layer only reports honestly.
 * Key namespaces (string ids, advisory): `tool:<name>`, `skill:<path>`,
 * `service:<name>`, `provider:<id>`. Unknown ids fail open (no opinion).
 * Admin states (disabled/retired) are recorded here but never decided here:
 * only the host capability policy disables tool families. */
export type CapabilityHealthState =
  | 'unknown'   // no conclusive observations yet
  | 'healthy'   // serving normally
  | 'degraded'  // elevated failures, still serving (never gated)
  | 'failing'   // tripped on a failure streak, gated, cooling down
  | 'cooldown'  // cooldown elapsed, gated, awaiting a probe outcome
  | 'disabled'  // host-administered off; sticky, reported not decided
  | 'retired';  // removed from the catalogue; sticky, reported not decided
export const CAPABILITY_HEALTH_STATES: readonly CapabilityHealthState[] = Object.freeze([
  'unknown', 'healthy', 'degraded', 'failing', 'cooldown', 'disabled', 'retired',
]);
export interface CapabilityHealthPolicy {
  /** Consecutive failures that trip healthy/degraded/cooldown to failing. */
  failStreakTrip: number;
  /** Consecutive failures that mark a healthy capability degraded. */
  degradeStreak: number;
  /** Gate duration before a probe outcome is accepted. */
  cooldownMs: number;
  /** Bounded store: oldest ids evict first, deterministically. */
  maxCapabilities: number;
}
export const DEFAULT_CAPABILITY_HEALTH_POLICY: CapabilityHealthPolicy = Object.freeze({
  failStreakTrip: 3, degradeStreak: 2, cooldownMs: 60_000, maxCapabilities: 256,
});
export interface CapabilityHealthObservation { ok: boolean; useful?: boolean }
export interface CapabilityHealthRecord {
  id: string; state: CapabilityHealthState;
  uses: number; successes: number; failures: number;
  useful: number; usefulTotal: number;
  consecutiveFailures: number; consecutiveSuccesses: number;
  updatedAt: number; cooledUntil: number; adminReason: string;
}
export interface CapabilityHealthGate { gate: boolean; state: CapabilityHealthState; note: string }
export interface CapabilityHealthTransition { id: string; from: CapabilityHealthState; to: CapabilityHealthState; reason: 'success' | 'failure' | 'admin' }
const MAX_ID = 200, MAX_REASON = 240, SNAPSHOT_VERSION = 1;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length >= 1 && id.length <= MAX_ID;
const blank = (id: string): CapabilityHealthRecord => ({id, state: 'unknown', uses: 0, successes: 0, failures: 0, useful: 0, usefulTotal: 0, consecutiveFailures: 0, consecutiveSuccesses: 0, updatedAt: 0, cooledUntil: 0, adminReason: ''});

/** Pure observation step. Returns the next record plus the net transition, if any. */
export function applyHealthObservation(prev: CapabilityHealthRecord | null, id: string, outcome: CapabilityHealthObservation, policy: CapabilityHealthPolicy, now: number): { rec: CapabilityHealthRecord; transition?: CapabilityHealthTransition } {
  const rec: CapabilityHealthRecord = prev ? {...prev} : blank(id);
  const ok = outcome?.ok === true;
  rec.uses++;
  if (ok) { rec.successes++; rec.consecutiveSuccesses++; rec.consecutiveFailures = 0; }
  else { rec.failures++; rec.consecutiveFailures++; rec.consecutiveSuccesses = 0; }
  if (outcome && typeof outcome.useful === 'boolean') { rec.usefulTotal++; if (outcome.useful) rec.useful++; }
  rec.updatedAt = now;
  const from = rec.state;
  if (from === 'disabled' || from === 'retired') return {rec};
  const effective = from === 'failing' && now >= rec.cooledUntil ? 'cooldown' : from;
  let to = effective;
  if (effective === 'unknown') to = ok ? 'healthy' : 'degraded';
  else if (effective === 'healthy') { if (!ok) to = rec.consecutiveFailures >= policy.failStreakTrip ? 'failing' : rec.consecutiveFailures >= policy.degradeStreak ? 'degraded' : 'healthy'; }
  else if (effective === 'degraded') {
    if (ok) to = rec.consecutiveSuccesses >= 2 ? 'healthy' : 'degraded';
    else to = rec.consecutiveFailures >= policy.failStreakTrip ? 'failing' : 'degraded';
  }
  else if (effective === 'failing') to = 'failing';
  else if (effective === 'cooldown') { to = ok ? 'healthy' : 'failing'; if (!ok) rec.cooledUntil = now + policy.cooldownMs; }
  if (to === 'failing' && from !== 'failing') rec.cooledUntil = now + policy.cooldownMs;
  if (to === 'healthy') rec.cooledUntil = 0;
  rec.state = to;
  if (to === from) return {rec};
  return {rec, transition: {id, from, to, reason: ok ? 'success' : 'failure'}};
}

/** Pure gate decision for a record (null reads as unknown, fail-open). */
export function gateForHealth(rec: CapabilityHealthRecord | null, now: number): CapabilityHealthGate {
  if (!rec) return {gate: false, state: 'unknown', note: 'no-observations'};
  const state = rec.state === 'failing' && now >= rec.cooledUntil ? 'cooldown' : rec.state;
  if (state === 'failing') return {gate: true, state, note: 'tripped'};
  if (state === 'cooldown') return {gate: true, state, note: 'awaiting-probe'};
  if (state === 'disabled') return {gate: true, state, note: rec.adminReason || 'admin-disabled'};
  if (state === 'retired') return {gate: true, state, note: rec.adminReason || 'retired'};
  if (state === 'degraded') return {gate: false, state, note: 'serving-with-elevated-failures'};
  return {gate: false, state, note: state === 'unknown' ? 'no-observations' : ''};
}

export function serializeHealthSnapshot(records: Iterable<CapabilityHealthRecord>): { version: 1; records: CapabilityHealthRecord[] } {
  return {version: SNAPSHOT_VERSION, records: [...records].slice(-DEFAULT_CAPABILITY_HEALTH_POLICY.maxCapabilities)};
}

/** Strict parse: malformed entries are dropped and counted, never throw. */
export function parseHealthSnapshot(data: unknown): { records: CapabilityHealthRecord[]; rejected: number } {
  const records: CapabilityHealthRecord[] = [];
  let rejected = 0;
  const list = (data as { records?: unknown })?.records;
  if (!data || typeof data !== 'object' || !Array.isArray(list)) return {records, rejected: 1};
  for (const entry of list.slice(-DEFAULT_CAPABILITY_HEALTH_POLICY.maxCapabilities)) {
    const e = entry as CapabilityHealthRecord;
    const ints = [e?.uses, e?.successes, e?.failures, e?.useful, e?.usefulTotal, e?.consecutiveFailures, e?.consecutiveSuccesses, e?.updatedAt, e?.cooledUntil];
    if (!e || typeof e !== 'object' || !validId(e.id) || !(CAPABILITY_HEALTH_STATES as readonly string[]).includes(e.state)
      || ints.some(n => !Number.isSafeInteger(n) || (n as number) < 0) || typeof e.adminReason !== 'string' || e.adminReason.length > MAX_REASON) { rejected++; continue; }
    records.push({id: e.id, state: e.state, uses: e.uses, successes: e.successes, failures: e.failures, useful: e.useful, usefulTotal: e.usefulTotal, consecutiveFailures: e.consecutiveFailures, consecutiveSuccesses: e.consecutiveSuccesses, updatedAt: e.updatedAt, cooledUntil: e.cooledUntil, adminReason: e.adminReason});
  }
  return {records, rejected};
}

export type HealthTransitionEmitter = (event: CapabilityHealthTransition) => void;
const defaultEmit: HealthTransitionEmitter = event => {
  try { (globalThis as { [k: symbol]: unknown })[Symbol.for('yunus-pi.health.v1')]?.('capability.health', event as unknown as Record<string, unknown>); } catch { /* telemetry is optional */ }
};

export function createCapabilityHealth(options: { policy?: CapabilityHealthPolicy; now?: () => number; emit?: HealthTransitionEmitter } = {}) {
  const policy = {...DEFAULT_CAPABILITY_HEALTH_POLICY, ...options.policy};
  const now = options.now ?? Date.now;
  const emit = options.emit ?? defaultEmit;
  const records = new Map<string, CapabilityHealthRecord>();
  const off = () => (process.env.PI_CAPABILITY_HEALTH ?? '') === 'off';
  // Time-based refresh writes through silently so reads, gates, snapshots and
  // audits share one truth. Only observation/admin edges emit transitions.
  const refresh = (rec: CapabilityHealthRecord): CapabilityHealthRecord => {
    if (rec.state === 'failing' && now() >= rec.cooledUntil) { rec.state = 'cooldown'; rec.updatedAt = now(); }
    return rec;
  };
  return {
    observe(id: string, outcome: CapabilityHealthObservation): void {
      if (off() || !validId(id) || !outcome || typeof outcome !== 'object') return;
      let rec = records.get(id) ?? null;
      if (!rec && records.size >= policy.maxCapabilities) records.delete(records.keys().next().value!);
      const next = applyHealthObservation(rec, id, outcome, policy, now());
      records.set(id, next.rec);
      if (next.transition) emit(next.transition);
    },
    /** Host-reported admin edge. Null clears back to unknown (fresh evidence). */
    setAdminState(id: string, state: 'disabled' | 'retired' | null, reason = ''): void {
      if (off() || !validId(id)) return;
      if (state !== null && state !== 'disabled' && state !== 'retired') return;
      if (typeof reason !== 'string' || reason.length > MAX_REASON) return;
      if (state === null) { records.delete(id); return; }
      let rec = records.get(id);
      const from = rec?.state ?? 'unknown';
      if (!rec) {
        if (records.size >= policy.maxCapabilities) records.delete(records.keys().next().value!);
        rec = blank(id);
      }
      rec.state = state; rec.adminReason = reason; rec.updatedAt = now();
      records.set(id, rec);
      if (from !== state) emit({id, from, to: state, reason: 'admin'});
    },
    state(id: string): CapabilityHealthState {
      if (off() || !validId(id)) return 'unknown';
      const rec = records.get(id);
      return rec ? refresh(rec).state : 'unknown';
    },
    gate(id: string): CapabilityHealthGate {
      if (off() || !validId(id)) return {gate: false, state: 'unknown', note: off() ? 'layer-off' : 'no-observations'};
      const rec = records.get(id);
      return gateForHealth(rec ? refresh(rec) : null, now());
    },
    usefulness(id: string): { uses: number; useful: number; total: number; ratio: number | undefined } | undefined {
      if (off() || !validId(id)) return;
      const rec = records.get(id);
      if (!rec) return;
      return {uses: rec.uses, useful: rec.useful, total: rec.usefulTotal, ratio: rec.usefulTotal ? Math.round(rec.useful / rec.usefulTotal * 1000) / 1000 : undefined};
    },
    inspect(): { capabilities: number; gated: string[]; states: Record<CapabilityHealthState, number> } {
      const states = Object.fromEntries(CAPABILITY_HEALTH_STATES.map(s => [s, 0])) as Record<CapabilityHealthState, number>;
      const gated: string[] = [];
      if (!off()) for (const rec of records.values()) {
        refresh(rec);
        states[rec.state]++;
        if (gateForHealth(rec, now()).gate) gated.push(rec.id);
      }
      return {capabilities: off() ? 0 : records.size, gated: gated.sort(), states};
    },
    snapshot() { return off() ? {version: SNAPSHOT_VERSION as 1, records: []} : serializeHealthSnapshot([...records.values()].map(refresh)); },
    restore(data: unknown): number {
      if (off()) return 0;
      const {records: parsed} = parseHealthSnapshot(data);
      records.clear();
      for (const rec of parsed.slice(-policy.maxCapabilities)) records.set(rec.id, {...rec});
      return records.size;
    },
    reset() { records.clear(); },
  };
}

/** Process-shared runtime instance for cross-extension shadow observations.
 * Tests must use createCapabilityHealth() for isolation; this singleton is for
 * live wiring (health-log observes, audits read) only. */
let shared: ReturnType<typeof createCapabilityHealth> | undefined;
export function sharedCapabilityHealth() {
  if (!shared) shared = createCapabilityHealth();
  return shared;
}
