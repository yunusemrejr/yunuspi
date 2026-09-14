#!/usr/bin/env node
// Offline token-cost/cache diagnostics CLI. Read-only over local session JSONL.
// Usage: node scripts/token-cost-diagnostics.mjs [--sessions DIR] [--since YYYY-MM-DD] [--json]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, scanTokenCost } from "./lib/token-cost-diagnostics.mjs";

const args = process.argv.slice(2);
let directory = fileURLToPath(new URL("../sessions", import.meta.url));
let since;
let json = false;

for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === "--json") {
    json = true;
    continue;
  }
  const value = args[++i];
  if (key === "--sessions" && value) directory = path.resolve(value);
  else if (key === "--since" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    since = value;
  else {
    console.error("Use [--sessions DIR] [--since YYYY-MM-DD] [--json]");
    process.exit(2);
  }
}

try {
  const report = await scanTokenCost({ sessionsDir: directory, since });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
} catch (error) {
  // Paths and raw exception text stay out of the report surface.
  console.error("Token/cache diagnostics unavailable");
  process.exitCode = 1;
}
