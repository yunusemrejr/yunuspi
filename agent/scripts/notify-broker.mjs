#!/usr/bin/env node
/**
 * notify-broker.mjs — canonical desktop-notification policy for the pi harness.
 *
 * WHY (2026-09-07): harness components that wanted desktop attention called
 * raw notify-send. auto-update.sh was the only direct producer, but the
 * 5-minute pi-harness-repair timer re-ran it on every failing verify pass, so
 * one persistent defect (an upstream refactor breaking a patch anchor after
 * the 11:01 core update) produced an identical desktop popup every 5 minutes
 * for hours. Notifications are an attention API, not a logging API: logs may
 * be verbose, the status UI may be detailed, but desktop popups must be
 * sparse and consequential.
 *
 * POLICY (severity × category):
 *   debug / info                → status/log only, never desktop.
 *   warning                     → status only, unless explicitly --actionable.
 *   error                       → notify ONCE per fingerprint when the
 *                                 condition begins; identical repeats increment
 *                                 the retained occurrence count silently; one
 *                                 bounded aggregate reminder per
 *                                 reminderEveryMs (6h) while still failing.
 *   critical                    → immediate + bounded 30-minute reminders.
 *   escalation                  → a higher severity arriving on a known
 *                                 fingerprint re-notifies immediately.
 *   category=reminders          → always delivered (explicit user request;
 *                                 reminders keep their own delivery path today,
 *                                 this category exists so routing one in can
 *                                 never be throttled by diagnostic policy).
 *   category=background-diagnostics → never desktop.
 *   recovery                    → ONE recovery notification when a NOTIFIED,
 *                                 REPEATED (>=2 occurrences) failure resolves;
 *                                 single-run blips resolve silently in status.
 *
 * DEDUP: fingerprint = sha1(source | op | producer-normalized identity).
 * The PRODUCER must normalize volatile fields out (timestamps, PIDs, tmp
 * paths, retry counters, session ids, build hashes) — the broker never sees
 * them. State is one JSON file shared by every process (sessions, the
 * systemd repair/update units) under an atomic mkdir lock, so N concurrent
 * emitters of the same fingerprint produce ONE logical notification.
 *
 * RESTART SAFETY: suppression state lives on disk (firstSeen / lastNotifiedAt
 * / lastReminderAt), so a broker restart never replays old noise.
 *
 * FAILURE STATE (e.g. UPDATE_VERIFICATION_FAILED): `status` exposes per
 * fingerprint firstSeen / lastSeen / occurrences / severity / detail /
 * lastNotifiedAt; `resolve` clears and archives. Producers report state
 * transitions (healthy→failing→still failing→recovered), not per-retry
 * events.
 *
 * PRODUCER INVENTORY (2026-09-07 audit):
 *   scripts/auto-update.sh (+ pi-harness-repair timer/path units)
 *        → emit/resolve via this broker (was raw notify-send per failure).
 *   extensions/*.ts ctx.ui.notify
 *        → session-local TUI toasts — the STATUS layer, intentionally NOT
 *          brokered (session-local, mostly user-initiated feedback).
 *   extensions/reminders.ts
 *        → explicit user-requested reminders; own delivery path, unaffected.
 *   verify-harness.mjs, pi-subagents, pi-background-tasks, pi-memory, lens
 *        → no desktop notification of their own (exit codes, logs, TUI).
 *
 * FAILURE BEHAVIOR: internal errors exit 1; callers fall back to log-only
 * ATTENTION lines — a broken broker must never re-open the notification
 * storm nor break the updater. Unknown categories default to the quiet
 * background-diagnostics policy (fail-safe = silent, never noisy).
 *
 * CLI:
 *   emit --source auto-update --category updates --severity error --op verify \
 *        --fingerprint 'verify:ab12cd34' --message '…' [--detail '…']
 *        [--actionable] [--dry-run] [--reminder-every-ms MS]
 *   resolve --source auto-update [--op verify --op npm-update]
 *   status [--json]
 * Test hooks: PI_NOTIFY_STATE (state file override), PI_NOTIFY_SENDER
 * (sender command override); --reminder-every-ms and --dry-run for tests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_STATE = path.join(
  os.homedir(),
  ".pi/agent/logs/notification-state.json",
);
const STATE_PATH = process.env.PI_NOTIFY_STATE || DEFAULT_STATE;

const HOUR = 3_600_000;
// Per-category desktop policy. desktop: "always" | "on-error" | "never".
// reminderEveryMs: aggregate reminder interval while a condition persists.
// recoveryNotify: send one recovery notification on resolve (see
// RECOVERY_MIN_OCCURRENCES). Intervals chosen against harness conventions:
// the repair cycle is 5 min (a reminder every cycle would BE the storm) and
// the update cycle is daily (6h bounds sustained incidents to ≤4 reminders).
const CATEGORIES = {
  reminders: {
    desktop: "always",
    reminderEveryMs: 0,
    recoveryNotify: false,
  },
  "harness-critical": {
    desktop: "on-error",
    reminderEveryMs: 6 * HOUR,
    recoveryNotify: true,
  },
  updates: {
    desktop: "on-error",
    reminderEveryMs: 6 * HOUR,
    recoveryNotify: true,
  },
  "provider-health": {
    desktop: "on-error",
    reminderEveryMs: 6 * HOUR,
    recoveryNotify: true,
  },
  "background-diagnostics": {
    desktop: "never",
    reminderEveryMs: 0,
    recoveryNotify: false,
  },
};
const QUIET_POLICY = CATEGORIES["background-diagnostics"];
// Critical repeats stay bounded too — 30 min rather than 6h.
const CRITICAL_REMINDER_MS = 30 * 60_000;
// A resolved failure gets a desktop "recovered" notification only if it
// repeated (>=2 occurrences): single-run blips resolve silently, and this
// bounds a flapping fail→recover cycle to one notification per episode.
const RECOVERY_MIN_OCCURRENCES = 2;
const MAX_DETAIL = 600;
const MAX_ARCHIVE = 100;
const ACTIVE_TTL_MS = 30 * 24 * HOUR; // stale active entries fall out of status
const STALE_LOCK_MS = 15_000; // critical section is ~ms; a stale lock is dead
const LOCK_WAIT_MS = 10_000;

const SEV_RANK = { debug: 0, info: 0, warning: 1, error: 2, critical: 3 };
const URGENCY = { critical: "critical", error: "normal", warning: "low" };

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => String(s ?? "").slice(0, n);

function parseArgs(argv) {
  const valueFlags = new Set([
    "source",
    "category",
    "severity",
    "op",
    "fingerprint",
    "message",
    "detail",
    "reminder-every-ms",
  ]);
  const out = { op: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (valueFlags.has(name)) {
      const v = argv[++i];
      // --op is repeatable (a resolve may clear several ops at once); other
      // value flags are single-valued.
      if (name === "op") out.op.push(v);
      else out[name] = v;
    } else out[name] = true;
  }
  return out;
}

function withStateLock(statePath, fn) {
  const lockDir = `${statePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; /* vanished */
      }
      if (Date.now() > deadline)
        throw new Error(`state lock timeout: ${lockDir}`);
      spawnSync("sleep", ["0.05"]);
    }
  }
  // Note: two waiters can both stale-break a dead lock in the same instant
  // and interleave; the worst case is one duplicate desktop event in a rare
  // race, never lost state.
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (st && st.version === 1 && st.active) return st;
    throw new Error("bad shape");
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Preserve the corrupt file for postmortem, then start clean — the
      // broker must never take the updater down with it.
      try {
        fs.copyFileSync(STATE_PATH, `${STATE_PATH}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
    }
    return { version: 1, active: {}, resolved: [] };
  }
}

function saveState(state) {
  const now = Date.now();
  for (const [k, e] of Object.entries(state.active))
    if (now - e.lastSeen > ACTIVE_TTL_MS) delete state.active[k];
  if (state.resolved.length > MAX_ARCHIVE) state.resolved.length = MAX_ARCHIVE;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function sendDesktop({ urgency, title, message }, dryRun) {
  if (dryRun) return { sent: false, dryRun: true };
  const sender = process.env.PI_NOTIFY_SENDER || "notify-send";
  try {
    const r = spawnSync(sender, ["-u", urgency, title, message], {
      timeout: 5_000,
      stdio: "ignore",
    });
    return { sent: !r.error && r.status === 0 && r.signal === null, sender }; /* PI_NOTIFY_DELIVERY_TRUTH */
  } catch {
    return { sent: false, sender };
  }
}

// ── emit ─────────────────────────────────────────────────────────────────────
function emit(a) {
  const source = a.source,
    op = a.op[0] || "default";
  const severity = a.severity || "info";
  const fp = a.fingerprint ?? "";
  if (!source || !fp || !a.message)
    return {
      ok: false,
      error: "emit requires --source --fingerprint --message",
    };
  if (!(severity in SEV_RANK))
    return { ok: false, error: `unknown severity '${severity}'` };
  const policy = CATEGORIES[a.category] || QUIET_POLICY;
  const key = sha1(`${source}|${op}|${fp}`);
  const now = Date.now();
  let decision;

  const state = loadState();
  const entry = state.active[key];
  if (!entry) {
    const e = {
      key,
      source,
      op,
      category: a.category || "background-diagnostics",
      fingerprint: String(fp).slice(0, 200),
      severity,
      summary: String(a.message).slice(0, 200),
      detail: clip(a.detail, MAX_DETAIL),
      firstSeen: now,
      lastSeen: now,
      occurrences: 1,
      lastNotifiedAt: null,
      lastReminderAt: null,
      notified: false,
      deliveryFailed: false,
      resolvedAt: null,
    };
    state.active[key] = e;
    decision = { desktop: false, kind: "status-only", urgency: "normal" };
    if (policy.desktop === "always") {
      decision = {
        desktop: true,
        kind: "user-reminder",
        urgency: URGENCY[severity] || "low",
      };
    } else if (policy.desktop === "on-error") {
      if (severity === "error" || severity === "critical")
        decision = { desktop: true, kind: "first", urgency: URGENCY[severity] };
      else if (severity === "warning" && a.actionable)
        decision = { desktop: true, kind: "first-actionable", urgency: "low" };
    }
    // Bubble only when the policy actually decided desktop — status-only
    // events record state (occurrences, firstSeen) without reaching the
    // desktop. This is the info/debug-never-spam guarantee.
    if (decision.desktop) {
      const delivery = bubble(e, decision, String(a.message));
      if (!delivery.dryRun) e.deliveryFailed = !delivery.sent;
      if (delivery.sent || delivery.dryRun) {
        e.notified = true;
        e.lastNotifiedAt = now;
      } /* PI_NOTIFY_DELIVERY_COMMIT_V2 */
    }
  } else {
    entry.occurrences++;
    entry.lastSeen = now;
    const escalated = SEV_RANK[severity] > SEV_RANK[entry.severity];
    if (escalated) {
      entry.severity = severity;
      entry.summary = String(a.message).slice(0, 200);
    }
    if (a.detail) entry.detail = clip(a.detail, MAX_DETAIL);
    decision = { desktop: false, kind: "count-only", urgency: "normal" };
    if (
      entry.deliveryFailed &&
      (policy.desktop === "always" || policy.desktop === "on-error" &&
        (severity === "error" || severity === "critical" || severity === "warning" && a.actionable))
    ) {
      decision = {
        desktop: true,
        kind: "retry",
        urgency: URGENCY[severity] || "low",
      };
    } else if (policy.desktop === "always") {
      decision = {
        desktop: true,
        kind: "user-reminder",
        urgency: URGENCY[severity] || "low",
      };
    } else if (policy.desktop === "on-error") {
      if (escalated && (severity === "error" || severity === "critical")) {
        decision = {
          desktop: true,
          kind: "escalated",
          urgency: URGENCY[severity],
        };
      } else if (severity === "error" || severity === "critical") {
        const every =
          Number(a["reminder-every-ms"]) ||
          (entry.severity === "critical"
            ? CRITICAL_REMINDER_MS
            : policy.reminderEveryMs || Infinity);
        const since = Math.max(
          entry.lastNotifiedAt ?? 0,
          entry.lastReminderAt ?? 0,
        );
        if (Number.isFinite(every) && now - since >= every)
          decision = {
            desktop: true,
            kind: "reminder",
            urgency: URGENCY[entry.severity],
          };
      } else if (severity === "warning" && a.actionable && !entry.notified) {
        // The entry may predate its first actionable report (e.g. created by
        // a non-actionable warning): the first actionable occurrence still
        // notifies once; repeats stay silent.
        decision = { desktop: true, kind: "first-actionable", urgency: "low" };
      }
      // warning/info repeats: count-only, never desktop.
    }
    if (decision.desktop) {
      const delivery = bubble(entry, decision);
      if (!delivery.dryRun) entry.deliveryFailed = !delivery.sent;
      if (delivery.sent || delivery.dryRun) {
        if (decision.kind === "reminder") entry.lastReminderAt = now;
        else {
          entry.notified = true;
          entry.lastNotifiedAt = now;
        }
      }
    }
  }
  saveState(state);
  const deliveryFailed = decision.desktop &&
    !parseGlobal.dryRun &&
    state.active[key]?.deliveryFailed === true;
  return {
    ok: !deliveryFailed,
    ...(deliveryFailed ? { error: "desktop notification delivery failed" } : {}),
    action: "emit",
    desktop: decision.desktop,
    kind: decision.kind,
    occurrences: state.active[key]?.occurrences ?? 1,
    key,
  };
}

function bubble(entry, decision, textOverride) {
  const title = `pi ${entry.source}`;
  let message;
  if (decision.kind === "reminder")
    message = `${entry.summary} — still failing, ${entry.occurrences} occurrence(s) since ${iso(entry.firstSeen)}`;
  else message = textOverride ?? entry.summary;
  return sendDesktop(
    {
      urgency: decision.urgency,
      title,
      // Desktop bubbles are single-line by contract; multi-line producer text
      // belongs in logs/status, not the notification bubble.
      message: String(message).replace(/\s+/g, " ").slice(0, 300),
    },
    parseGlobal.dryRun,
  );
}

// ── resolve ──────────────────────────────────────────────────────────────────
function resolve(a) {
  if (!a.source) return { ok: false, error: "resolve requires --source" };
  const ops = a.op;
  const now = Date.now();
  const state = loadState();
  const matched = Object.values(state.active).filter(
    (e) => e.source === a.source && (!ops.length || ops.includes(e.op)),
  );
  for (const e of matched) {
    e.resolvedAt = now;
    state.resolved.unshift(e);
    delete state.active[e.key];
  }
  const recovery = matched.filter(
    (e) => e.notified && e.occurrences >= RECOVERY_MIN_OCCURRENCES,
  );
  let recoveryNotified = false;
  let deliveryFailed = false;
  if (
    recovery.length &&
    recovery.some(
      (e) => (CATEGORIES[e.category] || QUIET_POLICY).recoveryNotify,
    )
  ) {
    const n = recovery.reduce((s, e) => s + e.occurrences, 0);
    const label = [...new Set(recovery.map((e) => e.summary))]
      .slice(0, 3)
      .join("; ");
    if (!parseGlobal.dryRun) {
      const sender = process.env.PI_NOTIFY_SENDER || "notify-send";
      try {
        const senderResult = spawnSync(
          sender,
          [
            "-u",
            "normal",
            `pi ${a.source}`,
            `Recovered after ${n} occurrence(s): ${label}`
              .replace(/\s+/g, " ")
              .slice(0, 300),
          ],
          { timeout: 5_000, stdio: "ignore" },
        );
        if (senderResult.error || senderResult.status !== 0 || senderResult.signal !== null)
          deliveryFailed = true;
      } catch {
        deliveryFailed = true;
      }
    }
    recoveryNotified = !deliveryFailed;
  }
  saveState(state);
  return {
    ok: !deliveryFailed,
    ...(deliveryFailed ? { error: "desktop notification delivery failed" } : {}),
    action: "resolve",
    resolved: matched.length,
    recoveryNotified,
  };
}

// ── status ───────────────────────────────────────────────────────────────────
function status(a) {
  const state = loadState();
  const active = Object.values(state.active).sort(
    (x, y) => y.lastSeen - x.lastSeen,
  );
  // --json returns the payload through the single result envelope (no second
  // stdout document); human output is log-style lines.
  if (a.json)
    return { ok: true, active, resolvedRecent: state.resolved.slice(0, 10) };
  if (!active.length) console.log("no active failure states");
  for (const e of active) {
    console.log(
      `[${e.category}] ${e.source}/${e.op} ${e.fingerprint} severity=${e.severity} ` +
        `occurrences=${e.occurrences} first=${iso(e.firstSeen)} last=${iso(e.lastSeen)}` +
        (e.notified
          ? ` lastNotified=${iso(e.lastNotifiedAt)}`
          : " (never notified)"),
    );
    if (e.summary) console.log(`  summary: ${e.summary}`);
    if (e.detail) console.log(`  detail: ${e.detail}`);
  }
  if (state.resolved.length)
    console.log(
      `recently resolved: ${state.resolved.length} archived (latest: ${state.resolved[0].summary} @ ${iso(state.resolved[0].resolvedAt)})`,
    );
  return { ok: true };
}

// ── main ─────────────────────────────────────────────────────────────────────
const parseGlobal = parseArgs(process.argv.slice(2));
const [cmd] = parseGlobal._;
let result;
try {
  if (!STATE_PATH) throw new Error("no state path");
  if (cmd === "emit" || cmd === "resolve") {
    result = withStateLock(STATE_PATH, () =>
      cmd === "emit" ? emit(parseGlobal) : resolve(parseGlobal),
    );
  } else if (cmd === "status") {
    result = status(parseGlobal);
  } else {
    result = {
      ok: false,
      error: "usage: notify-broker.mjs emit|resolve|status …",
    };
  }
} catch (e) {
  result = { ok: false, error: e.message };
}
console.log(JSON.stringify(result));
process.exit(
  result.ok === false ? (result.error?.startsWith("usage") ? 2 : 1) : 0,
);
