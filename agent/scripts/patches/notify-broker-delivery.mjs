// Preserve notification delivery truth in notify-broker.
//
// spawnSync returns a result with `error === undefined` even when the sender
// exits nonzero. The old broker therefore marked a failed notify-send as
// delivered and suppressed future attempts. Keep the failure in durable state,
// retry on the next matching emit, and return a nonzero broker result so
// callers can use their log-only fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "PI_NOTIFY_DELIVERY_TRUTH";

function targetPath() {
  return process.env.PI_HARNESS_PATCH_TEST_NOTIFY_BROKER ??
    path.join(os.homedir(), ".pi", "agent", "scripts", "notify-broker.mjs");
}

function applied(source) {
  return source.includes('PI_NOTIFY_DELIVERY_COMMIT_V2') && source.includes(MARKER) &&
    source.includes("r.status === 0 && r.signal === null") &&
    source.includes("entry.deliveryFailed") &&
    source.includes("senderResult.status !== 0");
}

export function targets() {
  const file = targetPath();
  return [
    {
      name: "notify-broker: preserve desktop delivery truth",
      file,
      exists: () => fs.existsSync(file),
      isApplied: () => applied(fs.readFileSync(file, "utf8")),
      apply() {
        let source = fs.readFileSync(file, "utf8");
        if (applied(source)) return;
        if (source.includes(MARKER)) {
          const next = commitDeliveryTruth(source);
          fs.writeFileSync(file, next);
          return;
        }
        if (source.includes('PI_NOTIFY_DELIVERY_COMMIT_V2'))
          throw new Error("notify delivery marker is present but patch is incomplete");

        const senderAnchor = "return { sent: !r.error, sender };";
        if (!source.includes(senderAnchor))
          throw new Error("notify sender status anchor drift");
        source = source.replace(
          senderAnchor,
          `return { sent: !r.error && r.status === 0 && r.signal === null, sender }; /* ${MARKER} */`,
        );

        const stateAnchor = "      notified: false,\n      resolvedAt: null,";
        if (!source.includes(stateAnchor))
          throw new Error("notify delivery state anchor drift");
        source = source.replace(
          stateAnchor,
          "      notified: false,\n      deliveryFailed: false,\n      resolvedAt: null,",
        );

        const bubbleAnchor = `function bubble(entry, decision, textOverride) {`;
        if (!source.includes(bubbleAnchor))
          throw new Error("notify bubble anchor drift");
        const bubbleCallAnchor = `  sendDesktop(\n    {`;
        if (!source.includes(bubbleCallAnchor))
          throw new Error("notify bubble call anchor drift");
        source = source.replace(bubbleCallAnchor, `  return sendDesktop(\n    {`);

        const firstBubbleAnchor = `      bubble(e, decision, String(a.message));`;
        if (!source.includes(firstBubbleAnchor))
          throw new Error("notify first delivery anchor drift");
        source = source.replace(
          firstBubbleAnchor,
          `      const delivery = bubble(e, decision, String(a.message));
      if (!delivery.dryRun) e.deliveryFailed = !delivery.sent;`,
        );

        const repeatPolicyAnchor = `    decision = { desktop: false, kind: "count-only", urgency: "normal" };\n    if (policy.desktop === "always") {\n      decision = {`;
        if (!source.includes(repeatPolicyAnchor))
          throw new Error("notify repeat policy anchor drift");
        source = source.replace(
          repeatPolicyAnchor,
          `    decision = { desktop: false, kind: "count-only", urgency: "normal" };
    if (
      entry.deliveryFailed &&
      (policy.desktop === "always" || severity === "error" || severity === "critical")
    ) {
      decision = {
        desktop: true,
        kind: "retry",
        urgency: URGENCY[severity] || "low",
      };
    } else if (policy.desktop === "always") {
      decision = {`,
        );

        const repeatBubbleAnchor = `      bubble(entry, decision);`;
        if (!source.includes(repeatBubbleAnchor))
          throw new Error("notify repeat delivery anchor drift");
        source = source.replace(
          repeatBubbleAnchor,
          `      const delivery = bubble(entry, decision);
      if (!delivery.dryRun) entry.deliveryFailed = !delivery.sent;`,
        );

        const returnAnchor = `  return {\n    ok: true,\n    action: "emit",`;
        if (!source.includes(returnAnchor))
          throw new Error("notify emit return anchor drift");
        source = source.replace(
          returnAnchor,
          `  const deliveryFailed = decision.desktop &&
    !parseGlobal.dryRun &&
    state.active[key]?.deliveryFailed === true;
  return {
    ok: !deliveryFailed,
    ...(deliveryFailed ? { error: "desktop notification delivery failed" } : {}),
    action: "emit",`,
        );

        const recoveryStateAnchor = `  let recoveryNotified = false;\n  if (`;
        if (!source.includes(recoveryStateAnchor))
          throw new Error("notify recovery state anchor drift");
        source = source.replace(
          recoveryStateAnchor,
          `  let recoveryNotified = false;
  let deliveryFailed = false;
  if (`,
        );

        const recoverySenderAnchor = `      try {\n        spawnSync(\n          sender,`;
        if (!source.includes(recoverySenderAnchor))
          throw new Error("notify recovery sender anchor drift");
        source = source.replace(
          recoverySenderAnchor,
          `      try {
        const senderResult = spawnSync(
          sender,`,
        );

        const recoveryResultAnchor = `          { timeout: 5_000, stdio: "ignore" },\n        );\n      } catch {\n        /* sender failure must not fail the resolve */\n      }\n    }\n    recoveryNotified = true;`;
        if (!source.includes(recoveryResultAnchor))
          throw new Error("notify recovery result anchor drift");
        source = source.replace(
          recoveryResultAnchor,
          `          { timeout: 5_000, stdio: "ignore" },
        );
        if (senderResult.error || senderResult.status !== 0 || senderResult.signal !== null)
          deliveryFailed = true;
      } catch {
        deliveryFailed = true;
      }
    }
    recoveryNotified = !deliveryFailed;`,
        );

        const resolveReturnAnchor = `  return {\n    ok: true,\n    action: "resolve",`;
        if (!source.includes(resolveReturnAnchor))
          throw new Error("notify resolve return anchor drift");
        source = source.replace(
          resolveReturnAnchor,
          `  return {
    ok: !deliveryFailed,
    ...(deliveryFailed ? { error: "desktop notification delivery failed" } : {}),
    action: "resolve",`,
        );

        fs.writeFileSync(file, commitDeliveryTruth(source));
      },
    },
  ];
}

function commitDeliveryTruth(source) {
  const edits = [
    [`      e.notified = true;
      e.lastNotifiedAt = now;
      const delivery = bubble(e, decision, String(a.message));
      if (!delivery.dryRun) e.deliveryFailed = !delivery.sent;`,
     `      const delivery = bubble(e, decision, String(a.message));
      if (!delivery.dryRun) e.deliveryFailed = !delivery.sent;
      if (delivery.sent || delivery.dryRun) {
        e.notified = true;
        e.lastNotifiedAt = now;
      } /* PI_NOTIFY_DELIVERY_COMMIT_V2 */`],
    [`      (policy.desktop === "always" || severity === "error" || severity === "critical")`,
     `      (policy.desktop === "always" || policy.desktop === "on-error" &&
        (severity === "error" || severity === "critical" || severity === "warning" && a.actionable))`],
    [`      if (decision.kind === "reminder") entry.lastReminderAt = now;
      else {
        entry.notified = true;
        entry.lastNotifiedAt = now;
      }
      const delivery = bubble(entry, decision);
      if (!delivery.dryRun) entry.deliveryFailed = !delivery.sent;`,
     `      const delivery = bubble(entry, decision);
      if (!delivery.dryRun) entry.deliveryFailed = !delivery.sent;
      if (delivery.sent || delivery.dryRun) {
        if (decision.kind === "reminder") entry.lastReminderAt = now;
        else {
          entry.notified = true;
          entry.lastNotifiedAt = now;
        }
      }`],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('notify delivery commit anchor drift');
    source = source.replace(before, after);
  }
  return source;
}
