/**
 * Harness/runtime provenance and normalized diagnostic export.
 *
 * Every diagnostic export carries stable provenance: Git SHA, core
 * identity/version, extension manifest hash, config fingerprint, models
 * registry revision, provider catalog timestamp, active feature flags, schema
 * versions, and local override fingerprints. A diagnostic can then never
 * describe behavior from an installed runtime that differs from the inspected
 * repository.
 *
 * Exports pair raw events with canonical normalized ledgers: children,
 * attempts, routes, failures, todos, skills, micro-intelligence, hooks, cost,
 * context, and reviews. Raw logs stay for forensics; debugging operates on
 * the normalized representation.
 *
 * Reviews are evidence consumers: quality_review, project review, bug hunter,
 * and council outputs point to concrete source/test/evidence ids and declare
 * stale/incomplete coverage. A review count is never a quality signal.
 *
 * Dependency-free except node:crypto/fs for provenance collection.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RuntimeProvenance {
	gitSha?: string;
	coreName?: string;
	coreVersion?: string;
	coreSourceDigest?: string;
	extensionManifestHash?: string;
	configFingerprint?: string;
	modelsRegistryRevision?: string;
	providerCatalogAt?: number;
	featureFlags: string[];
	schemaVersions: Record<string, string>;
	overrideFingerprints: Record<string, string>;
	collectedAt: number;
}

function hashFile(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 32);
	} catch {
		return undefined;
	}
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export interface ProvenancePaths {
	repoRoot?: string;
	agentDir?: string;
}

/** Collect stable runtime provenance. Missing inputs stay missing — never guessed. */
export function collectRuntimeProvenance(paths: ProvenancePaths = {}): RuntimeProvenance {
	const repoRoot = paths.repoRoot;
	const agentDir = paths.agentDir ?? process.env.PI_CODING_AGENT_DIR;
	const provenance: RuntimeProvenance = {
		featureFlags: [],
		schemaVersions: {
			"execution-evidence": "v1",
			"child-ledger": "v1",
			"route-decision": "v1",
			"failure-cause": "v1",
			"cost-states": "v1",
		},
		overrideFingerprints: {},
		collectedAt: Date.now(),
	};
	if (repoRoot) {
		try {
			const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim();
			const match = /^ref: (.+)$/.exec(head);
			if (match) {
				const sha = fs.readFileSync(path.join(repoRoot, ".git", match[1]!), "utf8").trim();
				if (/^[a-f0-9]{40}$/.test(sha)) provenance.gitSha = sha;
			} else if (/^[a-f0-9]{40}$/.test(head)) {
				provenance.gitSha = head;
			}
		} catch {
			// Non-git installs (live tree) leave gitSha missing, not invented.
		}
		const identity = readJson(path.join(repoRoot, "core", "identity.json"));
		if (typeof identity?.name === "string") provenance.coreName = identity.name.slice(0, 80);
		if (typeof identity?.version === "string") provenance.coreVersion = identity.version.slice(0, 32);
		const build = readJson(path.join(repoRoot, "core", "build.json"));
		if (typeof build?.sourceDigest === "string") provenance.coreSourceDigest = build.sourceDigest.slice(0, 64);
		const manifestHash = hashFile(path.join(repoRoot, "agent", "extensions", "manifest.json"));
		if (manifestHash) provenance.extensionManifestHash = manifestHash;
	}
	if (agentDir) {
		const fingerprintParts: string[] = [];
		for (const file of ["settings.json", "models.json"]) {
			const hash = hashFile(path.join(agentDir, file));
			if (hash) {
				fingerprintParts.push(`${file}:${hash}`);
				provenance.overrideFingerprints[file] = hash;
			}
		}
		if (fingerprintParts.length) {
			provenance.configFingerprint = createHash("sha256").update(fingerprintParts.join("\n")).digest("hex").slice(0, 32);
		}
		const catalog = readJson(path.join(agentDir, "live-model-catalog.json"));
		const catalogAt = catalog?.fetchedAt ?? catalog?.asOf;
		if (typeof catalogAt === "number" && Number.isFinite(catalogAt)) provenance.providerCatalogAt = catalogAt;
		const registry = readJson(path.join(agentDir, "models-store.json"));
		if (typeof registry?.revision === "string") provenance.modelsRegistryRevision = registry.revision.slice(0, 64);
	}
	for (const [flag, name] of [
		["PI_LOCAL_INTELLIGENCE", "local-intelligence"],
		["PI_SUBAGENT_CHILD", "subagent-child"],
	] as const) {
		const value = process.env[flag];
		if (value !== undefined) provenance.featureFlags.push(`${name}=${String(value).slice(0, 32)}`);
	}
	return provenance;
}

export interface ReviewRecord {
	id: string;
	kind: "quality_review" | "project-review" | "bug-hunter" | "council" | string;
	/** Concrete source/test/evidence ids the review consumed. */
	evidenceIds: string[];
	coverage: "complete" | "partial" | "stale" | "incomplete" | "unknown";
	verdict?: string;
	at?: number;
}

export function buildReviewRecord(input: {
	id: string;
	kind?: string;
	evidenceIds?: string[];
	coverage?: ReviewRecord["coverage"];
	verdict?: string;
	at?: number;
}): ReviewRecord {
	return {
		id: String(input.id).slice(0, 160),
		kind: (input.kind ?? "quality_review").slice(0, 64),
		evidenceIds: (input.evidenceIds ?? []).filter((id): id is string => typeof id === "string").map((id) => id.slice(0, 200)).slice(0, 128),
		coverage: input.coverage ?? "unknown",
		...(input.verdict ? { verdict: String(input.verdict).slice(0, 280) } : {}),
		...(input.at === undefined ? {} : { at: input.at }),
	};
}

export interface NormalizedExport {
	version: 1;
	provenance: RuntimeProvenance;
	/** Normalized sections; each is owned by its canonical reducer. */
	sections: {
		children?: unknown;
		attempts?: unknown;
		routes?: unknown;
		failures?: unknown;
		todos?: unknown;
		skills?: unknown;
		microIntel?: unknown;
		hooks?: unknown;
		cost?: unknown;
		context?: unknown;
		reviews?: unknown;
	};
	/** Raw events stay available for forensic detail. */
	raw?: unknown;
	/** Counts are activity evidence, never quality metrics. */
	disclaimer: string;
}

export function buildNormalizedExport(input: {
	provenance: RuntimeProvenance;
	sections?: NormalizedExport["sections"];
	raw?: unknown;
}): NormalizedExport {
	return {
		version: 1,
		provenance: input.provenance,
		sections: input.sections ?? {},
		...(input.raw === undefined ? {} : { raw: input.raw }),
		disclaimer: "Counts describe activity, not quality. Tool/skill/hook/child/review counts are evidence about what ran — never quality metrics.",
	};
}
