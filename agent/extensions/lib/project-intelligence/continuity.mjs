import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectMemoryKey } from "../../pi-memory/project-identity.ts";
import { nodeId } from "./store.mjs";
import { safeText } from "./privacy.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
/** Import curated, project-scoped memory, not transcript prose. The original
 * memory subsystem remains authoritative; these are historical projections. */
export async function discoverContinuity(
  identity,
  previousSources = [],
  { signal } = {},
) {
  const directory =
    process.env.PI_MEMORY_DIR ??
    path.join(path.dirname(identity.stateDir), "memory");
  const keys = [
    ...new Set(
      [identity.root, identity.cwd].filter(Boolean).map(projectMemoryKey),
    ),
  ];
  const sources = [];
  const removedSourceIds = [];
  const previous = new Map(previousSources.map((s) => [s.id, s]));
  for (const key of keys) {
    const files = [path.join("projects", key + ".md")];
    try {
      const dates = (await fs.readdir(path.join(directory, "daily", key)))
        .filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))
        .sort()
        .slice(-6);
      files.push(...dates.map((x) => path.join("daily", key, x)));
    } catch {}
    for (const rel of files) {
      signal?.throwIfAborted();
      const file = path.join(directory, rel),
        id = `memory:${identity.checkoutId}:${rel}`;
      const old = previous.get(id);
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (e) {
        if (e.code === "ENOENT" && old) removedSourceIds.push(id);
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        continue;
      // Re-extract unchanged files once when preference extraction changes.
      const signature = `intent-v2:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (old?.active !== false && old?.fingerprint === signature) continue;
      let text;
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.size > 65536 ||
          before.ino !== stat.ino ||
          before.dev !== stat.dev
        )
          continue;
        const bytes = Buffer.alloc(65537);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (
          read.bytesRead > 65536 ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          continue;
        text = bytes.subarray(0, read.bytesRead).toString("utf8");
      } catch (error) {
        signal?.throwIfAborted();
        continue;
      } finally {
        await handle?.close();
      }
      const nodes = [],
        claims = [];
      const root = nodeId("project", identity.id);
      let count = 0;
      for (const block of text.split(/\n\s*\n/)) {
        if (count >= 24) break;
        if (
          block.length < 20 ||
          block.length > 800 ||
          !/\b(?:decid|decision|architect|migrat|constraint|deploy|infrastr|fix|root cause|limitation|unresolved|database|depend|failed approach|design philosophy|visual identity)|\b(?:keep|preserve|retain|prefer|avoid)\b[^.!?\n]{0,120}\b(?:design|typography|palette|animation|motion|layout|brand|style)\b/i.test(
            block,
          )
        )
          continue;
        const clean = safeText(block, 801);
        // Never turn a clipped historical preference into a different claim.
        if (clean.includes("[redacted]") || clean.length < 20 || clean.length > 600) continue;
        const type = /\b(?:unresolved|risk|problem|failed)\b/i.test(clean)
          ? "issue"
          : /\bconstraint\b/i.test(clean)
            ? "constraint"
            : "decision";
        const entity = nodeId(
          type,
          `memory:${key}:${hash(clean).slice(0, 20)}`,
        );
        nodes.push({ id: entity, type, label: clean.slice(0, 90) });
        claims.push(
          {
            subject: root,
            predicate: "remembers",
            object: entity,
            relation: true,
            status: "historical",
            confidence: 0.6,
          },
          {
            subject: entity,
            predicate: "description",
            object: clean,
            relation: false,
            status: "historical",
            confidence: 0.6,
          },
        );
        count++;
      }
      sources.push({
        id,
        scope: identity.checkoutId,
        kind: "session",
        locator: `curated-memory:${rel}`,
        fingerprint: signature,
        expectedVersion: old?.version ?? 0,
        nodes,
        claims,
      });
    }
  }
  // A remembered older daily file can leave the discovery window and still be
  // durable. Withdraw it only when that exact source has actually disappeared.
  for (const old of previousSources
    .filter(
      (s) =>
        s.active !== false && s.id.startsWith(`memory:${identity.checkoutId}:`),
    )
    .slice(0, 128)) {
    const rel = old.id.slice(`memory:${identity.checkoutId}:`.length);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
    try {
      await fs.lstat(path.join(directory, rel));
    } catch (error) {
      if (error.code === "ENOENT") removedSourceIds.push(old.id);
    }
  }
  return { sources, removedSourceIds: [...new Set(removedSourceIds)] };
}
