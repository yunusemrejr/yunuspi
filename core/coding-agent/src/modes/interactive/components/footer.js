import { collectSessionCost, collectSessionMetrics, collectAuxiliaryModelUsage } from "../../../core/session-accounting.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sanitizeDisplayText, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@yunuspi/tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
const metricsView = Symbol.for("yunus-pi.metrics-view.v1");
/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text) {
    return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

function statusPriority(row) {
    if (["provider-gate", "autonomous-recovery", "model-output-limit", "model-catalog"].includes(row.key)
        || /^(?:⚠|✗|error\b|warning\b|blocked\b)/i.test(row.text)) return 0;
    return row.key === "worktree-checkpoint" ? 2 : 1;
}
function statusTone(row) {
    return /^(?:✗|error\b)/i.test(row.text) ? "error" : statusPriority(row) === 0 ? "warning" : "dim";
}

/** Wrap whole metrics at separators; do not cut a label from its value. */
function metricLines(parts, width) {
    const lines = [];
    let line = "";
    for (const part of parts.filter(Boolean)) {
        const next = line ? `${line} · ${part}` : part;
        if (line && visibleWidth(next) > width) {
            lines.push(...wrapTextWithAnsi(line, width));
            line = part;
        } else line = next;
    }
    if (line) lines.push(...wrapTextWithAnsi(line, width));
    return lines;
}

/** Main-model cache reuse since the last route change; missing is not zero. */
function cacheHit(entries, model) {
    let read = 0, total = 0;
    for (const entry of entries) {
        if (entry.type === "model_change") { read = 0; total = 0; continue; }
        const message = entry.type === "message" ? entry.message : undefined;
        if (message?.role !== "assistant") continue;
        if (message.provider !== model?.provider || message.model !== model?.id) { read = 0; total = 0; continue; }
        const usage = message.usage;
        const counters = [usage?.input, usage?.cacheRead, usage?.cacheWrite];
        if (!counters.every(value => Number.isFinite(value) && value >= 0)) continue;
        const reported = usage.cacheReadReported === true || (usage.cacheReadReported !== false && usage.cacheRead > 0);
        if (!reported) continue;
        read += usage.cacheRead;
        total += counters.reduce((sum, value) => sum + value, 0);
    }
    return total > 0 ? `${(100 * read / total).toFixed(1)}%` : "?";
}

/** Expanded totals retain pre-compaction history and side requests. */
function expandedUsage(entries) {
    const totals = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    const fields = Object.keys(totals);
    const auxiliary = collectAuxiliaryModelUsage(entries);
    for (const entry of entries) {
        if (auxiliary.coveredSummaries.has(entry)) continue;
        const usage = entry.type === "message" && ["assistant", "toolResult"].includes(entry.message.role)
            ? entry.message.usage : ["branch_summary", "compaction"].includes(entry.type) ? entry.usage : undefined;
        for (const field of fields) {
            const value = usage?.[field];
            if (Number.isFinite(value) && value >= 0) totals[field] += value;
        }
    }
    for (const row of auxiliary.rows) {
        for (const field of fields) totals[field] += row.usage[field] ?? 0;
    }
    return totals;
}
/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
export function formatCwdForFooter(cwd, home) {
    if (!home)
        return cwd;
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const isInsideHome = relativeToHome === "" ||
        (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
    if (!isInsideHome)
        return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export class FooterComponent {
    autoCompactEnabled = true;
    expanded = false;
    session;
    footerData;
    measurements;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }
    setSession(session) {
        this.session = session;
        this.measurements = undefined;
    }
    setAutoCompactEnabled(enabled) {
        this.autoCompactEnabled = enabled;
    }
    setExpanded(expanded) {
        this.expanded = expanded;
    }
    /**
     * No-op: git branch caching now handled by provider.
     * Kept for compatibility with existing call sites in interactive-mode.
     */
    invalidate() {
        // No-op: git branch is cached/invalidated by provider
    }
    /**
     * Clean up resources.
     * Git watcher cleanup now handled by provider.
     */
    dispose() {
        this.measurements = undefined;
    }
    readMeasurements(state) {
        const manager = this.session.sessionManager;
        const revision = manager.getEntriesRevision?.();
        const canCache = Number.isSafeInteger(revision);
        let snapshot = this.measurements;
        if (!canCache || snapshot?.manager !== manager || snapshot.revision !== revision) {
            snapshot = { manager, revision, entries: manager.getEntries(), name: manager.getSessionName() };
            this.measurements = canCache ? snapshot : undefined;
        }
        if (snapshot.costLabel === undefined) {
            snapshot.costLabel = collectSessionCost(snapshot.entries).formatted;
        }
        if (this.expanded && !snapshot.usageTotals) snapshot.usageTotals = expandedUsage(snapshot.entries);
        const live = globalThis[metricsView];
        const sessionId = manager.getSessionId?.();
        const versionedLive = typeof live?.revision === "function";
        const mark = versionedLive ? live.revision(sessionId) : undefined;
        // Older telemetry views return mutable snapshots with no version.
        if (!snapshot.metrics || snapshot.live !== live || snapshot.liveRevision !== mark || (live && !versionedLive)) {
            const { toolCalls, toolResults, agentsActive, workflowsActive, errors, modelErrors, agentFailures, workflowFailures, hookErrors, footer } =
                collectSessionMetrics(snapshot.entries, live?.(sessionId));
            snapshot.metrics = { toolCalls, toolResults, agentsActive, workflowsActive, errors, modelErrors, agentFailures, workflowFailures, hookErrors, footer };
            snapshot.live = live;
            snapshot.liveRevision = mark;
        }
        const leaf = manager.getLeafId?.();
        const { provider, id, contextWindow } = state.model ?? {};
        if (!snapshot.branch || snapshot.branch.leaf !== leaf || snapshot.branch.provider !== provider || snapshot.branch.id !== id) {
            snapshot.branch = { leaf, provider, id, cache: cacheHit(manager.getBranch(), state.model) };
        }
        const messages = state.messages;
        if (!messages || !snapshot.context || snapshot.context.leaf !== leaf || snapshot.context.provider !== provider
            || snapshot.context.id !== id || snapshot.context.window !== contextWindow
            || snapshot.context.messages !== messages || snapshot.context.length !== messages.length) {
            snapshot.context = { leaf, provider, id, window: contextWindow, messages, length: messages?.length, usage: this.session.getContextUsage() };
        }
        return snapshot;
    }
    render(width) {
        width = Math.max(1, Math.floor(width));
        const state = this.session.state;
        const snapshot = this.readMeasurements(state);
        const { metrics, usageTotals, costLabel } = snapshot;
        const contextUsage = snapshot.context.usage;
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = Number.isFinite(contextUsage?.percent) ? contextPercentValue.toFixed(1) : "?";
        const dim = text => theme.fg("dim", text);
        const lines = [];
        let location = sanitizeStatusText(formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE));
        const branch = sanitizeStatusText(this.footerData.getGitBranch());
        if (branch) location += ` (${branch})`;
        const sessionName = sanitizeStatusText(snapshot.name);
        if (sessionName) location += ` · ${sessionName}`;
        lines.push(dim(truncateToWidth(location, width, "…")));

        // Keep the selected model and effort visible even when KPI traffic grows.
        const modelName = sanitizeStatusText(state.model?.id || "no-model");
        const thinking = state.model?.reasoning ? sanitizeStatusText(state.thinkingLevel || "off") : "";
        let modelLabel = modelName;
        const provider = sanitizeStatusText(state.model?.provider);
        if (provider && (this.expanded || this.footerData.getAvailableProviderCount() > 1)
            && visibleWidth(`${provider}/${modelName}  ${thinking}`) <= width) modelLabel = `${provider}/${modelName}`;
        if (thinking && visibleWidth(thinking) + 2 < width) {
            modelLabel = truncateToWidth(modelLabel, width - visibleWidth(thinking) - 2, "…");
            lines.push(dim(modelLabel) + " ".repeat(width - visibleWidth(modelLabel) - visibleWidth(thinking)) + theme.fg("muted", thinking));
        } else lines.push(dim(truncateToWidth(modelLabel, width, "…")));

        const contextLabel = `Context ${contextPercent}${contextPercent === "?" ? "" : "%"}${width >= 60 || this.expanded ? `/${formatTokens(contextWindow)}` : ""}`;
        const contextTone = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim";
        const stats = [theme.fg(contextTone, contextLabel), dim(`Cache ${snapshot.branch.cache}`), dim(`${costLabel} total`)];
        if (areExperimentalFeaturesEnabled()) stats.push(theme.fg("warning", "xp"));
        lines.push(...metricLines(stats, width));

        if (this.expanded) {
            const tokens = [];
            if (usageTotals.input) tokens.push(`↑${formatTokens(usageTotals.input)}`);
            if (usageTotals.output) tokens.push(`↓${formatTokens(usageTotals.output)}`);
            if (usageTotals.cacheRead) tokens.push(`R${formatTokens(usageTotals.cacheRead)}`);
            if (usageTotals.cacheWrite) tokens.push(`W${formatTokens(usageTotals.cacheWrite)}`);
            lines.push(...metricLines([tokens.length ? `Tokens ${tokens.join(" · ")}` : "", `Auto compact ${this.autoCompactEnabled ? "on" : "off"}`], width).map(dim));
            lines.push(...metricLines(metrics.footer, width).map(dim));
            const sessionId = sanitizeStatusText(this.session.sessionManager.getSessionId?.());
            if (sessionId && !metrics.footer.some(part => part.startsWith("session "))) lines.push(dim(truncateToWidth(`Session ${sessionId.slice(0, 8)}`, width, "…")));
        } else {
            const activity = [`Tools ${metrics.toolCalls || metrics.toolResults}`];
            if (metrics.agentsActive) activity.push(`Agents ${metrics.agentsActive} active`);
            if (metrics.workflowsActive) activity.push(`Jobs ${metrics.workflowsActive} active`);
            const failures = metrics.errors + metrics.modelErrors + metrics.agentFailures + metrics.workflowFailures + metrics.hookErrors;
            if (failures) activity.push(theme.fg("warning", `Failures ${failures}`));
            activity.push("/metrics");
            lines.push(...metricLines(activity, width).map(text => dim(text)));
        }

        const statuses = Array.from(this.footerData.getExtensionStatuses().entries())
            .map(([key, text]) => ({key, text: sanitizeStatusText(text)})).filter(row => row.text);
        if (this.expanded) {
            for (const row of statuses.sort((a, b) => a.key.localeCompare(b.key))) lines.push(...wrapTextWithAnsi(row.text, width).map(text => theme.fg(statusTone(row), text)));
        } else {
            // Cumulative helper counters belong in expanded details. Active work
            // and warnings take precedence over completed checkpoint receipts.
            const visible = statuses.filter(row => row.key !== "02-harness-pulse").sort((a, b) => statusPriority(a) - statusPriority(b) || a.key.localeCompare(b.key));
            for (const [index, row] of visible.slice(0, 2).entries()) {
                const text = row.key === "model-catalog"
                    ? `Catalog ${row.text.includes("stale") ? "stale" : "warning"} · /catalog-status`
                    : row.text;
                const remaining = visible.length - 2;
                const suffix = index === 1 && remaining > 0 ? ` · +${remaining} ${keyText("app.tools.expand")}` : "";
                const preview = suffix && visibleWidth(suffix) < width
                    ? truncateToWidth(text, width - visibleWidth(suffix), "…") + suffix
                    : truncateToWidth(text, width, "…");
                lines.push(theme.fg(statusTone(row), preview));
            }
        }
        return lines;
    }
}
