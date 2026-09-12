import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getWebSearchConfigDir } from "./utils.ts";

export class SearchCooldownError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "Search provider cooling down") {
    super(
      `${message}; retry after ${Math.ceil(retryAfterMs / 1000)}s or use an independent provider. Do not switch endpoint/proxy to evade the limit.`,
    );
    this.name = "SearchCooldownError";
    this.retryAfterMs = retryAfterMs;
  }
}
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : 60_000;
}
const stateRoot = () => path.join(getWebSearchConfigDir(), "web-search-pacing");
type PaceState = { next?: number; cooldown?: number };
async function updateState(
  provider: string,
  update: (state: PaceState) => void,
  signal?: AbortSignal,
): Promise<void> {
  const root = stateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Unsafe search pacing directory");
  const key = createHash("sha256").update(provider).digest("hex");
  const file = path.join(root, `${key}.json`),
    lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    signal?.throwIfAborted();
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      // Do not steal a live writer's lease. Recover only an old dead owner.
      const info = fs.lstatSync(lock);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("Unsafe search pacing lock");
      if (Date.now() - info.mtimeMs > 30_000) {
        let owner: number | undefined;
        try {
          owner = JSON.parse(
            fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
          ).pid;
        } catch {}
        let dead = owner === undefined;
        if (Number.isSafeInteger(owner) && owner! > 0) {
          try {
            process.kill(owner!, 0);
          } catch (e: any) {
            dead = e.code === "ESRCH";
          }
        }
        if (dead) {
          const retired = `${lock}.${randomUUID()}`;
          try {
            fs.renameSync(lock, retired);
            fs.rmSync(retired, { recursive: true });
          } catch {}
          continue;
        }
      }
      if (Date.now() >= deadline)
        throw Error("Search pacing lease busy; retry later");
      await delay(50, undefined, { signal });
    }
  }
  try {
    fs.writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      { mode: 0o600 },
    );
    let state: PaceState = {};
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        if (fs.fstatSync(fd).size > 1024)
          throw Error("Invalid search pacing state");
        state = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
      if (
        !state ||
        typeof state !== "object" ||
        [state.next, state.cooldown].some(
          (x) => x !== undefined && (!Number.isFinite(x) || x < 0),
        )
      )
        throw Error("Invalid search pacing state");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    update(state);
    const tmp = `${file}.${randomUUID()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } finally {
    fs.rmSync(lock, { recursive: true });
  }
}
export async function waitForSearchSlot(
  provider: string,
  signal?: AbortSignal,
  intervalMs = 5000,
): Promise<void> {
  // Reserve one start at a time across agents/processes. Cancellation wastes at
  // most one slot; it never releases a slot early and permits a burst.
  let wait = 0;
  await updateState(
    provider,
    (state) => {
      const now = Date.now();
      if ((state.cooldown ?? 0) > now)
        throw new SearchCooldownError(state.cooldown! - now);
      wait = Math.max(0, (state.next ?? 0) - now);
      if (wait > 60_000)
        throw new SearchCooldownError(wait, "Search queue full");
      state.next = now + wait + intervalMs;
    },
    signal,
  );
  if (wait) await delay(wait, undefined, { signal });
  // A peer may have observed a block while this reservation was waiting.
  await updateState(
    provider,
    (state) => {
      if ((state.cooldown ?? 0) > Date.now())
        throw new SearchCooldownError(state.cooldown! - Date.now());
    },
    signal,
  );
}
export async function coolSearchProvider(
  provider: string,
  milliseconds: number,
): Promise<never> {
  await updateState(provider, (state) => {
    state.cooldown = Math.max(state.cooldown ?? 0, Date.now() + milliseconds);
  });
  throw new SearchCooldownError(milliseconds);
}
export async function readSearchBody(
  response: Response,
  cap = 2 * 1024 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > cap)
        throw Error(
          "Search response exceeds bounded body limit (invalid response)",
        );
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function searchGet(
  provider: string,
  url: URL,
  signal?: AbortSignal,
): Promise<string> {
  await waitForSearchSlot(provider, signal);
  const response = await fetch(url, {
    redirect: "error",
    headers: {
      Accept: "application/json, text/html",
      "User-Agent": "YunusPi/1.0 (+https://github.com/yunusemrejr/yunuspi)",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel();
    await coolSearchProvider(
      provider,
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  if (response.status === 403) {
    await response.body?.cancel();
    await coolSearchProvider(provider, 15 * 60_000);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`${provider} search HTTP ${response.status}`);
  }
  return readSearchBody(response);
}
