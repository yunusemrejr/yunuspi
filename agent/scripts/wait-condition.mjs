import fs from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
export async function waitCondition(p, signal) {
  const start = Date.now();
  const finish = (status, evidence) => ({
    status,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    evidence: String(evidence ?? "").slice(0, 1000),
  });
  if (
    !Number.isFinite(p.timeout) ||
    p.timeout <= 0 ||
    p.timeout > 600 ||
    !["http", "exists", "literal"].includes(p.kind) ||
    typeof p.target !== "string" ||
    (p.kind === "literal" && (!p.text || p.text.length > 512))
  )
    return finish(
      "invalid",
      "Use http/exists/literal, timeout 0–600 seconds; literal text 1–512 chars.",
    );
  if (p.kind === "http") {
    try {
      const u = new URL(p.target);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw 0;
    } catch {
      return finish("invalid", "Expected credential-free HTTP(S) URL");
    }
    if (
      p.status !== undefined &&
      (!Number.isInteger(p.status) || p.status < 100 || p.status > 599)
    )
      return finish("invalid", "HTTP status 100–599");
  }
  let last = "not observed",
    delay = 100;
  while (Date.now() - start < p.timeout * 1000) {
    if (signal?.aborted) return finish("cancelled", last);
    try {
      if (p.kind === "http") {
        const deadline = AbortSignal.timeout(
          Math.max(1, Math.min(2000, p.timeout * 1000 - (Date.now() - start))),
        );
        const r = await fetch(p.target, {
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
        last = `HTTP ${r.status}`;
        await r.body?.cancel();
        if (r.status === (p.status ?? 200)) return finish("success", last);
      } else {
        const observed = await fs.lstat(p.target);
        if (p.kind === "exists") return finish("success", `${p.target} exists`);
        if (!observed.isFile())
          return finish(
            "invalid",
            "literal condition requires a regular file, not a symlink/device/FIFO",
          );
        const h = await fs.open(
          p.target,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        try {
          const st = await h.stat();
          if (!st.isFile())
            return finish(
              "invalid",
              "literal condition requires a regular file",
            );
          const n = Math.min(st.size, 65536),
            b = Buffer.alloc(n);
          await h.read(b, 0, n, Math.max(0, st.size - n));
          const text = b.toString("utf8"),
            at = text.indexOf(p.text);
          last = `No literal in last ${n} bytes (each poll reopens; rotation/truncation supported)`;
          if (at >= 0)
            return finish(
              "success",
              text.slice(Math.max(0, at - 100), at + p.text.length + 300),
            );
        } finally {
          await h.close();
        }
      }
    } catch (e) {
      last = e.code ?? e.message;
    }
    try {
      await sleep(
        Math.min(delay, Math.max(1, p.timeout * 1000 - (Date.now() - start))),
        undefined,
        { signal },
      );
    } catch {
      return finish("cancelled", last);
    }
    delay = Math.min(1000, Math.ceil(delay * 1.5));
  }
  return finish(signal?.aborted ? "cancelled" : "timeout", last);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const c = new AbortController();
  process.on("SIGTERM", () => c.abort());
  try {
    console.log(
      JSON.stringify(
        await waitCondition(
          JSON.parse(Buffer.from(process.argv[2], "base64url").toString()),
          c.signal,
        ),
      ),
    );
  } catch (e) {
    console.log(JSON.stringify({ status: "invalid", evidence: e.message }));
    process.exitCode = 1;
  }
}
