/**
 * Timeout Guard — bounded bash execution.
 *
 * The bash tool accepts an optional `timeout` (seconds) and runs with NO
 * default timeout when it is omitted. A stuck command could then block a
 * session indefinitely. This extension makes unbounded execution impossible:
 *
 *   - bash tool calls without a valid positive `timeout` get a default
 *     injected before execution (documented `tool_call` mutation):
 *     120s for ordinary commands, 180s for download/network-transfer
 *     commands (wget, curl, git clone/pull, scp, rsync, pip/npm installs,
 *     package-manager updates). Explicit positive timeouts remain authoritative.
 * Managed bash may detach after its foreground grace; this timeout remains a
 * process deadline, not a blocking wait.
 *
 * Installed at ~/.pi/agent/extensions/ — auto-discovered by the harness.
 */

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Default timeout applied when the model omits `timeout` on a bash call. */
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
/** Default for download/network-transfer commands (still bounded). */
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 180;

/**
 * Commands that perform network transfers or package downloads. A longer
 * default is fine here, but these are still the ones most likely to stall
 * forever on a dead peer, so the injected timeout must never be unbounded.
 */
const DOWNLOAD_COMMAND_RE =
   /(^|[\s|;&])(wget|curl|git\s+(clone|pull|fetch)|scp|rsync|sftp|npm\s+(install|ci|i)|npx|pnpm\s+(install|add)|yarn\s+(install|add)|pip(\d*)\s+install|uv\s+(pip\s+install|sync|add|tool\s+install)|conda\s+install|mamba\s+install|apt(-get)?\s+(update|install|upgrade|dist-upgrade)|dnf\s+(install|update|upgrade)|yum\s+(install|update|upgrade)|pacman\s+-S|snap\s+install|flatpak\s+install|docker\s+(pull|build|compose\s+pull)|podman\s+(pull|build)|go\s+(get|install)|cargo\s+(install|add|update)|huggingface-cli\s+download|hf\s+download|kaggle\s+(datasets\s+download|competitions\s+download)|gh\s+(repo\s+clone|release\s+download)|gdown|azcopy|gsutil\s+(cp|rsync)|aws\s+s3\s+(cp|sync)|rclone\s+copy)/;

function toPositiveSeconds(value) {
   if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
   }
   if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
         return parsed;
      }
   }
   return undefined;
}

function isDownloadCommand(command) {
   return typeof command === "string" && DOWNLOAD_COMMAND_RE.test(command);
}

export default function (pi) {
   pi.on("tool_call", (event) => {
      if (!isToolCallEventType("bash", event)) {
         return;
      }
      const timeout = toPositiveSeconds(event.input.timeout);
      if (timeout !== undefined) {
         // Normalize (e.g. numeric strings) so the executor receives a clean number.
         event.input.timeout = timeout;
         return;
      }
      const isDownload = isDownloadCommand(event.input.command);
      event.input.timeout = isDownload
         ? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS
         : DEFAULT_BASH_TIMEOUT_SECONDS;
      // Defaults are normal, not log events: stdout is RPC/JSON framing and
      // command previews can contain credentials. Never echo shell input here.
   });
}
