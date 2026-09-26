/**
 * Path safety — pure workspace-containment primitives for extension libs.
 *
 * WHY: several creative libs tested containment with `resolved.startsWith(root)`,
 * which admits sibling-prefix escapes (`/work/project-evil/...` shares the
 * string prefix of `/work/project`). `containsPath` here mirrors the harness
 * canonical primitive (self-mutation-guard.ts) without that module's
 * import-time root discovery; `resolveWithinRoot` additionally pins the root
 * and the resolved leaf through realpath so symlink escapes are rejected.
 *
 * Policy: symlinks (including a symlinked leaf) resolve to their ultimate
 * target and must land inside the root. Missing paths are rejected — every
 * caller stats/reads the target right after resolving it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Strict containment: child equals parent or lives beneath it. Pure. */
export function containsPath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Realpath of an existing directory; throws when it cannot be established. */
export function realRoot(cwd: string): string {
	return fs.realpathSync(cwd);
}

/**
 * Resolve a user-supplied path against a workspace root and prove the final
 * target (symlinks followed, leaf included) stays inside the root.
 * Throws on escape, missing target, or unreadable root.
 */
export function resolveWithinRoot(root: string, userPath: string, what = "path"): string {
	if (typeof userPath !== "string" || !userPath) throw new Error(`${what} must be a non-empty path`);
	const pinned = fs.realpathSync(root);
	const candidate = path.resolve(pinned, userPath.replace(/^@/, ""));
	let real: string;
	try {
		real = fs.realpathSync(candidate);
	} catch {
		throw new Error(`${what} does not exist inside the workspace`);
	}
	if (!containsPath(pinned, real)) throw new Error(`${what} must stay inside the workspace`);
	return real;
}

/**
 * Display-only relativization that never emits a deceptive `..`-free string:
 * paths outside the root are returned absolute. Pure.
 */
export function relativeOrAbsolute(cwd: string, file: string): string {
	const r = path.relative(cwd, file);
	return r === "" || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r) ? file : r;
}
