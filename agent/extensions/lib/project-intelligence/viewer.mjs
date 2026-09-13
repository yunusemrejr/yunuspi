import http from "node:http";
import { spawn } from "node:child_process";
import { open, readFile, rename, chmod, mkdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { kill } from "node:process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("./viewer-server.mjs", import.meta.url));
const LOCK_WAIT_MS = 100;
const LOCK_STALE_MS = 15_000;
const STARTUP_TIMEOUT_MS = 6_000;
const PROBE_TIMEOUT_MS = 600;
const STATE_VERSION = 1;
const inFlight = new Map();

function randomToken() {
	return crypto.randomBytes(32).toString("base64url");
}

function randomId(bytes = 12) {
	return crypto.randomBytes(bytes).toString("hex");
}

function statePathFor(dbPath, checkoutId = "") {
	const scope = crypto.createHash("sha256").update(checkoutId).digest("hex").slice(0, 16);
	return `${dbPath}.viewer-v2-${scope}.json`;
}

function lockPathFor(statePath) {
	return `${statePath}.lock`;
}

function safeIdentity(identity = {}) {
	return {
		id: typeof identity.id === "string" ? identity.id.slice(0, 180) : "",
		name: typeof identity.name === "string" ? identity.name.slice(0, 240) : "Project",
		branch: typeof identity.branch === "string" ? identity.branch.slice(0, 240) : "",
		checkoutId: typeof identity.checkoutId === "string" ? identity.checkoutId.slice(0, 240) : "",
		git: identity.git === true,
	};
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readState(statePath) {
	try {
		const state = JSON.parse(await readFile(statePath, "utf8"));
		return state && typeof state === "object" ? state : null;
	} catch {
		return null;
	}
}

async function writeState(statePath, state) {
	await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	const temporary = `${statePath}.${process.pid}.${randomId(6)}.tmp`;
	await open(temporary, "w", 0o600).then(async (handle) => {
		try {
			await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
			await handle.chmod(0o600);
		} finally {
			await handle.close();
		}
	});
	await chmod(temporary, 0o600);
	await rename(temporary, statePath);
}

async function removeFile(filePath) {
	try { await unlink(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function acquireLaunchLock(lockPath) {
	const started = Date.now();
	while (true) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8"); } finally { await handle.close(); }
			return async () => { await removeFile(lockPath); };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try {
				const details = await stat(lockPath);
				if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
					const lockText = await readFile(lockPath, "utf8").catch(() => "");
					let ownerPid = 0;
					try { ownerPid = JSON.parse(lockText).pid; } catch {}
					stale = !processAlive(ownerPid);
				}
			} catch (statError) {
				stale = statError?.code === "ENOENT";
			}
			if (stale) {
				await removeFile(lockPath);
				continue;
			}
			if (Date.now() - started > STARTUP_TIMEOUT_MS + 2_000) throw new Error("another viewer launch is still in progress");
			await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
		}
	}
}

function probe(port, token) {
	return new Promise((resolve) => {
		if (!Number.isInteger(port) || port <= 0 || typeof token !== "string") { resolve(null); return; }
		const request = http.get({
			host: "127.0.0.1",
			port,
			path: "/api/health",
			headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}` },
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; if (body.length > 16_000) response.destroy(); });
			response.on("end", () => {
				if (response.statusCode !== 200) { resolve(null); return; }
				try { resolve(JSON.parse(body)); } catch { resolve(null); }
			});
		});
		request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy());
		request.on("error", () => resolve(null));
	});
}

function focusExisting(port, token) {
	return new Promise((resolve) => {
		if (!Number.isInteger(port) || port <= 0 || typeof token !== "string") { resolve("viewer endpoint is unavailable"); return; }
		const request = http.request({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: "/api/focus",
			headers: {
				Authorization: `Bearer ${token}`,
				Origin: `http://127.0.0.1:${port}`,
				"content-type": "application/json",
				"content-length": "2",
			},
		});
		let body = "";
		request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy(new Error("viewer focus timed out")));
		request.on("response", (response) => {
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				if (response.statusCode !== 200) {
					let message = `viewer focus failed (${response.statusCode ?? "unknown"})`;
					try { message = JSON.parse(body)?.message || message; } catch {}
					resolve(message);
				} else resolve(null);
			});
		});
		request.on("error", (error) => resolve(String(error.message || error)));
		request.end("{}");
	});
}

async function waitForState(statePath, childPid) {
	const started = Date.now();
	let latest = await readState(statePath);
	while (Date.now() - started < STARTUP_TIMEOUT_MS) {
		latest = await readState(statePath) || latest;
		if (latest?.status === "running" && Number.isInteger(latest.port) && latest.port > 0 && latest.token) {
			const health = await probe(latest.port, latest.token);
			if (health?.ok === true) return latest;
		}
		if (childPid && !processAlive(childPid) && latest?.status !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
	}
	return latest;
}

async function openExternal(url) {
	let command;
	let args;
	if (process.platform === "darwin") {
		command = "open";
		args = ["-na", "Google Chrome", "--args", `--app=${url}`];
	} else if (process.platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		// An app-mode Chromium window is a separate graphical window and keeps
		// the terminal free. Prefer a detected browser, then Firefox's own window
		// switch, with xdg-open as a last-resort desktop integration.
		const chromiumCandidates = [
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		];
		const chromium = chromiumCandidates.find((candidate) => existsSync(candidate));
		if (chromium) {
			command = chromium;
			args = [`--app=${url}`, "--new-window"];
		} else if (existsSync("/usr/bin/firefox")) {
			command = "/usr/bin/firefox";
			args = ["--new-window", url];
		} else {
			command = "xdg-open";
			args = [url];
		}
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (error) => { if (settled) return; settled = true; resolve(error ? String(error.message || error) : null); };
		let child;
		try {
			child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
			child.once("error", finish);
			child.once("exit", (code, signal) => { if (code && code !== 0) finish(new Error(`${command} exited ${code}${signal ? ` (${signal})` : ""}`)); });
			child.unref();
			setTimeout(() => finish(null), 700);
		} catch (error) {
			finish(error);
		}
	});
}

function viewerUrl(state) {
	if (!state || !Number.isInteger(state.port) || state.port <= 0 || !state.token) return null;
	return `http://127.0.0.1:${state.port}/#${state.token}`;
}

async function launchViewer(statePath, dbPath, identity) {
	const existing = await readState(statePath);
	if (existing?.status === "running" && processAlive(existing.pid)) {
		const health = await probe(existing.port, existing.token);
		if (health?.ok === true) return { state: existing, reused: true, viewerPresent: Number(health.viewers) > 0 };
		const waiting = await waitForState(statePath, existing.pid);
		if (waiting?.status === "running") {
			const healthAfterWait = await probe(waiting.port, waiting.token);
			if (healthAfterWait?.ok === true) return { state: waiting, reused: true, viewerPresent: Number(healthAfterWait.viewers) > 0 };
		}
	}

	const state = {
		version: STATE_VERSION,
		status: "starting",
		projectId: identity.id,
		identity,
		leaseName: `project-intelligence-viewer:v2:${identity.id}:${identity.checkoutId}`,
		owner: `viewer-${process.pid}-${randomId(8)}`,
		token: randomToken(),
		pid: null,
		port: null,
		startedAt: new Date().toISOString(),
		statePath,
	};
	await writeState(statePath, state);
	let child;
	try {
		child = spawn(process.execPath, [SERVER_PATH, "--state", statePath, "--db", dbPath], {
			detached: true,
			stdio: "ignore",
			cwd: path.dirname(SERVER_PATH),
			env: { ...process.env, PI_PROJECT_INTELLIGENCE_VIEWER: "1" },
		});
		child.unref();
	} catch (error) {
		const startError = new Error(`Could not start the local viewer: ${error.message}. Re-run /graph; recovery state is ${statePath}.`);
		startError.code = "VIEWER_START_FAILED";
		startError.statePath = statePath;
		throw startError;
	}
	const ready = await waitForState(statePath, child.pid);
	const url = viewerUrl(ready);
	if (!url) {
		const launchError = new Error(`The local viewer did not become ready. Re-run /graph; recovery state is ${statePath}.`);
		launchError.code = "VIEWER_START_FAILED";
		launchError.statePath = statePath;
		launchError.pid = child.pid ?? null;
		throw launchError;
	}
	return { state: ready, reused: false, viewerPresent: false };
}

/**
 * Start or reconnect to the one detached viewer server for a project.
 * The browser capability lives only in the URL fragment and the private state
 * file; no capability is sent to the server as a URL query parameter.
 */
export async function openProjectViewer({ dbPath, identity, launch = true, launchExternal = openExternal } = {}) {
	if (typeof dbPath !== "string" || !path.isAbsolute(dbPath)) throw new TypeError("openProjectViewer requires an absolute dbPath");
	const safe = safeIdentity(identity);
	if (!safe.id) throw new TypeError("openProjectViewer requires identity.id");
	if (typeof launchExternal !== "function") throw new TypeError("openProjectViewer launchExternal must be a function");
	const statePath = statePathFor(dbPath, safe.checkoutId);
	const existingPromise = inFlight.get(statePath);
	if (existingPromise) return existingPromise;
	const operation = (async () => {
		await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
		const release = await acquireLaunchLock(lockPathFor(statePath));
		try {
			const result = await launchViewer(statePath, dbPath, safe);
			const url = viewerUrl(result.state);
			if (launch && url) {
				if (result.reused && result.viewerPresent) {
					const focusError = await focusExisting(result.state.port, result.state.token);
					if (focusError) {
						const error = new Error(`The existing project viewer is connected but could not be focused: ${focusError}. Open the returned URL manually: ${url}`);
						error.code = "VIEWER_FOCUS_FAILED";
						error.url = url;
						error.pid = Number.isInteger(result.state?.pid) ? result.state.pid : null;
						error.reused = true;
						throw error;
					}
				} else {
					let externalError;
					try {
						externalError = await launchExternal(url);
					} catch (errorValue) {
						externalError = String(errorValue?.message || errorValue);
					}
					if (externalError) {
						const error = new Error(`Could not open a browser window: ${externalError}. Open the returned URL manually: ${url}`);
						error.code = "VIEWER_LAUNCH_FAILED";
						error.url = url;
						error.pid = Number.isInteger(result.state?.pid) ? result.state.pid : null;
						error.reused = result.reused === true;
						throw error;
					}
				}
			}
			return {
				url,
				pid: Number.isInteger(result.state?.pid) ? result.state.pid : null,
				reused: result.reused === true,
			};
		} finally {
			await release().catch(() => {});
		}
	})();
	inFlight.set(statePath, operation);
	try { return await operation; } finally { inFlight.delete(statePath); }
}

export {
	SERVER_PATH,
	STARTUP_TIMEOUT_MS,
	statePathFor,
	viewerUrl,
};
