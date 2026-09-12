#!/usr/bin/env node
// Offline audit of recent session transcripts. The scanner owns all bounds and
// disclosure rules; this CLI only parses its small local option surface.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSessionAudit } from "../extensions/lib/session-audit.ts";

const args = process.argv.slice(2);
let directory = fileURLToPath(new URL("../sessions", import.meta.url));
let limit = 30;
let scope = "all";

for (let i = 0; i < args.length; i++) {
	const key = args[i];
	const value = args[++i];
	if (key === "--sessions" && value) directory = path.resolve(value);
	else if (key === "--limit" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100) limit = Number(value);
	else if (key === "--scope" && (value === "all" || value === "workspace")) scope = value;
	else {
		console.error("Use [--sessions DIRECTORY] [--limit 1..100] [--scope workspace|all]");
		process.exit(2);
	}
}

try {
	const report = await scanSessionAudit({
		sessionsDir: directory,
		maxFiles: limit,
		scope,
		workspace: process.cwd(),
	});
	console.log(JSON.stringify(report, null, 2));
} catch {
	// Keep the public report free of filesystem paths and raw exception text.
	console.error("Session audit unavailable");
	process.exitCode = 1;
}
