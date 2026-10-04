import type { ExtensionAPI } from "@yunuspi/coding-agent";
import {
  collectContinuationLines,
  collectVerificationReceipts,
  composeNotice,
  stripNoticeFooters,
  type NoticeMemory,
} from "./lib/continuation-notice.ts";

/** Appends one short footer to a finished answer when work will resume the
 * session, or when the answer ends with verification still open. Sources stay
 * owned by their subsystems; this hook only composes the footer.
 *
 * Edge-triggered on what the reader was last shown: an unchanged continuation
 * or unchanged open-verification set is never repeated, a hand-off turn does
 * not report verification that the resumed work is about to produce, and the
 * memory resets with a fresh session so resumed work is announced once. The
 * footer is for the transcript reader: it is removed from every model request,
 * so the agent never reads it and cannot copy it into later answers. */
export default function continuationNoticeExtension(pi: ExtensionAPI): void {
  let memory: NoticeMemory = {};
  pi.on("session_start", () => {
    memory = {};
  });
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      const clean = stripNoticeFooters(message);
      if (clean !== message) changed = true;
      return clean;
    });
    return changed ? { messages } : undefined;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return undefined;
    // Only a finished answer ends the visible turn; tool-use/aborted/error imply
    // continuation already in flight or a failure the harness surfaces itself.
    if (message.stopReason !== "stop" && message.stopReason !== "length")
      return undefined;
    const composed = composeNotice({
      continuation: collectContinuationLines(undefined, ctx.sessionManager),
      pendingMessages: ctx.hasPendingMessages(),
      receipts: collectVerificationReceipts(4, ctx.sessionManager),
      memory,
    });
    memory = composed.memory;
    if (!composed.text) return undefined;
    let content: unknown;
    if (typeof message.content === "string")
      content = message.content + composed.text;
    else content = [...message.content, { type: "text", text: composed.text }];
    return { message: { ...message, content } } as { message: typeof message };
  });
}
