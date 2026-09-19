import type { ExtensionAPI } from "@yunuspi/coding-agent";
import {
  collectContinuationLines,
  continuationWarning,
} from "./lib/continuation-notice.ts";

/** Appends a bounded warning to a finished answer when registered sources
 * (background tasks, queued follow-ups) will continue this session afterwards.
 * Sources stay owned by their subsystems; this hook only composes the notice.
 * Edge-triggered: the same pending set with no new evidence warns once, not
 * on every finished answer. The key resets on a fresh session, so resumed or
 * still-pending work notifies exactly once per session. */
export default function continuationNoticeExtension(pi: ExtensionAPI): void {
  let lastKey: string | undefined;
  pi.on("session_start", () => {
    lastKey = undefined;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return undefined;
    // Only a finished answer ends the visible turn; tool-use/aborted/error imply
    // continuation already in flight or a failure the harness surfaces itself.
    if (message.stopReason !== "stop" && message.stopReason !== "length")
      return undefined;
    const pendingMessages = ctx.hasPendingMessages();
    const lines = collectContinuationLines();
    const key = JSON.stringify({ lines, pendingMessages });
    if (key === lastKey) return undefined;
    const warning = continuationWarning(lines, pendingMessages);
    if (!warning) return undefined;
    lastKey = key;
    let content: unknown;
    if (typeof message.content === "string")
      content = message.content + warning;
    else content = [...message.content, { type: "text", text: warning }];
    return { message: { ...message, content } } as { message: typeof message };
  });
}
