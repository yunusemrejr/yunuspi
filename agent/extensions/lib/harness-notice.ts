/**
 * One consistent, terminal-safe look for harness notices in the transcript:
 * a coloured icon and title line, an optional body, and detail shown only when
 * the user expands tool output. All text is sanitized first so provider or
 * tool text cannot move the cursor or inject escape sequences.
 */
import { Text, sanitizeDisplayText } from "@yunuspi/tui";

export type NoticeTone = "accent" | "success" | "warning" | "error" | "muted";
export interface HarnessNotice { icon: string; title: string; tone?: NoticeTone; summary?: string; body?: string; detail?: string }

const paint = (theme: any, tone: string, text: string) => { try { return theme?.fg?.(tone, text) ?? text; } catch { return text; } };
const bold = (theme: any, text: string) => { try { return theme?.bold?.(text) ?? text; } catch { return text; } };

export function renderHarnessNotice(notice: HarnessNotice, options: { expanded?: boolean } = {}, theme?: any): Text {
	const clean = (value: string | undefined, max: number) => sanitizeDisplayText(value ?? "").trim().slice(0, max);
	const tone = notice.tone ?? "accent";
	const head = `${paint(theme, tone, clean(notice.icon, 4))} ${bold(theme, paint(theme, tone, clean(notice.title, 80)))}${notice.summary ? ` ${paint(theme, "dim", "·")} ${paint(theme, "muted", clean(notice.summary, 200))}` : ""}`;
	const lines = [head];
	const body = clean(notice.body, 4000);
	if (body) lines.push(...body.split("\n").map((line) => `  ${line}`));
	const detail = clean(notice.detail, 4000);
	if (detail && options.expanded) lines.push(...detail.split("\n").map((line) => `  ${paint(theme, "dim", line)}`));
	else if (detail) lines.push(`  ${paint(theme, "dim", "(expand tool output to see the full text sent to the agent)")}`);
	return new Text(lines.join("\n"), 0, 0);
}

export function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
}

/** Head-first bound for visible summaries: evidence text keeps its newest tail,
 * but a notice line must keep its beginning ("Returned advice in 84s", not
 * "rned advice in 84s"). */
export function displayText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
