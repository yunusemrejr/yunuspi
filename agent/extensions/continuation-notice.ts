import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectContinuationLines,
  continuationWarning,
} from "./lib/continuation-notice.ts";

/** Appends a bounded warning to a finished answer when registered sources
 * (background tasks, queued follow-ups) will continue this session afterwards.
 * Sources stay owned by their subsystems; this hook only composes the notice. */
export default function continuationNoticeExtension(pi: ExtensionAPI): void {
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return undefined;
    // Only a finished answer ends the visible turn; tool-use/aborted/error imply
    // continuation already in flight or a failure the harness surfaces itself.
    if (message.stopReason !== "stop" && message.stopReason !== "length")
      return undefined;
    const warning = continuationWarning(
      collectContinuationLines(),
      ctx.hasPendingMessages(),
    );
    if (!warning) return undefined;
    let content: unknown;
    if (typeof message.content === "string")
      content = message.content + warning;
    else content = [...message.content, { type: "text", text: warning }];
    return { message: { ...message, content } } as { message: typeof message };
  });
}
