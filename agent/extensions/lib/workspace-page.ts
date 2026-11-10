/** Workspace pages in the browser: a path to a page inside the workspace opens from the
 * files themselves, so a local page needs no server. The runner
 * (scripts/browser-session-runner.mjs) answers this origin; the review tools read the same
 * URL back as the file it stands for. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `.localhost` keeps the secure context a dev server on localhost has. */
export const WORKSPACE_ORIGIN = "http://workspace.localhost";

/** The workspace-origin URL of a path or `file:` URL that names something inside the
 * workspace; undefined for a web URL, a missing file or a file outside the workspace. */
export async function workspacePageUrl(raw: string, cwd: string): Promise<string | undefined> {
  const text = raw.trim();
  if (!text || /^(?:https?|wss?|about|data|blob|javascript):/i.test(text)) return undefined;
  try {
    const root = await fs.realpath(cwd), asUrl = /^file:/i.test(text) ? new URL(text) : undefined;
    // `page.html#prices` may be a file of that very name or a page with a fragment: the file wins.
    const cut = asUrl ? -1 : text.search(/[?#]/);
    const attempts: Array<[string, string]> = asUrl
      ? [[fileURLToPath(Object.assign(new URL(text), { search: "", hash: "" })), asUrl.search + asUrl.hash]]
      : [[text, ""], ...(cut >= 0 ? [[text.slice(0, cut), text.slice(cut)] as [string, string]] : [])];
    for (const [candidate, suffix] of attempts) {
      const file = await fs.realpath(path.resolve(cwd, candidate)).catch(() => undefined);
      if (!file) continue;
      const relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return undefined;
      const folder = (await fs.stat(file)).isDirectory() && relative ? "/" : "";
      return `${WORKSPACE_ORIGIN}/${relative.split(path.sep).map(encodeURIComponent).join("/")}${folder}${suffix}`;
    }
  } catch { /* not a workspace page */ }
  return undefined;
}

/** The workspace-relative file behind a workspace-origin URL. */
export function workspacePagePath(url: string): string | undefined {
  if (!url.startsWith(WORKSPACE_ORIGIN + "/")) return undefined;
  try {
    const relative = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
    // An encoded `..` survives URL parsing; a path that climbs out names nothing in the workspace.
    if (relative.split(/[\\/]/).includes("..") || path.isAbsolute(relative)) return undefined;
    return !relative || relative.endsWith("/") ? `${relative}index.html` : relative;
  } catch { return undefined; }
}
