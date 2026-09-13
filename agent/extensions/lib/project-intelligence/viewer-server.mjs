import http from "node:http";
import { readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 120;
const MAX_ID_CHARS = 512;
const MAX_TYPES = 20;
const DEFAULT_LIMIT = 220;
const MIN_LIMIT = 20;
const LEASE_TTL_MS = 30_000;
const IDLE_GRACE_MS = 90_000;
const VIEWER_TTL_MS = 35_000;
const POLL_INTERVAL_MS = 2_500;
const SERVER_VERSION = "project-intelligence-viewer/2";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(ROOT, "viewer-assets");

function randomId(bytes = 16) {
	return crypto.randomBytes(bytes).toString("hex");
}

function sameSecret(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function asBoundedString(value, max, fallback = "") {
	if (typeof value !== "string") return fallback;
	return value.length <= max ? value : value.slice(0, max);
}

function clampInt(value, min, max, fallback) {
	const number = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function json(res, status, value, headers = {}) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...headers,
	});
	res.end(body);
}

function error(res, status, code, message) {
	json(res, status, { error: code, message });
}

function parseCsv(value, maxItems = MAX_TYPES) {
	if (!value) return undefined;
	const items = String(value)
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.slice(0, maxItems);
	return items.length ? items : undefined;
}

function safeSlug(value) {
	return typeof value === "string" && /^[a-z0-9][a-z0-9_./:-]{0,80}$/i.test(value);
}

function safeNodeId(value) {
	// Node ids are opaque deterministic hashes (plus aggregate:<hash> ids).
	// Delimiters used for paths and URLs are rejected so lookup never becomes
	// an accidental file-like endpoint.
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && /^[a-zA-Z0-9:_#%+~=-]+$/.test(value);
}

function projectForResponse(identity) {
	if (!identity || typeof identity !== "object") return undefined;
	return {
		id: asBoundedString(identity.id, 160),
		name: asBoundedString(identity.name, 240),
		branch: asBoundedString(identity.branch, 240),
		checkoutId: asBoundedString(identity.checkoutId, 240),
		git: identity.git === true,
	};
}

function typeCounts(nodes = []) {
	const result = {};
	for (const node of nodes) {
		const type = safeSlug(node?.type) ? node.type : "other";
		result[type] = (result[type] ?? 0) + 1;
	}
	return result;
}

function normalizeGraph(graph, snapshot, identity, options = {}) {
	const result = graph && typeof graph === "object" ? graph : {};
	const sourceNodes = Array.isArray(result.nodes) ? result.nodes : [];
	const sourceEdges = Array.isArray(result.edges) ? result.edges : [];
	const nodes = sourceNodes
		.filter((node) => node && typeof node.id === "string" && node.id.length <= MAX_ID_CHARS)
		.map((node) => ({
			id: node.id,
			// simplifyGraph marks collapsed nodes with type=aggregate and keeps
			// the meaningful category in aggregateFor. Keep that category in the
		// transport model so the UI can style and expand the group correctly.
			type: node.aggregate === true && safeSlug(node.aggregateFor) ? node.aggregateFor : safeSlug(node.type) ? node.type : "other",
			label: asBoundedString(node.label ?? node.id, 260, node.id),
			key: asBoundedString(node.key, 512),
			status: asBoundedString(node.status, 40),
			confidence: typeof node.confidence === "number" ? Math.max(0, Math.min(1, node.confidence)) : undefined,
			aggregate: node.aggregate === true || String(node.id).startsWith("aggregate:"),
			aggregateFor: node.aggregate === true && safeSlug(node.aggregateFor) ? node.aggregateFor : undefined,
			hiddenCount: Number.isFinite(node.hiddenCount) ? Math.max(0, Math.min(1_000_000, node.hiddenCount)) : Number.isFinite(node.count) ? Math.max(0, Math.min(1_000_000, node.count)) : undefined,
			x: Number.isFinite(node.x) ? node.x : undefined,
			y: Number.isFinite(node.y) ? node.y : undefined,
		}));
	const ids = new Set(nodes.map((node) => node.id));
	const edges = sourceEdges
		.filter((edge) => edge && typeof edge.id === "string" && ids.has(edge.source) && ids.has(edge.target))
		.slice(0, 20_000)
		.map((edge) => ({
			id: asBoundedString(edge.id, MAX_ID_CHARS),
			source: edge.source,
			target: edge.target,
			type: safeSlug(edge.type) ? edge.type : "related",
			status: asBoundedString(edge.status, 40),
			confidence: typeof edge.confidence === "number" ? Math.max(0, Math.min(1, edge.confidence)) : undefined,
			aggregate: edge.aggregate === true || edge.aggregated === true,
			count: Number.isInteger(edge.count) ? edge.count : undefined,
		}));
	const counts = result.counts && typeof result.counts === "object" ? { ...result.counts } : {};
	const allSnapshotNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
	counts.totalNodes = Number.isFinite(counts.totalNodes) ? counts.totalNodes : allSnapshotNodes.length;
	counts.shownNodes = Number.isFinite(counts.shownNodes) ? counts.shownNodes : nodes.filter((node) => !node.aggregate).length;
	counts.totalEdges = Number.isFinite(counts.totalEdges) ? counts.totalEdges : Array.isArray(snapshot?.edges) ? snapshot.edges.length : edges.length;
	counts.shownEdges = Number.isFinite(counts.shownEdges) ? counts.shownEdges : edges.length;
	counts.hiddenNodes = Math.max(0, counts.totalNodes - counts.shownNodes);
	counts.byType = typeCounts(allSnapshotNodes);
	counts.byRelation = {};
	for (const edge of snapshot.edges ?? []) counts.byRelation[edge.type] = (counts.byRelation[edge.type] ?? 0) + 1;
	counts.aggregated = Array.isArray(counts.aggregated) ? counts.aggregated : nodes.filter((node) => node.aggregate).map((node) => ({ type: node.type, count: node.hiddenCount ?? 0 }));
	return {
		revision: Number.isFinite(result.revision) ? result.revision : snapshot?.revision ?? 0,
		project: result.project ?? snapshot?.project ?? projectForResponse(identity),
		nodes,
		edges,
		facts: Array.isArray(result.facts) ? result.facts.slice(0, 2_000) : [],
		health: result.health ?? snapshot?.health ?? {},
		activity: Array.isArray(result.activity) ? result.activity.slice(0, 100) : Array.isArray(snapshot?.activity) ? snapshot.activity.slice(0, 100) : [],
		counts,
		page: result.page,
		clusters: Array.isArray(result.clusters) ? result.clusters.slice(0, 100) : [],
	};
}

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const item = argv[index];
		if (!item.startsWith("--")) continue;
		const key = item.slice(2);
		const value = argv[index + 1];
		if (value && !value.startsWith("--")) {
			values[key] = value;
			index += 1;
		} else {
			values[key] = true;
		}
	}
	return values;
}

async function readState(statePath) {
	const value = JSON.parse(await readFile(statePath, "utf8"));
	if (!value || typeof value !== "object") throw new Error("invalid viewer state");
	return value;
}

async function writeState(statePath, value) {
	const directory = path.dirname(statePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${statePath}.${process.pid}.${randomId(6)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, statePath);
}

async function loadDataModules() {
	const storeModule = await import(new URL("./store.mjs", import.meta.url));
	const queryModule = await import(new URL("./query.mjs", import.meta.url));
	if (typeof storeModule.openStore !== "function") throw new Error("project intelligence store does not export openStore");
	return { openStore: storeModule.openStore, simplifyGraph: queryModule.simplifyGraph };
}

function requestOrigin(req) {
	const origin = req.headers.origin;
	return typeof origin === "string" ? origin : "";
}

function isApiPath(pathname) {
	return pathname === "/api/health" || pathname.startsWith("/api/");
}

function staticAsset(pathname) {
	const map = {
		"/": "index.html",
		"/index.html": "index.html",
		"/app.js": "app.js",
		"/styles.css": "styles.css",
		"/cytoscape.min.js": "cytoscape.min.js",
	};
	return map[pathname];
}

function contentType(fileName) {
	if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
	if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
	return "application/octet-stream";
}

function parseOptions(url, identity) {
	const types = parseCsv(url.searchParams.get("types"));
	const relations = parseCsv(url.searchParams.get("relations"));
	const requestedScope = asBoundedString(identity?.checkoutId, 240);
	const focus = url.searchParams.get("focus") || undefined;
	return {
		query: asBoundedString(url.searchParams.get("query"), MAX_QUERY_CHARS),
		focus: focus && safeNodeId(focus) ? focus : undefined,
		direction: ({ upstream: "outgoing", downstream: "incoming", incoming: "incoming", outgoing: "outgoing", both: "both" })[url.searchParams.get("direction")] || "both",
		offset: clampInt(url.searchParams.get("offset"), 0, 2_000_000, 0),
		hops: clampInt(url.searchParams.get("hops"), 0, 4, 1),
		limit: clampInt(url.searchParams.get("limit"), MIN_LIMIT, DEFAULT_LIMIT, DEFAULT_LIMIT),
		types: types?.includes("__none__") ? ["__none__"] : types?.filter(safeSlug),
		relations: relations?.includes("__none__") ? ["__none__"] : relations?.filter(safeSlug),
		includeInactive: url.searchParams.get("includeInactive") === "1",
		scope: requestedScope || undefined,
	};
}

function sanitizeHistory(history) {
	if (!Array.isArray(history)) return [];
	return history.slice(0, 50).map((item) => {
		if (!item || typeof item !== "object") return { label: String(item).slice(0, 240) };
		const safe = {};
		for (const key of ["id", "kind", "type", "event", "label", "subject", "predicate", "object", "revision", "createdAt", "observedAt", "sourceId", "scope", "at", "fromVersion", "toVersion"]) {
			if (item[key] === undefined) continue;
			safe[key] = typeof item[key] === "string" ? item[key].slice(0, 500) : item[key];
		}
		return safe;
	});
}

function sanitizeNode(node) {
	if (!node || typeof node !== "object") return null;
	return {
		id: asBoundedString(node.id, MAX_ID_CHARS),
		type: safeSlug(node.type) ? node.type : "other",
		label: asBoundedString(node.label ?? node.id, 600),
		key: asBoundedString(node.key, 512),
		status: asBoundedString(node.status, 80),
		confidence: typeof node.confidence === "number" ? Math.max(0, Math.min(1, node.confidence)) : undefined,
		provenance: Array.isArray(node.provenance) ? node.provenance.slice(0, 50).map((entry) => sanitizeProvenance(entry)) : [],
	};
}

function sanitizeProvenance(entry) {
	if (!entry || typeof entry !== "object") return { locator: String(entry).slice(0, 400) };
	return {
		sourceId: asBoundedString(entry.sourceId, 240),
		scope: asBoundedString(entry.scope, 240),
		kind: asBoundedString(entry.kind, 80),
		locator: asBoundedString(entry.locator, 800),
		observedAt: asBoundedString(entry.observedAt, 80),
		version: Number.isFinite(entry.version) ? entry.version : undefined,
		active: entry.active !== false,
		stale: entry.stale === true,
		expiresAt: entry.expiresAt,
	};
}

function safeFact(fact) {
	if (!fact || typeof fact !== "object") return null;
	return {
		subject: asBoundedString(fact.subject, MAX_ID_CHARS),
		conflict: fact.conflict === true,
		predicate: asBoundedString(fact.predicate, 160),
		object: asBoundedString(fact.object, 1_000),
		status: asBoundedString(fact.status, 80),
		confidence: typeof fact.confidence === "number" ? Math.max(0, Math.min(1, fact.confidence)) : undefined,
		provenance: Array.isArray(fact.provenance) ? fact.provenance.slice(0, 30).map(sanitizeProvenance) : [],
	};
}

function bodyReader(req) {
	return new Promise((resolve, reject) => {
		let bytes = 0;
		const chunks = [];
		let tooLarge = false;
		req.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) { tooLarge = true; return; }
			if (!tooLarge) chunks.push(chunk);
		});
		req.on("end", () => {
			if (tooLarge) reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}

async function runServer(args) {
	const statePath = path.resolve(String(args.state ?? ""));
	const dbPath = path.resolve(String(args.db ?? ""));
	if (!statePath || !dbPath || statePath === path.dirname(statePath) || !existsSync(statePath)) throw new Error("viewer state and database path are required");
	const state = await readState(statePath);
	const token = asBoundedString(state.token, 200);
	if (!token || token.length < 32) throw new Error("viewer state has no capability token");
	const identity = state.identity && typeof state.identity === "object" ? state.identity : {};
	const owner = asBoundedString(state.owner, 200) || `viewer-${process.pid}-${randomId(8)}`;
	const leaseName = asBoundedString(state.leaseName, 300) || `project-intelligence-viewer:${identity.id || randomId(8)}`;
	const { openStore, simplifyGraph } = await loadDataModules();
	const store = openStore(dbPath);
	if (!store || typeof store.claimLease !== "function") throw new Error("project intelligence store has no lease API");
	if (!store.claimLease(leaseName, owner, LEASE_TTL_MS)) {
		try { store.close?.(); } catch {}
		process.exitCode = 73;
		return;
	}

	const viewers = new Map();
	let focusEpoch = 0;
	let lastRequestAt = Date.now();
	let shuttingDown = false;
	let server;
	let listeningPort = 0;

	async function currentSnapshot(options = {}) {
		const snapshot = store.snapshot({ scope: options.scope, includeInactive: options.includeInactive === true });
		const graph = simplifyGraph(snapshot, {
				limit: options.limit,
				offset: options.offset,
				direction: options.direction,
				hops: options.hops,
				includeInactive: options.includeInactive,
				focus: options.focus,
				types: options.types,
				relations: options.relations,
				query: options.query,
				scope: options.scope,
		});
		return { ...normalizeGraph(graph, snapshot, identity, options),
			project: { ...snapshot.project, ...projectForResponse(identity) },
			discovery: store.getMeta?.(`discovery-stats:${identity.checkoutId}`) ?? null };
	}

	async function nodeDetails(nodeId, options = {}) {
		const snapshot = store.snapshot({ scope: options.scope, includeInactive: options.includeInactive === true });
		const rawNode = Array.isArray(snapshot.nodes) ? snapshot.nodes.find((node) => node.id === nodeId) : undefined;
		const allEdges = (snapshot.edges ?? []).filter(edge => edge.source === nodeId || edge.target === nodeId);
		const edges = allEdges.slice(0, 400);
		const allFacts = (snapshot.facts ?? []).filter(fact => fact.subject === nodeId);
		const facts = allFacts.slice(0, 400);
		const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
		// The store's compact node rows intentionally omit provenance. Reconstruct
		// the node evidence from the incident claims for the inspector while
		// retaining the complete provenance entries on those claims.
		const declarations = store.nodeSources(nodeId, options.scope).filter(source => options.includeInactive || source.active && !source.stale && (!source.expiresAt || Date.parse(source.expiresAt) > Date.now()));
		const provenance = declarations.map(source => sanitizeProvenance({ ...source, sourceId: source.id }));
		const provenanceKeys = new Set(provenance.map(source => `${source.sourceId}\u0000${source.version}\u0000${source.locator}`));
		for (const item of [...edges, ...facts]) {
			for (const entry of Array.isArray(item?.provenance) ? item.provenance : []) {
				const safe = sanitizeProvenance(entry);
				const key = `${safe.sourceId}\u0000${safe.version ?? ""}\u0000${safe.locator}`;
				if (!provenanceKeys.has(key)) {
					provenanceKeys.add(key);
					provenance.push(safe);
				}
				if (provenance.length >= 50) break;
			}
			if (provenance.length >= 50) break;
		}
		let history = [];
		try { history = sanitizeHistory(store.history?.({ limit: 20, scope: options.scope, sourceIds: [...provenanceKeys].map(key => key.split("\u0000")[0]) }) ?? []); } catch {}
		return {
			revision: snapshot.revision ?? store.revision?.() ?? 0,
			node: sanitizeNode(rawNode ? { ...rawNode, provenance } : rawNode),
			counts: { edges: allEdges.length, facts: allFacts.length },
			truncated: allEdges.length > edges.length || allFacts.length > facts.length,
			edges: edges.map((edge) => ({ id: asBoundedString(edge.id, MAX_ID_CHARS), source: edge.source, target: edge.target, sourceLabel: nodeById.get(edge.source)?.label ?? edge.source, targetLabel: nodeById.get(edge.target)?.label ?? edge.target, type: asBoundedString(edge.type, 120), status: asBoundedString(edge.status, 80), confidence: typeof edge.confidence === "number" ? Math.max(0, Math.min(1, edge.confidence)) : undefined, provenance: Array.isArray(edge.provenance) ? edge.provenance.slice(0, 20).map(sanitizeProvenance) : [] })),
			facts: facts.map(safeFact).filter(Boolean),
			health: snapshot.health ?? {},
			activity: Array.isArray(snapshot.activity) ? snapshot.activity.slice(0, 100) : [],
			history,
		};
	}

	async function persist(next) {
		await writeState(statePath, { ...state, ...next, pid: process.pid, port: listeningPort, owner, serverVersion: SERVER_VERSION });
	}

	async function closeServer(reason = "shutdown") {
		if (shuttingDown) return;
		shuttingDown = true;
		try { store.releaseLease?.(leaseName, owner); } catch {}
		try { store.close?.(); } catch {}
		try { await persist({ status: "stopped", pid: null, port: null, stoppedAt: new Date().toISOString(), stopReason: reason }); } catch {}
		if (server) await new Promise((resolve) => server.close(() => resolve()));
	}

	function auth(req, expectedOrigin) {
		const header = req.headers.authorization;
		if (typeof header !== "string" || !header.startsWith("Bearer ") || !sameSecret(header.slice(7), token)) return { status: 401, code: "UNAUTHORIZED", message: "A valid viewer capability is required" };
		const origin = requestOrigin(req);
		if (origin && origin !== expectedOrigin) return { status: 403, code: "BAD_ORIGIN", message: "Origin is not allowed for this viewer" };
		return null;
	}

	async function api(req, res, url) {
		lastRequestAt = Date.now();
		const expectedOrigin = `http://127.0.0.1:${listeningPort}`;
		const authError = auth(req, expectedOrigin);
		if (authError) {
			error(res, authError.status, authError.code, authError.message);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/health") {
			json(res, 200, { ok: true, serverVersion: SERVER_VERSION, pid: process.pid, port: listeningPort, revision: store.revision?.() ?? 0, viewers: viewers.size, focusEpoch });
			return;
		}
		if (req.method === "GET" && (url.pathname === "/api/bootstrap" || url.pathname === "/api/snapshot")) {
			const options = parseOptions(url, identity);
			const graph = await currentSnapshot(options);
			json(res, 200, { ...graph, project: graph.project ?? projectForResponse(identity), serverVersion: SERVER_VERSION, focusEpoch });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/poll") {
			const since = clampInt(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER, 0);
			const revision = Number(store.revision?.() ?? 0);
			if (revision <= since) {
				// Activity rows are intentionally allowed to change without a graph
				// revision. Return them as a side channel so the client can refresh the
				// activity rail without replacing stable node positions.
				let activity = [];
				try {
					const activitySnapshot = store.snapshot({ scope: identity.checkoutId, includeInactive: false });
					activity = Array.isArray(activitySnapshot?.activity) ? activitySnapshot.activity.slice(0, 100) : [];
				} catch {}
				json(res, 200, { changed: false, revision, activity, focusEpoch });
				return;
			}
			const graph = await currentSnapshot(parseOptions(url, identity));
			json(res, 200, { changed: true, ...graph, serverVersion: SERVER_VERSION, focusEpoch });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/node") {
			const id = url.searchParams.get("id") ?? "";
			if (!safeNodeId(id)) { error(res, 400, "INVALID_NODE", "Node id is missing or invalid"); return; }
			json(res, 200, await nodeDetails(id, parseOptions(url, identity)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/history") {
			const limit = clampInt(url.searchParams.get("limit"), 1, 50, 20);
			json(res, 200, { revision: store.revision?.() ?? 0, history: sanitizeHistory(store.history?.({ limit, scope: identity.checkoutId }) ?? []) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/focus") {
			focusEpoch = focusEpoch >= Number.MAX_SAFE_INTEGER ? 1 : focusEpoch + 1;
			json(res, 200, { ok: true, focusEpoch });
			return;
		}
		if (req.method === "POST" && (url.pathname === "/api/heartbeat" || url.pathname === "/api/viewer")) {
			let payload;
			try { payload = JSON.parse(await bodyReader(req)); } catch (bodyError) {
				error(res, bodyError?.code === "BODY_TOO_LARGE" ? 413 : 400, "INVALID_BODY", "Heartbeat body must be small JSON");
				return;
			}
			const clientId = asBoundedString(payload?.clientId, 160);
			if (!clientId || !/^[a-zA-Z0-9._:-]+$/.test(clientId)) { error(res, 400, "INVALID_CLIENT", "clientId is required"); return; }
			// A hidden tab is still a connected viewer that can be focused by a
			// later /graph request. Only an explicit unload signal removes it;
			// crashed pages are eventually removed by the TTL sweep below.
			if (payload?.closed === true) viewers.delete(clientId);
			else viewers.set(clientId, { seenAt: Date.now(), visible: payload?.visible !== false });
			json(res, 200, { ok: true, viewers: viewers.size, revision: store.revision?.() ?? 0 });
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "cache-control": "no-store" });
			res.end();
			return;
		}
		error(res, 404, "NOT_FOUND", "Viewer API route not found");
	}

	server = http.createServer(async (req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST" && req.method !== "OPTIONS") {
				error(res, 405, "METHOD_NOT_ALLOWED", "Only read-only viewer requests are supported");
				return;
			}
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${listeningPort || 1}`);
			if (isApiPath(url.pathname)) {
				await api(req, res, url);
				return;
			}
			const fileName = staticAsset(url.pathname);
			if (!fileName || req.method !== "GET" && req.method !== "HEAD") {
				error(res, 404, "NOT_FOUND", "Viewer asset not found");
				return;
			}
			const filePath = path.join(ASSETS, fileName);
			const content = await readFile(filePath);
			res.writeHead(200, {
				"content-type": contentType(fileName),
				"cache-control": fileName === "index.html" ? "no-store" : "public, max-age=3600, immutable",
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
				"referrer-policy": "no-referrer",
				"permissions-policy": "camera=(), microphone=(), geolocation=()",
			});
			if (req.method === "HEAD") res.end(); else res.end(content);
		} catch (requestError) {
			if (!res.headersSent) error(res, 500, "VIEWER_ERROR", "Viewer request failed");
			else res.destroy();
		}
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			listeningPort = server.address()?.port ?? 0;
			resolve();
		});
	});
	await persist({ status: "running", startedAt: state.startedAt ?? new Date().toISOString(), lastSeenAt: new Date().toISOString() });

	const leaseTimer = setInterval(async () => {
		if (shuttingDown) return;
		try {
			const renewed = store.renewLease?.(leaseName, owner, LEASE_TTL_MS);
			if (renewed === false) await closeServer("lease-lost");
		} catch {
			await closeServer("lease-error");
		}
	}, Math.max(5_000, Math.floor(LEASE_TTL_MS / 3)));
	leaseTimer.unref?.();
	const lifecycleTimer = setInterval(async () => {
		if (shuttingDown) return;
		const now = Date.now();
		for (const [id, viewer] of viewers) if (now - viewer.seenAt > VIEWER_TTL_MS) viewers.delete(id);
		if (!viewers.size && now - lastRequestAt > IDLE_GRACE_MS) await closeServer("idle");
	}, POLL_INTERVAL_MS);
	lifecycleTimer.unref?.();

	const signalHandler = () => { void closeServer("signal").finally(() => process.exit(0)); };
	process.once("SIGTERM", signalHandler);
	process.once("SIGINT", signalHandler);
	await new Promise(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseArgs(process.argv.slice(2));
	runServer(args).catch((errorValue) => {
		console.error(`[project-intelligence-viewer] ${errorValue?.message ?? errorValue}`);
		process.exitCode = 1;
	});
}

export {
	DEFAULT_LIMIT,
	IDLE_GRACE_MS,
	MAX_BODY_BYTES,
	MAX_QUERY_CHARS,
	normalizeGraph,
	parseArgs,
	parseOptions,
};
