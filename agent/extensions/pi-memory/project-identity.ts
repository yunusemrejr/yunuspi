import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
/** Legacy lossy slugs remain on disk, but cannot establish project ownership. */
export function projectMemoryKey(cwd?: string) {
  if (!cwd) return "global";
  const canonical = fs.realpathSync(cwd);
  const label =
    path
      .basename(canonical)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 48) || "root";
  return `${label}-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}
