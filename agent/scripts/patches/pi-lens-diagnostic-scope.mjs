// PI_LENS_DIAGNOSTIC_SCOPE: persistent, fail-closed patch of the local fork.
// Uses existing session facts, ignore/generated policy, delta ranges, freshness
// gates and guard.enabled. No command parsing or session/task classification.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIST = fileURLToPath(
  new URL("../../extensions/pi-lens/dist/index.js", import.meta.url),
);
export const edits = [];
function replace(oldText, newText) {
  edits.push({ oldText, newText });
}
export const helper = String.raw`// PI_LENS_DIAGNOSTIC_SCOPE
function lensWorkKey(filePath) {
  return "session.maintained." + normalizeMapKey(path100.resolve(filePath));
}
function lensFileIdentity(filePath) {
  try { const stat = fs79.statSync(filePath); return stat.dev + ":" + stat.ino; }
  catch { return "missing"; }
}
function lensWorkState(filePath, cwd) {
  const resolved = resolveRunnerPath(cwd, filePath);
  const state = sessionFacts?.getSessionFact(lensWorkKey(resolved));
  if (!state || !state.maintained || !fs79.existsSync(resolved)) return void 0;
  if (isExternalOrVendorFile(resolved, state.cwd) || isPathIgnoredByProject(resolved, state.cwd, false)) return void 0;
  if (detectFileRole(resolved, readFilePrefix(resolved)) === "generated") return void 0;
  if (state.identity !== lensFileIdentity(resolved) || state.hash !== getFileStateHash(resolved)) return void 0;
  return state;
}
function lensRecordWork(filePath, cwd, maintained, enforce) {
  const key = lensWorkKey(filePath);
  const hash = getFileStateHash(filePath);
  const identity = lensFileIdentity(filePath);
  const previous = sessionFacts.getSessionFact(key);
  if (previous?.hash === hash && previous.identity === identity && previous.maintained === maintained && previous.enforce === enforce) return previous;
  const state = { cwd, maintained, enforce, hash, identity, revision: (previous?.revision ?? 0) + 1 };
  sessionFacts.setSessionFact(key, state);
  return state;
}
function lensApplyEnforcement(diagnostic, ctx) {
  const state = !ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);
  const changedLine = ctx.modifiedRanges?.some((r) => (diagnostic.line ?? 1) >= r.start && (diagnostic.line ?? 1) <= r.end);
  const baseline = ctx.facts.getSessionFact("session.baseline." + ctx.filePath) ?? [];
  const preexisting = baseline.some((d) => lensDiagnosticKey(d) === lensDiagnosticKey(diagnostic));
  const eligible = state?.enforce === true && changedLine && !preexisting && diagnostic.severity === "error";
  return diagnostic.semantic === "blocking" && !eligible
    ? { ...diagnostic, semantic: "warning", enforcementReason: "diagnostic only; no applicable source-change gate" }
    : { ...diagnostic, enforcementReason: eligible ? "guard.enabled; error in maintained source change" : "advisory" };
}
function lensDiagnosticKey(d) {
  return [d.tool ?? "", d.rule ?? d.id ?? "", d.line ?? 1, d.column ?? 1, d.message ?? ""].join("\u0001");
}
function lensRoutineKey(d) {
  return [d.tool ?? "", d.rule ?? d.id ?? "", d.message ?? ""].join("\u0001");
}
function lensRoutineDiagnostics(visible, all, ctx, baseline) {
  if (ctx.analysisOnly) return { visible, preexisting: 0, outside: 0, advisory: 0 };
  const priorExact = new Set((baseline ?? []).map(lensDiagnosticKey));
  const priorRule = new Set((baseline ?? []).map(lensRoutineKey));
  const isPrior = d => priorExact.has(lensDiagnosticKey(d)) || priorRule.has(lensRoutineKey(d));
  const maintained = !!lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);
  const changed = d => maintained && ctx.modifiedRanges?.some(r => (d.line ?? 1) >= r.start && (d.line ?? 1) <= r.end);
  const preexisting = all.filter(d => isPrior(d)).length;
  const outside = all.filter(d => !isPrior(d) && !changed(d)).length;
  const current = visible.filter(d => !isPrior(d) && changed(d));
  return { visible: current, preexisting, outside, advisory: current.filter(d => d.severity !== "error" && d.semantic !== "fixed").length };
}
function lensCoverageState(ctx, rows) {
  if (ctx.analysisOnly || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;
  const napi = rows.find((r) => r.runnerId === "ast-grep-napi");
  const napiCovered = napi && !napi.failureKind && (napi.status === "succeeded" || (napi.status === "failed" && napi.diagnosticCount > 0));
  const states = rows.flatMap((r) => {
    const result = [];
    if (r.failureKind && r.failureKind !== "blocking_diagnostics") result.push(r.runnerId + ": " + r.failureKind);
    else if (r.status === "skipped" || r.status === "when_skipped") {
      if (r.skipReason && !["unsupported-language", "no-files-matched", "covered-by-lsp", "disabled"].includes(r.skipReason))
        result.push(r.runnerId + ": " + r.skipReason);
    }
    for (const id of r.unconfirmedServerIds ?? []) {
      if (id === "ast-grep" && napiCovered) continue;
      result.push(id + ": publication unconfirmed");
    }
    return result;
  });
  const signature = [...new Set(states)].sort().join("; ");
  const key = "session.coverage-state." + (ctx.projectRoot ?? ctx.cwd) + ":" + ctx.kind;
  const previous = ctx.facts.getSessionFact(key);
  ctx.facts.setSessionFact(key, signature);
  if (!signature || signature === previous || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;
  return { id: "scanner-health", filePath: ctx.filePath, tool: "pi-lens", rule: "scanner-health", severity: "info", semantic: "none",
    message: "Scanner status: " + signature + ". Informational, not a source repair gate; runner details are available on demand." };
}
`;
replace(
  "function createDispatchContext(filePath, cwd, pi, facts, blockingOnly, modifiedRanges, projectRoot, writeIndex, telemetryModel, telemetryProvider) {",
  helper +
    "\nfunction createDispatchContext(filePath, cwd, pi, facts, blockingOnly, modifiedRanges, projectRoot, writeIndex, telemetryModel, telemetryProvider) {",
);
replace(
  "    fileRole,\n    pi,",
  "    fileRole,\n    scopeHash: getFileStateHash(normalizedFilePath),\n    scopeIdentity: lensFileIdentity(normalizedFilePath),\n    pi,",
);
// Preserve provenance for ALL recovered command paths, not just opaque ones.
replace(
  '_mutationSourceOverride: isOpaque ? "opaque-script" : void 0',
  '_mutationSourceOverride: "opaque-script"',
);
replace(
  "  const receipt = runtime2.recordMutationToolReceipt;\n  const autofixMode =",
  String.raw`  // Disk discovery is not authorship. Git membership can establish maintenance,
  // while direct edit/write receipts protect new standalone files without Git.
  const synthetic = deps._mutationSourceOverride === "opaque-script";
  const tracked = synthetic ? await collectTrackedFiles(workspaceRoot) : void 0;
  const priorWork = sessionFacts.getSessionFact(lensWorkKey(filePath));
  const maintained = !synthetic || (priorWork ? priorWork.maintained : tracked?.has(normalizeMapKey(path164.resolve(filePath))) === true);
  lensRecordWork(filePath, workspaceRoot, maintained, getFlag("lens-guard") === true);
  if (!maintained || !lensWorkState(filePath, workspaceRoot)) {
    // Read-only analysis remains available for unknown shell-authored code and
    // external artifacts. Never enter autofix, turn tracking or repair caches.
    if (!isPathIgnoredByProject(filePath, workspaceRoot, false) && nodeFs11.existsSync(filePath)) {
      const { dispatchLintDetailed: analyze } = await loadDispatchIntegration();
      const { result: observation } = await analyze(filePath, workspaceRoot, { getFlag }, { projectRoot: workspaceRoot });
      const errors = observation.diagnostics.filter((d) => d.severity === "error");
      const observedKey = "session.artifact-observed." + filePath;
      const observedHash = getFileStateHash(filePath);
      if (errors.length && sessionFacts.getSessionFact(observedKey) !== observedHash) {
        sessionFacts.setSessionFact(observedKey, observedHash);
        return { content: [...event.content, { type: "text", text: "pi-lens artifact/opaque-write observation (ownership unconfirmed; raw bytes preserved; no repair obligation):" + formatDiagnostics(errors.slice(0, 3).map((d) => ({ ...d, fixSuggestion: void 0 })), "warning") }] };
      }
    }
    return;
  }
  const receipt = runtime2.recordMutationToolReceipt;
  const autofixMode =`,
);
replace(
  '  if (ctx.fileRole === "generated") {\n    return {',
  '  if (ctx.fileRole === "generated" && !ctx.analysisOnly) {\n    return {',
);
replace(
  "  const dedupedDiagnostics = dedupeOverlappingDiagnostics(allDiagnostics);",
  String.raw`  // A late result may not attach to renamed/replaced/reclassified bytes.
  const current = ctx.scopeIdentity === lensFileIdentity(ctx.filePath) && ctx.scopeHash === getFileStateHash(ctx.filePath);
  const dedupedDiagnostics = current ? dedupeOverlappingDiagnostics(allDiagnostics).map((d) => lensApplyEnforcement(d, ctx)) : [];`,
);
replace(
  "    visibleDiagnostics = promoteDeltaUnusedToBlockers(filtered.new);",
  "    visibleDiagnostics = filtered.new; // Severity and enforcement are independent.",
);
replace(
  "  const coverageNotice = buildCoverageNotice(ctx, runnerLatencies);",
  "  const coverageNotice = lensCoverageState(ctx, runnerLatencies);",
);
replace(
  '  let output = blockerOutput;\n  output += formatDiagnostics(inlineFixed, "fixed");',
  '  let output = blockerOutput;\n  if (!ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.cwd)) output += formatDiagnostics(warnings.filter((d) => d.severity === "error"), "warning");\n  if (routineScope.preexisting || routineScope.outside || routineScope.advisory) output += `\\npi-lens: ${routineScope.preexisting} unchanged baseline, ${routineScope.outside} outside verified changed lines, ${routineScope.advisory} advisory diagnostic(s); details available with lens_diagnostics.\\n`;\n  output += formatDiagnostics(inlineFixed, "fixed");',
);
replace(
  '  const warnings = visibleDiagnostics.filter((d) => d.semantic === "warning" || d.semantic === "none");',
  '  const routineScope = lensRoutineDiagnostics(visibleDiagnostics, applyOutputFilters(dedupedDiagnostics), ctx, previousBaseline);\n  visibleDiagnostics = routineScope.visible;\n  const warnings = visibleDiagnostics.filter((d) => d.semantic === "warning" || d.semantic === "none");',
);
replace(
  '    output += formatDiagnostics([coverageNotice], "warning", 1);',
  '    output += "\\nℹ " + coverageNotice.message + "\\n";',
);
replace(
  "    warnings.push(coverageNotice);",
  "    // Health is edge-triggered output, never cached as a repair finding.",
);
replace(
  `  const pendingRunners = runnerLatencies.filter((runner) => runner.status === "pending").map((runner) => runner.runnerId);
  if (pendingRunners.length > 0) {
    output += \`
\\u23F3 Pending runners (reported at turn end): \${pendingRunners.join(", ")}
\`;
  }`,
  "  // Pending runner status remains available in latency reports, not routine output.",
);
replace(
  "      diagnosticCount: result.diagnostics.length,\n      semantic: result.semantic ?? semantic,\n      ...skipReason",
  "      diagnosticCount: result.diagnostics.length,\n      failureKind: result.failureKind,\n      failureMessage: result.failureMessage,\n      semantic: result.semantic ?? semantic,\n      ...skipReason",
);
replace(
  `        const sgModule = await loadSg();
        if (!sgModule) {
          return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `        const sgModule = await loadSg();
        if (!sgModule) {
          return { status: "skipped", skipReason: "unavailable", diagnostics: [], semantic: "none" };`,
);
replace(
  `        const lang = getLang(ctx.filePath, sgModule);
        if (!lang) {
          return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `        const lang = getLang(ctx.filePath, sgModule);
        if (!lang) {
          return { status: "skipped", skipReason: "unsupported-language", diagnostics: [], semantic: "none" };`,
);
replace(
  `        if (!canHandle(ctx.filePath)) {
          return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `        if (!canHandle(ctx.filePath)) {
          return { status: "skipped", skipReason: "unsupported-language", diagnostics: [], semantic: "none" };`,
);
replace(
  `        if (!fs81.existsSync(ctx.filePath)) {
          return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `        if (!fs81.existsSync(ctx.filePath)) {
          return { status: "skipped", skipReason: "missing-file", diagnostics: [], semantic: "none" };`,
);
replace(
  `          stats = fs81.statSync(ctx.filePath);
        } catch {
          return { status: "skipped", diagnostics: [], semantic: "none" };
        }
        if (stats.size > 1024 * 1024) {
          return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `          stats = fs81.statSync(ctx.filePath);
        } catch (error) {
          throw error;
        }
        if (stats.size > 1024 * 1024) {
          return { status: "skipped", skipReason: "size-limit", diagnostics: [], semantic: "none" };`,
);
replace(
  `            content = fs81.readFileSync(ctx.filePath, "utf-8");
          } catch {
            return { status: "skipped", diagnostics: [], semantic: "none" };`,
  `            content = fs81.readFileSync(ctx.filePath, "utf-8");
          } catch (error) {
            throw error;`,
);
replace(
  `        let root;
        try {
          root = lang.parse(content);
        } catch {
          return { status: "skipped", diagnostics: [], semantic: "none" };
        }
        let rootNode;
        try {
          rootNode = root.root();
        } catch {
          return { status: "skipped", diagnostics: [], semantic: "none" };
        }`,
  `        const root = lang.parse(content);
        const rootNode = root.root();`,
);
replace(
  `          return { status: "skipped", diagnostics: [], semantic: "none" };
        }
        const sgModule = await loadSg();`,
  `          return { status: "skipped", skipReason: "covered-by-lsp", diagnostics: [], semantic: "none" };
        }
        const sgModule = await loadSg();`,
);
replace(
  '    RUNNER_SKIP_REASONS = ["no-files-matched"];',
  '    RUNNER_SKIP_REASONS = ["no-files-matched", "unsupported-language", "unavailable", "missing-file", "size-limit", "covered-by-lsp", "disabled"];',
);
replace(
  "  const ctx = createDispatchContext(filePath, cwd, pi, sessionFacts, options?.blockingOnly ?? false, options?.modifiedRanges, options?.projectRoot);",
  "  const ctx = createDispatchContext(filePath, cwd, pi, sessionFacts, options?.blockingOnly ?? false, options?.modifiedRanges, options?.projectRoot);\n  ctx.analysisOnly = true;\n  ctx.deltaMode = false;",
);
// Only the shared automatic/cached reporting gate is scoped. Fresh explicit
// LSP/AST/full scans retain raw findings and never register maintained work.
replace(
  "    const cited = args.citedPath(finding);\n    if (!cited) {",
  String.raw`    const cited = args.citedPath(finding);
    if (cited && !lensWorkState(resolveRunnerPath(args.cwd, cited), args.cwd)) {
      dropped.push(finding);
      continue;
    }
    if (!cited) {`,
);
replace(
  "  const files2 = Object.keys(turnState.files);",
  "  const files2 = Object.keys(turnState.files).filter((file) => lensWorkState(resolveRunnerPath(cwd, file), cwd));",
);
replace(
  "async function runAutofix(filePath, cwd, getFlag, dbg2, deps, getFlagSource) {",
  'async function runAutofix(filePath, cwd, getFlag, dbg2, deps, getFlagSource) {\n  if (!lensWorkState(filePath, cwd)) return { fixedCount: 0, autofixTools: [], attemptedTools: [], changedFiles: [], needsContentRefresh: false, skipReason: "unmaintained" };',
);
replace(
  "async function runFormatPhase(filePath, getFormatService2, dbg2) {",
  "async function runFormatPhase(filePath, getFormatService2, dbg2) {\n  if (!lensWorkState(filePath, path152.dirname(filePath))) return { formatChanged: false, formattersUsed: [], formatFailures: [], fileContent: void 0 };",
);
// Replace coercion rather than manipulating tool isError. Actual commit blocking
// remains exclusively in the existing opt-in lens-guard implementation.
replace(
  "${emoji} STOP \\u2014 ${diagnostics.length} issue(s) must be fixed:",
  "${emoji} Source gate (guard.enabled): ${diagnostics.length} error(s) in maintained changes:",
);
replace(
  "\\u{1F534} STOP \\u2014 ${blockers.length} issue(s) must be fixed:",
  "\\u{1F534} Source gate (guard.enabled): ${blockers.length} error(s) in maintained changes:",
);
replace(
  "  return `  ${line}${indented}${fix}`;",
  '  return `  ${d.filePath ?? ""}:${line}[${d.severity ?? "warning"} ${d.rule ?? d.id ?? d.tool}] ${indented}${fix}`;',
);
replace(
  "    out += `  L${lineNo}: ${d.message}${nodeCtx}",
  "    out += `  ${d.filePath}:${lineNo} [${d.severity} ${d.rule ?? d.id ?? d.tool}] ${d.message}${nodeCtx}",
);
replace(
  "Address \\u{1F534} blockers before continuing; \\u2139\\uFE0F advisories are informational only.",
  "Diagnostics for maintained changes. Only an applicable configured gate blocks commit/push; advisories do not require cleanup.",
);
replace(
  "Test failures detected last turn \\u2014 fix before continuing:",
  "Test failures observed last turn (informational; not an unconditional continuation gate):",
);
replace(
  "automated checks run on every edit/write; blocking errors (including pre-existing) show inline and must be fixed.",
  "authored source changes are checked; disk discoveries are read-only observations. Severity alone does not impose a repair gate.",
);
replace(
  '  const isFullMode = detailOverrides.mode === "full";\n  const ignoreFile',
  `  const isFullMode = detailOverrides.mode === "full";
  summaries = summaries.filter((s) => isFullMode || lensWorkState(s.filePath, cwd)).map((s) => {
    const diagnostics = (s.diagnostics ?? []).map((d) => {
      const state = !isFullMode && lensWorkState(s.filePath, cwd);
      return d.semantic === "blocking" && !state?.enforce ? { ...d, semantic: "warning" } : d;
    });
    return summarizeDiagnostics(s.filePath, diagnostics, s.hasFinalSnapshot);
  });
  const ignoreFile`,
);
// Gate B records coverage only AFTER evaluation succeeds, including zero matches.
replace(
  `        if (astGrepLspEnabled && !astGrepLspPublished) {
          recordNapiFallbackCoverage(ctx.filePath);
          clearPendingAuxiliaryCoverage(ctx.filePath, "ast-grep");
        }
        const diagnostics = evaluateAstGrepRules`,
  `        const diagnostics = evaluateAstGrepRules`,
);
replace(
  `        const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
        let semantic = "none";`,
  `        if (astGrepLspEnabled && !astGrepLspPublished) {
          recordNapiFallbackCoverage(ctx.filePath);
          clearPendingAuxiliaryCoverage(ctx.filePath, "ast-grep");
        }
        const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
        let semantic = "none";`,
);
replace(
  "  const visibleSummaries = eofGated.filter((s) => includeFile(s.filePath));",
  "  const visibleSummaries = eofGated.filter((s) => (isFullMode && pathsScope ? pathsScope.includeFile(s.filePath) : includeFile(s.filePath)));",
);
replace(
  "  if (!findings?.data?.content || findings.data.consumed === true)\n    return;",
  `  if (!findings?.data?.content || findings.data.consumed === true) return;
  if (!findings.data.scopeVersion || !(findings.data.affectedFiles ?? []).every((file) => lensWorkState(file, cwd))) {
    cacheManager.clearCache("turn-end-findings", cwd);
    return;
  }`,
);
replace(
  '      cacheManager.writeCache("turn-end-findings", {\n        content,',
  '      cacheManager.writeCache("turn-end-findings", {\n        scopeVersion: 1,\n        content,',
);
replace(
  "        blockerContent: blockingContent,",
  "        scopeVersion: 1,\n        blockerContent: blockingContent,",
);
replace(
  '    let report = "\\u{1F534} STOP \\u2014 hardcoded secrets detected. Rotate the credentials and remove them from source:\\n";',
  '    let report = "Security findings in maintained changes (verify exposure before remediation):\\n";',
);
replace(
  "    blockerParts.push(report);\n  }\n  if (staleSecrets.length)",
  '    (getFlag("lens-guard") ? blockerParts : advisoryParts).push(report);\n  }\n  if (staleSecrets.length)',
);
replace(
  "\\u{1F534} STOP \\u2014 CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}). Upgrade before shipping:",
  "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}); cached dependency advisory, not a source-change gate:",
);
replace(
  "      blockerParts.push(report);\n    }\n    if (advisory.length)",
  "      advisoryParts.push(report);\n    }\n    if (advisory.length)",
);
replace(
  "function evaluateGitGuard(runtime2, cacheManager, cwd) {\n  if (runtime2.gitGuardHasBlockers)",
  `function evaluateGitGuard(runtime2, cacheManager, cwd) {
  const sourceEntries = (runtime2.getInlineBlockersSnapshot?.() ?? []).filter((entry) => lensWorkState(entry.filePath, cwd)?.enforce);
  const stored = cacheManager.readCache("turn-end-findings", cwd)?.data;
  const cachedPaths = stored?.blockingFiles ?? [];
  const currentCache = stored?.scopeVersion === 1 && cachedPaths.length > 0 && cachedPaths.every((file) => lensWorkState(file, cwd)?.enforce);
  if (!currentCache && stored?.hasBlockers) cacheManager.clearCache("turn-end-findings", cwd);
  if (sourceEntries.length === 0 && !currentCache) {
    runtime2.updateGitGuardStatus(false, "");
    runtime2.clearGitGuardCacheUnknown();
    return { block: false };
  }
  if (runtime2.gitGuardHasBlockers)`,
);
replace(
  "    ...record2,\n    affectedFiles: capped.files,",
  "    ...record2,\n    scopeVersion: 1,\n    affectedFiles: capped.files,",
);
replace(
  'function publishFilesTouched(args) {\n  if (args.origin === "bus")',
  `function publishFilesTouched(args) {
  if (args.origin !== "bus") {
    for (const file of args.paths) {
      const state = sessionFacts?.getSessionFact(lensWorkKey(resolveRunnerPath(args.cwd, file)));
      if (state?.maintained) lensRecordWork(resolveRunnerPath(args.cwd, file), state.cwd, true, state.enforce);
    }
  }
  if (args.origin === "bus")`,
);
replace(
  '  const blockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");',
  '  const blockers = applyOutputFilters(dedupedDiagnostics).filter((d) => d.semantic === "blocking");',
);
replace(
  "  const inlineBlockers = blockers;",
  '  const inlineBlockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");',
);
replace(
  "    diagnostics: visibleDiagnostics,\n    blockers,",
  "    diagnostics: applyOutputFilters(dedupedDiagnostics),\n    reportedBlockers: inlineBlockers,\n    blockers,",
);
replace(
  "    findings: dispatchResult.blockers,",
  "    findings: dispatchResult.reportedBlockers ?? dispatchResult.blockers,",
);
replace(
  "  for (const pending3 of pendingRunnerFindings) {\n    const result = pending3.result;",
  "  for (const pending3 of pendingRunnerFindings) {\n    if (!lensWorkState(pending3.filePath, cwd)) continue;\n    const result = pending3.result;",
);
replace(
  '    if (result.status === "failed") {\n      runnerFindingsFailed += 1;',
  "    if (result.failureKind) {\n      runnerFindingsFailed += 1;",
);
replace(
  "      for (const [lateAuxPath, pairs] of byFile) {\n        let cached;",
  "      for (const [lateAuxPath, pairs] of byFile) {\n        if (!lensWorkState(lateAuxPath, cwd)) continue;\n        let cached;",
);
// Exact known V1 payload upgrades; every other existing patch postcondition remains mandatory.
const priorPayloadUpgrades = [
  {
    oldText:
      '// PI_LENS_DIAGNOSTIC_SCOPE\nfunction lensWorkKey(filePath) {\n  return "session.maintained." + normalizeMapKey(path100.resolve(filePath));\n}\nfunction lensFileIdentity(filePath) {\n  try { const stat = fs79.statSync(filePath); return stat.dev + ":" + stat.ino; }\n  catch { return "missing"; }\n}\nfunction lensWorkState(filePath, cwd) {\n  const resolved = resolveRunnerPath(cwd, filePath);\n  const state = sessionFacts?.getSessionFact(lensWorkKey(resolved));\n  if (!state || !state.maintained || !fs79.existsSync(resolved)) return void 0;\n  if (isExternalOrVendorFile(resolved, state.cwd) || isPathIgnoredByProject(resolved, state.cwd, false)) return void 0;\n  if (detectFileRole(resolved, readFilePrefix(resolved)) === "generated") return void 0;\n  if (state.identity !== lensFileIdentity(resolved) || state.hash !== getFileStateHash(resolved)) return void 0;\n  return state;\n}\nfunction lensRecordWork(filePath, cwd, maintained, enforce) {\n  const key = lensWorkKey(filePath);\n  const hash = getFileStateHash(filePath);\n  const identity = lensFileIdentity(filePath);\n  const previous = sessionFacts.getSessionFact(key);\n  if (previous?.hash === hash && previous.identity === identity && previous.maintained === maintained && previous.enforce === enforce) return previous;\n  const state = { cwd, maintained, enforce, hash, identity, revision: (previous?.revision ?? 0) + 1 };\n  sessionFacts.setSessionFact(key, state);\n  return state;\n}\nfunction lensApplyEnforcement(diagnostic, ctx) {\n  const state = !ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);\n  const changedLine = ctx.modifiedRanges?.some((r) => (diagnostic.line ?? 1) >= r.start && (diagnostic.line ?? 1) <= r.end);\n  const eligible = state?.enforce === true && changedLine && diagnostic.severity === "error";\n  return diagnostic.semantic === "blocking" && !eligible\n    ? { ...diagnostic, semantic: "warning", enforcementReason: "diagnostic only; no applicable source-change gate" }\n    : { ...diagnostic, enforcementReason: eligible ? "guard.enabled; error in maintained source change" : "advisory" };\n}\nfunction lensCoverageState(ctx, rows) {\n  if (ctx.analysisOnly || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;\n  const napi = rows.find((r) => r.runnerId === "ast-grep-napi");\n  const napiCovered = napi && !napi.failureKind && (napi.status === "succeeded" || (napi.status === "failed" && napi.diagnosticCount > 0));\n  const states = rows.flatMap((r) => {\n    const result = [];\n    if (r.failureKind) result.push(r.runnerId + ": " + r.failureKind);\n    else if (r.status === "skipped" || r.status === "when_skipped") {\n      if (r.skipReason && !["unsupported-language", "no-files-matched", "covered-by-lsp", "disabled"].includes(r.skipReason))\n        result.push(r.runnerId + ": " + r.skipReason);\n    }\n    for (const id of r.unconfirmedServerIds ?? []) {\n      if (id === "ast-grep" && napiCovered) continue;\n      result.push(id + ": publication unconfirmed");\n    }\n    return result;\n  });\n  const signature = [...new Set(states)].sort().join("; ");\n  const key = "session.coverage-state." + (ctx.projectRoot ?? ctx.cwd) + ":" + ctx.kind;\n  const previous = ctx.facts.getSessionFact(key);\n  ctx.facts.setSessionFact(key, signature);\n  if (!signature || signature === previous || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;\n  return { id: "scanner-health", filePath: ctx.filePath, tool: "pi-lens", rule: "scanner-health", severity: "warning", semantic: "warning",\n    message: "Scanner status: " + signature + ". Informational, not a source repair gate; runner details are available on demand." };\n}\n\nfunction createDispatchContext(filePath, cwd, pi, facts, blockingOnly, modifiedRanges, projectRoot, writeIndex, telemetryModel, telemetryProvider) {',
    newText:
      '// PI_LENS_DIAGNOSTIC_SCOPE\nfunction lensWorkKey(filePath) {\n  return "session.maintained." + normalizeMapKey(path100.resolve(filePath));\n}\nfunction lensFileIdentity(filePath) {\n  try { const stat = fs79.statSync(filePath); return stat.dev + ":" + stat.ino; }\n  catch { return "missing"; }\n}\nfunction lensWorkState(filePath, cwd) {\n  const resolved = resolveRunnerPath(cwd, filePath);\n  const state = sessionFacts?.getSessionFact(lensWorkKey(resolved));\n  if (!state || !state.maintained || !fs79.existsSync(resolved)) return void 0;\n  if (isExternalOrVendorFile(resolved, state.cwd) || isPathIgnoredByProject(resolved, state.cwd, false)) return void 0;\n  if (detectFileRole(resolved, readFilePrefix(resolved)) === "generated") return void 0;\n  if (state.identity !== lensFileIdentity(resolved) || state.hash !== getFileStateHash(resolved)) return void 0;\n  return state;\n}\nfunction lensRecordWork(filePath, cwd, maintained, enforce) {\n  const key = lensWorkKey(filePath);\n  const hash = getFileStateHash(filePath);\n  const identity = lensFileIdentity(filePath);\n  const previous = sessionFacts.getSessionFact(key);\n  if (previous?.hash === hash && previous.identity === identity && previous.maintained === maintained && previous.enforce === enforce) return previous;\n  const state = { cwd, maintained, enforce, hash, identity, revision: (previous?.revision ?? 0) + 1 };\n  sessionFacts.setSessionFact(key, state);\n  return state;\n}\nfunction lensApplyEnforcement(diagnostic, ctx) {\n  const state = !ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);\n  const changedLine = ctx.modifiedRanges?.some((r) => (diagnostic.line ?? 1) >= r.start && (diagnostic.line ?? 1) <= r.end);\n  const baseline = ctx.facts.getSessionFact("session.baseline." + ctx.filePath) ?? [];\n  const preexisting = baseline.some((d) => lensDiagnosticKey(d) === lensDiagnosticKey(diagnostic));\n  const eligible = state?.enforce === true && changedLine && !preexisting && diagnostic.severity === "error";\n  return diagnostic.semantic === "blocking" && !eligible\n    ? { ...diagnostic, semantic: "warning", enforcementReason: "diagnostic only; no applicable source-change gate" }\n    : { ...diagnostic, enforcementReason: eligible ? "guard.enabled; error in maintained source change" : "advisory" };\n}\nfunction lensDiagnosticKey(d) {\n  return [d.tool ?? "", d.rule ?? d.id ?? "", d.line ?? 1, d.column ?? 1, d.message ?? ""].join("\\u0001");\n}\nfunction lensRoutineDiagnostics(visible, all, ctx, baseline) {\n  if (ctx.analysisOnly) return { visible, preexisting: 0, outside: 0, advisory: 0 };\n  const prior = new Set((baseline ?? []).map(lensDiagnosticKey));\n  const maintained = !!lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);\n  const changed = d => maintained && ctx.modifiedRanges?.some(r => (d.line ?? 1) >= r.start && (d.line ?? 1) <= r.end);\n  const preexisting = all.filter(d => prior.has(lensDiagnosticKey(d))).length;\n  const outside = all.filter(d => !prior.has(lensDiagnosticKey(d)) && !changed(d)).length;\n  const current = visible.filter(d => !prior.has(lensDiagnosticKey(d)) && changed(d));\n  return { visible: current, preexisting, outside, advisory: current.filter(d => d.severity !== "error" && d.semantic !== "fixed").length };\n}\nfunction lensCoverageState(ctx, rows) {\n  if (ctx.analysisOnly || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;\n  const napi = rows.find((r) => r.runnerId === "ast-grep-napi");\n  const napiCovered = napi && !napi.failureKind && (napi.status === "succeeded" || (napi.status === "failed" && napi.diagnosticCount > 0));\n  const states = rows.flatMap((r) => {\n    const result = [];\n    if (r.failureKind && r.failureKind !== "blocking_diagnostics") result.push(r.runnerId + ": " + r.failureKind);\n    else if (r.status === "skipped" || r.status === "when_skipped") {\n      if (r.skipReason && !["unsupported-language", "no-files-matched", "covered-by-lsp", "disabled"].includes(r.skipReason))\n        result.push(r.runnerId + ": " + r.skipReason);\n    }\n    for (const id of r.unconfirmedServerIds ?? []) {\n      if (id === "ast-grep" && napiCovered) continue;\n      result.push(id + ": publication unconfirmed");\n    }\n    return result;\n  });\n  const signature = [...new Set(states)].sort().join("; ");\n  const key = "session.coverage-state." + (ctx.projectRoot ?? ctx.cwd) + ":" + ctx.kind;\n  const previous = ctx.facts.getSessionFact(key);\n  ctx.facts.setSessionFact(key, signature);\n  if (!signature || signature === previous || !lensWorkState(ctx.filePath, ctx.cwd)) return void 0;\n  return { id: "scanner-health", filePath: ctx.filePath, tool: "pi-lens", rule: "scanner-health", severity: "info", semantic: "none",\n    message: "Scanner status: " + signature + ". Informational, not a source repair gate; runner details are available on demand." };\n}\n\nfunction createDispatchContext(filePath, cwd, pi, facts, blockingOnly, modifiedRanges, projectRoot, writeIndex, telemetryModel, telemetryProvider) {',
  },
  {
    oldText:
      '  let output = blockerOutput;\n  if (!ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.cwd)) output += formatDiagnostics(warnings.filter((d) => d.severity === "error"), "warning");\n  output += formatDiagnostics(inlineFixed, "fixed");',
    newText:
      '  let output = blockerOutput;\n  if (!ctx.analysisOnly && lensWorkState(ctx.filePath, ctx.cwd)) output += formatDiagnostics(warnings.filter((d) => d.severity === "error"), "warning");\n  if (routineScope.preexisting || routineScope.outside || routineScope.advisory) output += `\\npi-lens: ${routineScope.preexisting} unchanged baseline, ${routineScope.outside} outside verified changed lines, ${routineScope.advisory} advisory diagnostic(s); details available with lens_diagnostics.\\n`;\n  output += formatDiagnostics(inlineFixed, "fixed");',
  },
  {
    oldText:
      '  const warnings = visibleDiagnostics.filter((d) => d.semantic === "warning" || d.semantic === "none");',
    newText:
      '  const routineScope = lensRoutineDiagnostics(visibleDiagnostics, applyOutputFilters(dedupedDiagnostics), ctx, previousBaseline);\n  visibleDiagnostics = routineScope.visible;\n  const warnings = visibleDiagnostics.filter((d) => d.semantic === "warning" || d.semantic === "none");',
  },
  {
    oldText: '    output += formatDiagnostics([coverageNotice], "warning", 1);',
    newText: '    output += "\\nℹ " + coverageNotice.message + "\\n";',
  },
  {
    oldText:
      'function lensRoutineDiagnostics(visible, all, ctx, baseline) {\n  if (ctx.analysisOnly) return { visible, preexisting: 0, outside: 0, advisory: 0 };\n  const prior = new Set((baseline ?? []).map(lensDiagnosticKey));\n  const maintained = !!lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);\n  const changed = d => maintained && ctx.modifiedRanges?.some(r => (d.line ?? 1) >= r.start && (d.line ?? 1) <= r.end);\n  const preexisting = all.filter(d => prior.has(lensDiagnosticKey(d))).length;\n  const outside = all.filter(d => !prior.has(lensDiagnosticKey(d)) && !changed(d)).length;\n  const current = visible.filter(d => !prior.has(lensDiagnosticKey(d)) && changed(d));\n  return { visible: current, preexisting, outside, advisory: current.filter(d => d.severity !== "error" && d.semantic !== "fixed").length };\n}',
    newText:
      'function lensRoutineKey(d) {\n  return [d.tool ?? "", d.rule ?? d.id ?? "", d.message ?? ""].join("\\u0001");\n}\nfunction lensRoutineDiagnostics(visible, all, ctx, baseline) {\n  if (ctx.analysisOnly) return { visible, preexisting: 0, outside: 0, advisory: 0 };\n  const priorExact = new Set((baseline ?? []).map(lensDiagnosticKey));\n  const priorRule = new Set((baseline ?? []).map(lensRoutineKey));\n  const isPrior = d => priorExact.has(lensDiagnosticKey(d)) || priorRule.has(lensRoutineKey(d));\n  const maintained = !!lensWorkState(ctx.filePath, ctx.projectRoot ?? ctx.cwd);\n  const changed = d => maintained && ctx.modifiedRanges?.some(r => (d.line ?? 1) >= r.start && (d.line ?? 1) <= r.end);\n  const preexisting = all.filter(d => isPrior(d)).length;\n  const outside = all.filter(d => !isPrior(d) && !changed(d)).length;\n  const current = visible.filter(d => !isPrior(d) && changed(d));\n  return { visible: current, preexisting, outside, advisory: current.filter(d => d.severity !== "error" && d.semantic !== "fixed").length };\n}',
  },
];
export function upgradeSource(source) {
  let result = source;
  for (const { oldText, newText } of priorPayloadUpgrades) {
    if (result.split(newText).length === 2) continue;
    if (result.split(oldText).length !== 2)
      throw Error("Lens scope upgrade payload drift");
    result = result.replace(oldText, () => newText);
  }
  if (!edits.filter((e) => e.oldText).every((e) => result.includes(e.newText)))
    throw Error("Lens scope upgrade postcondition drift");
  return result;
}
export function applySource(source) {
  let result = source;
  for (const { oldText, newText } of edits) {
    if (!oldText) continue;
    const count = result.split(oldText).length - 1;
    if (count !== 1)
      throw new Error(
        `pi-lens scope anchor count ${count}: ${oldText.slice(0, 100)}`,
      );
    result = result.replace(oldText, () => newText);
  }
  return result;
}
export function targets(dist = DIST) {
  return [
    {
      name: "pi-lens diagnostic source scope",
      exists: () => fs.existsSync(dist),
      isApplied: () => {
        const s = fs.readFileSync(dist, "utf8");
        return edits
          .filter((e) => e.oldText)
          .every((e) => s.includes(e.newText));
      },
      apply: () => {
        const s = fs.readFileSync(dist, "utf8");
        if (!s.includes("// PI_LENS_DIAGNOSTIC_SCOPE"))
          fs.writeFileSync(dist, applySource(s));
        else if (!targets(dist)[0].isApplied())
          fs.writeFileSync(dist, upgradeSource(s));
      },
    },
  ];
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const t = targets()[0];
  if (process.argv.includes("--fix")) t.apply();
  if (!t.isApplied()) throw new Error("pi-lens scope patch not applied");
  console.log("pi-lens diagnostic scope: applied");
}
