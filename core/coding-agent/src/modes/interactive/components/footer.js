import { collectSessionCost, collectSessionMetrics, collectAuxiliaryModelUsage } from "../../../core/session-accounting.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isFlatPlanProvider } from "@yunuspi/ai";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@yunuspi/tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.js";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.js";
import { theme } from "../theme/theme.js";
/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text) {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
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
    session;
    footerData;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }
    setSession(session) {
        this.session = session;
    }
    setAutoCompactEnabled(enabled) {
        this.autoCompactEnabled = enabled;
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
        // Git watcher cleanup handled by provider
    }
    render(width) {
        const state = this.session.state;
        // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
        const usageTotals = createUsageTotals();
        for (const entry of this.session.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                addUsageToTotals(usageTotals, entry.message.usage);
            }
            else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
                addUsageToTotals(usageTotals, entry.message.usage);
            }
            else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
                addUsageToTotals(usageTotals, entry.usage);
            }
        }
        for (const row of collectAuxiliaryModelUsage(this.session.sessionManager.getEntries()).rows) {
            for (const field of ['input','output','cacheRead','cacheWrite']) usageTotals[field] += row.usage[field] ?? 0;
        }
        // Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        const contextUsage = this.session.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = Number.isFinite(contextUsage?.percent) ? contextPercentValue.toFixed(1) : "?";
        // Replace home directory with ~
        let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        // Add git branch if available
        const branch = this.footerData.getGitBranch();
        if (branch) {
            pwd = `${pwd} (${branch})`;
        }
        // Add session name if set
        const sessionName = this.session.sessionManager.getSessionName();
        if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
        }
        // Build stats line
        const statsParts = [];
        if (usageTotals.input)
            statsParts.push(`↑${formatTokens(usageTotals.input)}`);
        if (usageTotals.output)
            statsParts.push(`↓${formatTokens(usageTotals.output)}`);
        if (usageTotals.cacheRead)
            statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
        if (usageTotals.cacheWrite)
            statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
        statsParts.push((function formatCacheHit(entries, model) {
  // Main agent only, token-weighted across its responses on the current model
  // since the last model change: one uncached turn no longer swings the KPI
  // and harness/auxiliary calls never enter it.
  let read = 0, total = 0;
  for (const entry of entries) {
    if (entry.type === 'model_change') { read = 0; total = 0; continue; }
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'assistant') continue;
    if (message.provider !== model?.provider || message.model !== model?.id) { read = 0; total = 0; continue; }
    const usage = message.usage;
    const counters = [usage?.input, usage?.cacheRead, usage?.cacheWrite];
    if (!counters.every(v => Number.isFinite(v) && v >= 0)) continue;
    // A normalized zero without raw telemetry does not establish a miss.
    const reported = usage.cacheReadReported === true || (usage.cacheReadReported !== false && usage.cacheRead > 0);
    if (!reported) continue;
    read += usage.cacheRead; total += counters.reduce((a,b) => a+b, 0);
  }
  return total > 0 ? `CH${(100 * read / total).toFixed(1)}%` : 'CH?';
})(this.session.sessionManager.getBranch(), this.session.state.model)); /* PI_CACHE_HIT_FOOTER_V1 */
        // Flat token/coding plans are subscription-backed despite API-key auth.
        const usingSubscription = state.model
            ? isFlatPlanProvider(state.model.provider) || this.session.modelRuntime.isUsingSubscription(state.model.provider)
            : false;
        statsParts.push(collectSessionCost(this.session.sessionManager.getEntries(), usingSubscription).formatted + " total");
        // Colorize context percentage based on usage
        let contextPercentStr;
        const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
        const contextPercentDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
        if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
        }
        else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
        }
        else {
            contextPercentStr = contextPercentDisplay;
        }
        statsParts.push(contextPercentStr);
        if (areExperimentalFeaturesEnabled()) {
            statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
        }
        let statsLeft = statsParts.sort((a,b)=>(a===contextPercentStr?0:a.startsWith("CH")?1:a.startsWith("$")||a==="sub"?2:3)-(b===contextPercentStr?0:b.startsWith("CH")?1:b.startsWith("$")||b==="sub"?2:3)).join(" ");
        // Add model name on the right side, plus thinking level if model supports it
        const modelName = state.model?.id || "no-model";
        let statsLeftWidth = visibleWidth(statsLeft);
        // If statsLeft is too wide, truncate it
        if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
        }
        // Calculate available space for padding (minimum 2 spaces between stats and model)
        const minPadding = 2;
        // Add thinking level indicator if model supports reasoning
        let rightSideWithoutProvider = modelName;
        if (state.model?.reasoning) {
            const thinkingLevel = state.thinkingLevel || "off";
            rightSideWithoutProvider =
                thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        // Prepend the provider in parentheses if there are multiple providers and there's enough room
        let rightSide = rightSideWithoutProvider;
        try { const sid = String(this.session.sessionManager.getSessionId()); if (sid && sid !== "undefined") rightSide += ` · ${sid.slice(0, 8)}`; } catch {}
        if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
            rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
                // Too wide, fall back
                rightSide = rightSideWithoutProvider;
            }
        }
        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine;
        if (totalNeeded <= width) {
            // Both fit - add padding to right-align model
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
        }
        else {
            // Need to truncate right side
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
                const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
                const truncatedRightWidth = visibleWidth(truncatedRight);
                const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
                statsLine = statsLeft + padding + truncatedRight;
            }
            else {
                // Not enough space for right side at all
                statsLine = statsLeft;
            }
        }
        // Apply dim to each part separately. statsLeft may contain color codes (for context %)
        // that end with a reset, which would clear an outer dim wrapper. So we dim the parts
        // before and after the colored section independently.
        const dimStatsLeft = theme.fg("dim", statsLeft);
        const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
        const dimRemainder = theme.fg("dim", remainder);
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
        const lines = [pwdLine, dimStatsLeft + dimRemainder];
        // Add extension statuses on a single line, sorted by key alphabetically
        const activityMetrics = collectSessionMetrics(this.session.sessionManager.getEntries(), globalThis[Symbol.for('yunus-pi.metrics-view.v1')]?.(this.session.sessionManager.getSessionId?.()));
let activityLine = '';
for (const part of activityMetrics.footer.flatMap(part => part.startsWith('Powers ') ? part.split(' · ') : [part])) {
  const next = activityLine ? activityLine + ' · ' + part : part;
  if (activityLine && visibleWidth(next) > width) { lines.push(theme.fg('dim', truncateToWidth(activityLine, width))); activityLine = part; }
  else activityLine = next;
}
if (activityLine) lines.push(theme.fg('dim', truncateToWidth(activityLine, width)));
/* PI_SESSION_ACTIVITY_V2 */ const extensionStatuses = this.footerData.getExtensionStatuses();
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            let statusLine = '';
            for (const part of sortedStatuses) {
                const next = statusLine ? `${statusLine} · ${part}` : part;
                if (statusLine && visibleWidth(next) > width) {
                    lines.push(...wrapTextWithAnsi(statusLine, width));
                    statusLine = part;
                } else statusLine = next;
            }
            if (statusLine) lines.push(...wrapTextWithAnsi(statusLine, width));
        }
        return lines;
    }
}
