import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const hash = (v: any) =>
  createHash("sha256")
    .update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
const excluded =
  /(^|\/)(\.git|\.pi|\.ssh|\.gnupg|\.aws|\.config|node_modules|vendor|dist|build|coverage|\.cache|__pycache__|\.env[^/]*|auth\.json|models\.json|credentials[^/]*|secrets[^/]*|\.npmrc|\.netrc|\.pypirc|.*\.(pem|key|p12|pfx))($|\/)/i;
export class ScopedSnapshots {
  store: string;
  retain: number;
  constructor(store: string, retain = 20) {
    this.store = store;
    this.retain = retain;
  }
  async locked<T>(fn: () => Promise<T>) {
    await fs.mkdir(this.store, { recursive: true, mode: 0o700 });
    const lock = path.join(this.store, "lock");
    try {
      await fs.mkdir(lock);
    } catch {
      throw Error(
        "Snapshot store busy; if no snapshot process is running remove stale store/lock manually",
      );
    }
    try {
      return await fn();
    } finally {
      await fs.rmdir(lock);
    }
  }
  async root(cwd: string) {
    const root = await fs.realpath(cwd),
      // Compare physical paths: an outside alias can point inside capture root.
      store = await fs.realpath(this.store);
    if (
      store === root ||
      store.startsWith(root + path.sep) ||
      root === path.parse(root).root
    )
      throw Error(
        "Snapshot store must be outside capture root; choose a narrower workdir",
      );
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      try {
        await fs.lstat(path.join(ancestor, ".git"));
        throw Error(
          "Use existing Git checkpoint workflow for Git workdirs (including subdirectories)",
        );
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
    return root;
  }
  async safe(root: string, rel: string) {
    if (
      !rel ||
      path.isAbsolute(rel) ||
      rel.split(/[\\/]/).some((s) => s === ".." || s === "") ||
      excluded.test(rel)
    )
      throw Error("Out-of-scope or excluded path");
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) throw Error("Path outside scope");
    let dir = path.dirname(file);
    while (dir !== root) {
      try {
        const st = await fs.lstat(dir);
        if (st.isSymbolicLink() || !st.isDirectory())
          throw Error("Parent symlink/non-directory prohibited");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      dir = path.dirname(dir);
    }
    return file;
  }
  async state(
    file: string,
    save = false,
    remaining = 50 * 1024 * 1024,
  ): Promise<any> {
    let observedSource = false;
    try {
      const s = await fs.lstat(file);
      observedSource = true;
      if (s.isSymbolicLink())
        return { kind: "symlink", target: await fs.readlink(file) };
      if (!s.isFile())
        throw Error(
          "Only explicit files/symlinks supported (not directories/devices)",
        );
      if (s.size > 2 * 1024 * 1024) throw Error("File exceeds 2 MiB");
      if (s.size > remaining) throw Error("Snapshot exceeds 50 MiB");
      const h = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const opened = await h.stat();
        if (!opened.isFile() || opened.ino !== s.ino || opened.dev !== s.dev)
          throw Error("File changed during snapshot observation");
        const b = Buffer.alloc(s.size + 1);
        const { bytesRead } = await h.read(b, 0, b.length, 0);
        const after = await h.stat();
        if (
          bytesRead !== s.size ||
          after.size !== s.size ||
          after.mtimeMs !== s.mtimeMs
        )
          throw Error("File changed during snapshot observation");
        bytes = b.subarray(0, bytesRead);
      } finally {
        await h.close();
      }
      const digest = hash(bytes);
      if (save) {
        const blob = path.join(this.store, "blobs", digest);
        await fs.mkdir(path.dirname(blob), { recursive: true, mode: 0o700 });
        try {
          await fs.writeFile(blob, bytes, { flag: "wx", mode: 0o600 });
        } catch (e: any) {
          if (e.code !== "EEXIST") throw e;
          // A hash-shaped filename does not establish that a previous write
          // survived intact. Do not publish another unusable recovery point.
          const existing = await fs.open(
            blob,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
          );
          try {
            const stat = await existing.stat();
            if (!stat.isFile() || stat.size !== bytes.length)
              throw Error("Corrupt content-addressed blob; snapshot not recorded");
            const stored = Buffer.alloc(bytes.length + 1);
            const { bytesRead } = await existing.read(stored, 0, stored.length, 0);
            if (bytesRead !== bytes.length || !stored.subarray(0, bytesRead).equals(bytes))
              throw Error("Corrupt content-addressed blob; snapshot not recorded");
          } finally {
            await existing.close();
          }
        }
      }
      return {
        kind: "file",
        hash: digest,
        mode: s.mode & 0o777,
        mtime: s.mtimeMs,
        size: s.size,
      };
    } catch (e: any) {
      // Absence must describe the original path, not a missing blob or a
      // source that vanished after observation. Never turn capture failure
      // into an absence record that would authorize deletion on restore.
      if (e.code === "ENOENT" && !observedSource) return { kind: "absent" };
      throw e;
    }
  }
  async create(cwd: string, paths: string[]) {
    return this.locked(async () => {
      const root = await this.root(cwd);
      if (!paths?.length || paths.length > 200)
        throw Error(
          "Provide 1–200 explicit relative file paths, including planned new paths to record absence",
        );
      const entries: any = Object.create(null),
        exclusions: any[] = [];
      let bytes = 0;
      for (const rel of [...new Set(paths)]) {
        try {
          const file = await this.safe(root, rel),
            s = await this.state(file, true, 50 * 1024 * 1024 - bytes);
          bytes += s.size ?? 0;
          if (bytes > 50 * 1024 * 1024) throw Error("Snapshot exceeds 50 MiB");
          entries[rel] = s;
        } catch (e: any) {
          exclusions.push({ path: rel, reason: e.message });
        }
      }
      if (!Object.keys(entries).length)
        throw Error(`No covered paths: ${JSON.stringify(exclusions)}`);
      const manifest = {
        version: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        root,
        entries,
        exclusions,
        coverage:
          "Explicit pre-action file paths only. No shell interception. New files removable only if prior absence recorded. Symlinks stored, never followed; parent symlinks prohibited. No directory metadata, ACLs, ownership or xattrs.",
      };
      const dir = path.join(this.store, "manifests");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, manifest.id + ".tmp");
      await fs.writeFile(tmp, JSON.stringify(manifest), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(tmp, path.join(dir, manifest.id + ".json"));
      await this.prune();
      return manifest;
    });
  }
  async list() {
    try {
      return (await fs.readdir(path.join(this.store, "manifests")))
        .filter((n) => /^[a-f0-9-]+\.json$/.test(n))
        .map((n) => n.slice(0, -5));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async inspect(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid snapshot ID");
    return JSON.parse(
      await fs.readFile(
        path.join(this.store, "manifests", id + ".json"),
        "utf8",
      ),
    );
  }
  async preview(cwd: string, id: string) {
    const m = await this.inspect(id),
      root = await this.root(cwd);
    if (root !== m.root) throw Error("Snapshot belongs to a different workdir");
    const current: any = Object.create(null),
      changes: any[] = [];
    for (const [rel, before] of Object.entries(m.entries)) {
      const file = await this.safe(root, rel);
      current[rel] = await this.state(file);
      if (hash(before) !== hash(current[rel]))
        changes.push({
          path: rel,
          before,
          current: current[rel],
          conflict: "Changed since snapshot; explicit confirmation required",
        });
    }
    return {
      id,
      root,
      changes,
      token: hash({ m, current }),
      coverage: m.coverage,
    };
  }
  async restore(cwd: string, id: string, token: string, queue: any) {
    return this.locked(async () => {
      const p = await this.preview(cwd, id);
      if (p.token !== token)
        throw Error("Preview stale: files changed; preview again");
      const m = await this.inspect(id),
        restored: string[] = [],
        failed: any[] = [];
      for (const change of p.changes) {
        try {
          const file = await this.safe(p.root, change.path);
          await queue(file, async () => {
            await this.safe(p.root, change.path);
            if (hash(await this.state(file)) !== hash(change.current))
              throw Error("Concurrent edit since preview");
            const before = m.entries[change.path];
            if (before.kind === "absent") {
              await fs.unlink(file);
              return;
            }
            await fs.mkdir(path.dirname(file), { recursive: true });
            const tmp = path.join(
              path.dirname(file),
              ".pi-restore-" + randomUUID(),
            );
            try {
              if (before.kind === "symlink")
                await fs.symlink(before.target, tmp);
              else {
                const bytes = await fs.readFile(
                  path.join(this.store, "blobs", before.hash),
                );
                if (hash(bytes) !== before.hash)
                  throw Error("Corrupt content-addressed blob");
                await fs.writeFile(tmp, bytes, {
                  flag: "wx",
                  mode: before.mode,
                });
                await fs.chmod(tmp, before.mode);
                await fs.utimes(tmp, new Date(), new Date(before.mtime));
              }
              await fs.rename(tmp, file);
            } finally {
              await fs.unlink(tmp).catch(() => {});
            }
          });
          restored.push(change.path);
        } catch (e: any) {
          failed.push({ path: change.path, error: e.message });
        }
      }
      return {
        status: failed.length ? "partial" : "restored",
        restored,
        failed,
      };
    });
  }
  async prune() {
    const manifests = await Promise.all(
      (await this.list()).map((id) => this.inspect(id)),
    );
    manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const m of manifests.slice(this.retain))
      await fs.unlink(path.join(this.store, "manifests", m.id + ".json"));
    const used = new Set(
      manifests.slice(0, this.retain).flatMap((m) =>
        Object.values(m.entries)
          .map((s: any) => s.hash)
          .filter(Boolean),
      ),
    );
    for (const name of await fs
      .readdir(path.join(this.store, "blobs"))
      .catch(() => []))
      if (/^[a-f0-9]{64}$/.test(name) && !used.has(name))
        await fs.unlink(path.join(this.store, "blobs", name));
  }
}
