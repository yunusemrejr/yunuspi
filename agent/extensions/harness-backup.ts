/**
 * /harness-backup — timestamped, restorable ZIP of the customized pi harness.
 *
 * Thin wrapper around the standalone scripts/harness-backup.mjs (kept as a
 * script so it's testable and reusable outside pi). The command is local
 * only: zero LLM/API calls, zero network. Never prints secret values — the
 * script writes discovered provider env vars straight into the archive's
 * META/credentials.env (0600) and only ever lists names.
 *
 * Architecture: lives in extensions/ + scripts/ (outside node_modules), so
 * npm/extensions updates cannot wipe it; verify-harness.mjs [8c] asserts
 * both files exist and the script still parses + keeps its redaction marker.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@yunuspi/coding-agent";

const SCRIPT = path.join(
	os.homedir(),
	".pi",
	"agent",
	"scripts",
	"harness-backup.mjs",
);

const execFileAsync = promisify(execFile);

export default function (pi: ExtensionAPI) {
	let running = false;
	let closed = false;
	pi.on("session_shutdown", () => {
		closed = true;
	});
	pi.registerCommand("harness-backup", {
		description:
			"Back up the pi harness (+ used provider credentials) as a timestamped ZIP on the Desktop — local, zero LLM calls, secrets never printed",
		handler: async (_args, ctx) => {
			if (running) {
				if (ctx.hasUI) ctx.ui.notify("Harness backup is already running.", "info");
				return;
			}
			if (!fs.existsSync(SCRIPT)) {
				ctx.ui.notify(`harness-backup: script missing: ${SCRIPT}`, "warning");
				return;
			}
			running = true;
			if (ctx.hasUI) ctx.ui.notify("Creating and verifying Desktop ZIP…", "info");
			try {
				// The script itself is the secret-redaction boundary — it never
				// writes values to stdout, so relaying its output is safe.
				const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
					encoding: "utf8",
					env: { ...process.env, NO_COLOR: "1" },
				});
				if (closed) return; // a completed backup must not touch a stale session
				if (ctx.hasUI) ctx.ui.notify(stdout.trim(), "info");
				else console.log(stdout.trim());
			} catch (e) {
				if (closed) return;
				const msg = `harness-backup failed: ${(e?.message ?? String(e)).slice(0, 400)}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(msg);
			} finally {
				running = false;
			}
		},
	});
}
