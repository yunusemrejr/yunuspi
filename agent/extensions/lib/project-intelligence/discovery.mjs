/*
 * Bounded, read-only project discovery.
 *
 * This module deliberately stops at structural evidence.  It does not run
 * project commands, load environment values, contact remotes, or write the
 * project / repository.  The caller owns persistence and applies the returned
 * sources with the expectedVersion CAS values supplied here.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { nodeId } from './store.mjs';
import {
  isConfigPath,
  isDeploymentPath,
  isDiscoverablePath,
  isDocPath,
  isGeneratedPath,
  isManifestPath,
  isProtectedPath,
  isSourcePath,
  isTemplateEnvPath,
  parseCode,
  parseApiSpec,
  parseDeployment,
  parseDoc,
  parseEnvTemplate,
  parseManifest,
  redactRemote,
} from './discovery-parsers.mjs';

const execFile = promisify(execFileCallback);

// These limits keep a first scan useful on ordinary projects without making a
// large monorepo turn into an accidental indexer.  They are also returned in
// stats so callers can explain a partial result.
const LIMITS = Object.freeze({
  maxFiles: 1800,
  maxEntriesPerDirectory: 512,
  maxDepth: 18,
  maxFileBytes: 96 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxSources: 640,
  maxNodesPerSource: 320,
  maxClaimsPerSource: 720,
  maxGitOutputBytes: 128 * 1024,
  maxGitHistoryCommits: 12,
  maxGitBranches: 256,
  maxGitRemotes: 32,
  // store.setMeta has a 128KiB quota. Leave room for the file index, Git
  // stamp, and JSON framing so the worker can persist this cache atomically.
  maxCacheBytes: 80 * 1024,
  maxMetadataBytes: 112 * 1024,
  maxLabel: 220,
  maxLiteral: 420,
});

const SOURCE_SCHEMA_VERSION = 2;
// Metadata v2 replaces the old full source payload cache with compact,
// compressed indexes.  The store remains authoritative for graph payloads;
// this version only helps discovery decide which files need reparsing.
const METADATA_SCHEMA_VERSION = 2;
const COMPACT_INDEX_ENCODING = 'br-json-v1';
const KNOWN_IMPORT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.php'];

function abortIfNeeded(signal) {
  signal?.throwIfAborted();
}

function bounded(value, max = LIMITS.maxLiteral) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeLabel(value, fallback = 'unnamed') {
  return bounded(value, LIMITS.maxLabel) || fallback;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourceId(scope, locator) {
  return `src_${sha256(`${bounded(scope, 180)}\0${bounded(locator, 260)}`).slice(0, 32)}`;
}

function statSignature(stat) {
  if (!stat) return null;
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: Number(stat.size) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
    ctimeMs: Number(stat.ctimeMs) || 0,
  };
}

function sameStat(a, b) {
  return Boolean(a && b && Number(a.dev) === Number(b.dev) && Number(a.ino) === Number(b.ino) && Number(a.size) === Number(b.size) && Number(a.mtimeMs) === Number(b.mtimeMs) && Number(a.ctimeMs) === Number(b.ctimeMs));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function statTuple(stat) {
  const value = statSignature(stat);
  return value ? [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs] : null;
}

function statFromTuple(value) {
  if (!Array.isArray(value) || value.length < 5) return null;
  const numbers = value.slice(0, 5).map(Number);
  if (numbers.some(number => !Number.isFinite(number))) return null;
  return statSignature({ dev: numbers[0], ino: numbers[1], size: numbers[2], mtimeMs: numbers[3], ctimeMs: numbers[4] });
}

function encodeCompactIndex(value) {
  let json;
  try {
    json = JSON.stringify(value);
    if (typeof json !== 'string') return {};
    return {
      encoding: COMPACT_INDEX_ENCODING,
      data: brotliCompressSync(Buffer.from(json)).toString('base64'),
    };
  } catch {
    // The index only contains bounded primitives.  A failed compression is
    // still safer as an empty cache than as a full source-payload fallback.
    return {};
  }
}

function decodeCompactIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.encoding !== COMPACT_INDEX_ENCODING || typeof value.data !== 'string') return value;
  try {
    const compressed = Buffer.from(value.data, 'base64');
    // Metadata itself is quota bounded, but a corrupt/adversarial Brotli blob
    // must not be allowed to inflate without a bound.
    if (!compressed.length || compressed.length > LIMITS.maxMetadataBytes) return null;
    const decoded = brotliDecompressSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
    if (decoded.length > 4 * 1024 * 1024) return null;
    return JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
}

function decodeEntryIndex(raw) {
  const value = decodeCompactIndex(raw);
  const entries = {};
  if (Array.isArray(value)) {
    for (const record of value.slice(0, LIMITS.maxFiles * 2)) {
      if (!Array.isArray(record) || typeof record[0] !== 'string') continue;
      const relativePath = bounded(record[0], 320);
      if (!relativePath || entries[relativePath]) continue;
      entries[relativePath] = {
        sourceId: typeof record[5] === 'string' ? bounded(record[5], 180) : '',
        contentHash: typeof record[1] === 'string' ? bounded(record[1], 128) : '',
        fingerprint: typeof record[2] === 'string' ? bounded(record[2], 128) : '',
        category: typeof record[3] === 'string' ? bounded(record[3], 80) : 'source',
        stat: statFromTuple(record[4]),
      };
    }
    return entries;
  }
  for (const [relative, rawEntry] of Object.entries(asObject(value))) {
    if (Object.keys(entries).length >= LIMITS.maxFiles * 2) break;
    const relativePath = bounded(relative, 320);
    const entry = asObject(rawEntry);
    if (!relativePath || entries[relativePath]) continue;
    entries[relativePath] = {
      sourceId: typeof entry.sourceId === 'string' ? bounded(entry.sourceId, 180) : '',
      contentHash: typeof entry.contentHash === 'string' ? bounded(entry.contentHash, 128) : '',
      fingerprint: typeof entry.fingerprint === 'string' ? bounded(entry.fingerprint, 128) : '',
      category: typeof entry.category === 'string' ? bounded(entry.category, 80) : 'source',
      stat: statSignature(entry.stat),
    };
  }
  return entries;
}

function encodeEntryIndex(entries) {
  const records = Object.entries(entries ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, LIMITS.maxFiles * 2)
    .map(([relativePath, entry]) => [
      relativePath,
      bounded(entry?.contentHash, 128),
      bounded(entry?.fingerprint, 128),
      bounded(entry?.category ?? 'source', 80),
      statTuple(entry?.stat),
    ]);
  return encodeCompactIndex(records);
}

function decodeDirectoryIndex(raw) {
  const value = decodeCompactIndex(raw);
  const directories = {};
  if (Array.isArray(value)) {
    for (const record of value.slice(0, LIMITS.maxFiles * 2)) {
      const relativePath = bounded(Array.isArray(record) ? record[0] : record, 320);
      if (relativePath && !directories[relativePath]) directories[relativePath] = statFromTuple(Array.isArray(record) ? record[1] : null);
    }
    return directories;
  }
  for (const [relative, rawStat] of Object.entries(asObject(value))) {
    if (Object.keys(directories).length >= LIMITS.maxFiles * 2) break;
    const relativePath = bounded(relative, 320);
    if (relativePath && !directories[relativePath]) directories[relativePath] = statSignature(rawStat);
  }
  return directories;
}

function encodeDirectoryIndex(directories) {
  const records = Object.entries(directories ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, LIMITS.maxFiles * 2)
    .map(([relativePath, stat]) => [relativePath, statTuple(stat)]);
  return encodeCompactIndex(records);
}

function normalizePrevious(previousSources) {
  const map = new Map();
  if (!Array.isArray(previousSources)) return map;
  for (const source of previousSources) {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string') continue;
    map.set(source.id, source);
  }
  return map;
}

function previousSourceUsable(source) {
  return Boolean(source && source.active !== false && source.stale !== true);
}

function expectedVersionFor(previous) {
  const value = previous?.version ?? previous?.expectedVersion ?? 0;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function createNodeFactory(projectKey) {
  const node = (type, key, label) => {
    const boundedKey = bounded(key, 480);
    const boundedLabel = safeLabel(label, boundedKey || type);
    return { id: nodeId(type, boundedKey), type, label: boundedLabel, key: boundedKey };
  };
  return {
    project: node('project', projectKey, projectKey),
    node,
  };
}

function claim(subject, predicate, object, options = {}) {
  const relation = Boolean(options.relation);
  const value = relation ? bounded(object, 160) : bounded(object, LIMITS.maxLiteral);
  if (!subject || !predicate || !value) return null;
  return {
    subject,
    predicate: bounded(predicate, 120),
    object: value,
    relation,
    status: ['verified', 'inferred', 'assumed', 'historical', 'temporary'].includes(options.status) ? options.status : 'inferred',
    confidence: Math.max(0, Math.min(1, Number.isFinite(options.confidence) ? options.confidence : relation ? 0.7 : 0.65)),
    ...(options.exclusive ? { exclusive: true } : {}),
  };
}

function isSensitiveLiteral(value) {
  return /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization|bearer)\s*[:=]/i.test(String(value));
}

function scrubHistorySubject(value) {
  let text = bounded(value, 180);
  if (/(?:secret|password|passwd|credential|private\s+key|api[_ -]?key|access[_ -]?token)/i.test(text)) return '[commit subject omitted]';
  text = text.replace(/(?:https?|ssh|git):\/\/[^\s]+/gi, '[url]');
  text = text.replace(/(?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
  return isSensitiveLiteral(text) ? '[commit subject omitted]' : text;
}

function scrubSafeValue(value) {
  const text = bounded(value, 220);
  if (!text || isSensitiveLiteral(text)) return '';
  if (/^(?:https?|ssh|git):\/\//i.test(text)) return redactRemote(text).value;
  return text;
}

function fileKey(projectKey, relativePath) {
  // Files and directories use the workspace-relative path as their canonical
  // key.  This converges with worker session-change evidence and user facts;
  // project isolation already comes from the per-project SQLite database.
  return relativePath;
}

function directoryKey(projectKey, relativePath) {
  return relativePath || '.';
}

function dependencyKey(projectKey, name) {
  return `${projectKey}:dependency:${name}`;
}

function relativePathFor(root, candidate) {
  const raw = String(candidate ?? '').replaceAll('\\', '/');
  if (!raw || raw === '.') return '';
  const resolved = path.resolve(root, raw);
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  if (!relative || relative === '.') return '';
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function absolutePathFor(root, relative) {
  const resolved = path.resolve(root, relative);
  const check = path.relative(root, resolved);
  if (check === '..' || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) return null;
  return resolved;
}

async function lstatRegular(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) return { stat, symlink: true };
    return { stat, symlink: false };
  } catch (error) {
    return { missing: error?.code === 'ENOENT' || error?.code === 'ENOTDIR', error };
  }
}

async function readBounded(candidate, stat, signal) {
  abortIfNeeded(signal);
  if (!stat?.isFile?.() || stat.size > LIMITS.maxFileBytes) return { text: null, tooLarge: Boolean(stat?.size > LIMITS.maxFileBytes), bytes: 0 };
  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const nonBlock = fsConstants.O_NONBLOCK ?? 0;
    handle = await fs.open(candidate, fsConstants.O_RDONLY | noFollow | nonBlock);
    const freshStat = await handle.stat();
    if (!freshStat.isFile() || freshStat.size > LIMITS.maxFileBytes) return { text: null, tooLarge: true, bytes: 0 };
    const buffer = Buffer.alloc(Math.min(LIMITS.maxFileBytes + 1, freshStat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      abortIfNeeded(signal);
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > LIMITS.maxFileBytes) return { text: null, tooLarge: true, bytes: offset };
    // A NUL byte is a useful binary guard even for an unrecognised extension.
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return { text: null, binary: true, bytes: offset };
    return { text: bytes.toString('utf8'), bytes: offset, stat: freshStat };
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EACCES' || error?.code === 'EPERM') return { text: null, unreadable: true, bytes: 0 };
    if (error?.name === 'AbortError') throw error;
    return { text: null, unreadable: true, bytes: 0 };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function collectWorkspace(root, options, stats) {
  const signal = options.signal;
  const explicit = Array.isArray(options.paths) ? options.paths : options.paths ? [options.paths] : [];
  const targets = explicit.length ? explicit.map(value => relativePathFor(root, value)).filter(value => value !== null) : [''];
  const files = new Map();
  const directories = new Map();
  const missingExplicit = [];
  const visitedDirectories = new Set();
  // A caller-supplied path list is an intentional partial scan.  It may still
  // justify withdrawing a source whose exact path is missing, but it can never
  // justify declaring unrelated old files deleted.
  let coverageComplete = explicit.length === 0;

  const addDirectory = (relative, stat) => {
    if (!relative || directories.has(relative)) return;
    directories.set(relative, statSignature(stat));
  };

  const visit = async (relative, depth) => {
    abortIfNeeded(signal);
    if (depth > LIMITS.maxDepth) { stats.truncated = true; coverageComplete = false; return; }
    const absolute = absolutePathFor(root, relative);
    if (!absolute) { stats.truncated = true; coverageComplete = false; return; }
    const result = await lstatRegular(absolute);
    if (result.missing) {
      if (targets.includes(relative)) missingExplicit.push(relative);
      if (!relative) {
        stats.workspaceUnavailable = true;
        coverageComplete = false;
      }
      return;
    }
    if (result.symlink) { stats.symlinksSkipped++; return; }
    if (result.stat.isDirectory()) {
      const base = relative.split('/').at(-1) ?? '';
      if (relative && (isGeneratedPath(relative) || base === '.git')) { stats.generatedDirectoriesSkipped++; return; }
      if (relative) addDirectory(relative, result.stat);
      if (visitedDirectories.has(relative)) return;
      visitedDirectories.add(relative);
      stats.directoriesVisited++;
      let entries = [];
      try {
        const dir = await fs.opendir(absolute);
        for await (const entry of dir) {
          abortIfNeeded(signal);
          entries.push(entry);
          if (entries.length >= LIMITS.maxEntriesPerDirectory) { stats.truncated = true; coverageComplete = false; break; }
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        stats.unreadableDirectories++;
        coverageComplete = false;
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        abortIfNeeded(signal);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(childRelative, depth + 1);
        else if (entry.isFile()) await visit(childRelative, depth + 1);
        if (files.size >= LIMITS.maxFiles) { stats.truncated = true; coverageComplete = false; break; }
      }
      return;
    }
    if (!result.stat.isFile()) return;
    stats.filesSeen++;
    if (isProtectedPath(relative)) { stats.protectedFilesSkipped++; return; }
    if (isGeneratedPath(relative) || !isDiscoverablePath(relative)) return;
    files.set(relative, { absolute, stat: result.stat });
  };

  try {
    for (const target of targets) {
      abortIfNeeded(signal);
      await visit(target, 0);
      if (files.size >= LIMITS.maxFiles) break;
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // A missing root is a valid transient state while a checkout is being
    // moved.  Return the project source and a partial scan instead of failing.
    stats.workspaceUnavailable = true;
    coverageComplete = false;
  }
  return { files, directories, missingExplicit, coverageComplete: coverageComplete && !stats.truncated };
}

function makeSource({ id, scope, kind, locator, fingerprint, nodes, claims, previous, observedAt }) {
  const uniqueNodes = new Map();
  for (const value of nodes ?? []) if (value?.id && !uniqueNodes.has(value.id)) uniqueNodes.set(value.id, value);
  const uniqueClaims = new Map();
  for (const value of claims ?? []) {
    if (!value?.subject || !value?.predicate || !value?.object) continue;
    const key = canonical(value);
    if (!uniqueClaims.has(key)) uniqueClaims.set(key, value);
  }
  return {
    id,
    scope,
    kind,
    locator: bounded(locator, 320),
    fingerprint,
    observedAt,
    complete: true,
    nodes: [...uniqueNodes.values()].slice(0, LIMITS.maxNodesPerSource),
    claims: [...uniqueClaims.values()].slice(0, LIMITS.maxClaimsPerSource),
    expectedVersion: expectedVersionFor(previous),
  };
}

function sourceFingerprint(payload) {
  return sha256(canonical(payload));
}

function cacheSourceFor(source, cache) {
  if (!cache || typeof cache !== 'object') return null;
  const value = cache[source.id];
  return value && typeof value === 'object' && value.fingerprint === source.fingerprint ? cloneJson(value) : null;
}

function sourceWithVersion(source, previous, cache, force, now) {
  const previousVersion = expectedVersionFor(previous);
  const cached = !force ? cacheSourceFor(source, cache) : null;
  const value = cached ?? source;
  const unchanged = !force && previous?.fingerprint === source.fingerprint;
  return {
    ...value,
    id: source.id,
    scope: source.scope,
    kind: source.kind,
    locator: source.locator,
    fingerprint: source.fingerprint,
    // Store summaries intentionally omit graph payloads.  When the
    // fingerprint still matches, retain the original observation timestamp
    // even if this call has no full payload cache to copy.
    observedAt: unchanged ? (previous.observedAt ?? cached?.observedAt ?? source.observedAt ?? now) : (cached?.observedAt ?? source.observedAt ?? now),
    nodes: cloneJson(value.nodes) ?? [],
    claims: cloneJson(value.claims) ?? [],
    expectedVersion: previousVersion,
  };
}

function buildEvidence(identity, root, relativePath, text, contentHash, context) {
  const projectKey = String(identity.id ?? root);
  const factory = createNodeFactory(projectKey);
  const projectNode = factory.project;
  const fileNode = factory.node('file', fileKey(projectKey, relativePath), relativePath);
  const nodes = new Map([[projectNode.id, projectNode], [fileNode.id, fileNode]]);
  const claims = [];
  const addNode = (type, key, label) => {
    const value = factory.node(type, key, label);
    if (!nodes.has(value.id)) nodes.set(value.id, value);
    return value;
  };
  const addClaim = (subject, predicate, object, options = {}) => {
    const value = claim(subject, predicate, object, options);
    if (value) claims.push(value);
  };
  const dirParts = relativePath.split('/');
  dirParts.pop();
  let parent = '';
  for (const part of dirParts) {
    parent = parent ? `${parent}/${part}` : part;
    const directory = addNode('directory', directoryKey(projectKey, parent), parent);
    addClaim(projectNode.id, 'contains', directory.id, { relation: true, status: 'verified', confidence: 0.97 });
    addClaim(directory.id, 'contains', fileNode.id, { relation: true, status: 'verified', confidence: 0.96 });
  }
  addClaim(projectNode.id, 'contains', fileNode.id, { relation: true, status: 'verified', confidence: 0.98 });
  addClaim(fileNode.id, 'path', relativePath, { status: 'verified', confidence: 1 });
  const base = relativePath.split('/').at(-1)?.toLowerCase() ?? '';
  const ext = path.extname(base);
  if (ext) addClaim(fileNode.id, 'extension', ext, { status: 'verified', confidence: 1 });
  if (isManifestPath(relativePath)) addClaim(fileNode.id, 'role', 'manifest', { status: 'verified', confidence: 0.98 });
  if (isDocPath(relativePath)) addClaim(fileNode.id, 'role', 'documentation', { status: 'verified', confidence: 0.98 });
  if (isDeploymentPath(relativePath)) addClaim(fileNode.id, 'role', 'deployment or CI configuration', { status: 'verified', confidence: 0.86 });
  if (isTemplateEnvPath(relativePath)) addClaim(fileNode.id, 'role', 'environment template', { status: 'verified', confidence: 1 });

  const resolveLocal = specifier => {
    const raw = bounded(specifier, 240).replaceAll('\\', '/');
    if (!raw || (!raw.startsWith('.') && !raw.startsWith('/'))) return null;
    const candidate = raw.startsWith('/') ? raw.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), raw));
    if (!candidate || candidate === '..' || candidate.startsWith('../')) return null;
    const candidates = [candidate];
    if (!path.posix.extname(candidate)) for (const suffix of KNOWN_IMPORT_EXTENSIONS) candidates.push(candidate + suffix, `${candidate}/index${suffix}`);
    return candidates.find(value => context.knownFiles.has(value)) ?? null;
  };

  let parsed = {};
  let category = 'source';
  if (isTemplateEnvPath(relativePath)) {
    category = 'environment';
    const variables = parseEnvTemplate(text);
    for (const name of variables) {
      const variable = addNode('configuration', `${projectKey}:environment-variable:${name}`, name);
      addClaim(fileNode.id, 'declares', variable.id, { relation: true, status: 'verified', confidence: 1 });
      addClaim(variable.id, 'name', name, { status: 'verified', confidence: 1, exclusive: true });
    }
  } else if (isDocPath(relativePath)) {
    category = 'documentation';
    parsed = parseDoc(relativePath, text);
    for (const heading of parsed.headings ?? []) {
      const feature = addNode('feature', `${projectKey}:document-heading:${relativePath}:${heading}`, heading);
      addClaim(fileNode.id, 'mentions', feature.id, { relation: true, status: 'inferred', confidence: 0.64 });
    }
    if (parsed.purpose) addClaim(projectNode.id, 'purpose', `Documentation heading: ${parsed.purpose}`, { status: 'inferred', confidence: 0.72 });
    for (const link of parsed.links ?? []) {
      const local = resolveLocal(link);
      if (local) {
        const target = addNode('file', fileKey(projectKey, local), local);
        addClaim(fileNode.id, 'references', target.id, { relation: true, status: 'inferred', confidence: 0.78 });
      } else if (/^(?:https?|mailto):/i.test(link)) {
        const safe = redactRemote(link);
        if (safe.host) {
          const external = addNode('external', `${projectKey}:doc-link:${safe.host}`, safe.host);
          addClaim(fileNode.id, 'references', external.id, { relation: true, status: 'inferred', confidence: 0.66 });
        }
      }
    }
  } else if (isDeploymentPath(relativePath)) {
    category = 'deployment';
    parsed = parseDeployment(relativePath, text);
    const pipeline = addNode('pipeline', `${projectKey}:pipeline:${relativePath}`, parsed.platform ? `${parsed.platform} configuration` : `${relativePath} pipeline`);
    addClaim(projectNode.id, 'hasPipeline', pipeline.id, { relation: true, status: 'verified', confidence: 0.9 });
    addClaim(pipeline.id, 'configuredIn', fileNode.id, { relation: true, status: 'verified', confidence: 1 });
    if (parsed.platform) {
      const infrastructure = addNode('infrastructure', `${projectKey}:infrastructure:${parsed.platform}`, parsed.platform);
      addClaim(pipeline.id, 'targets', infrastructure.id, { relation: true, status: 'verified', confidence: 0.84 });
      addClaim(infrastructure.id, 'platform', parsed.platform, { status: 'verified', confidence: 0.84 });
    }
    for (const action of parsed.actions ?? []) {
      const actionNode = addNode('external', `${projectKey}:deployment-action:${action}`, action);
      addClaim(pipeline.id, 'uses', actionNode.id, { relation: true, status: 'verified', confidence: 0.82 });
    }
    for (const envName of parsed.environments ?? []) {
      const environment = addNode('environment', `${projectKey}:environment:${envName}`, envName);
      addClaim(pipeline.id, 'configures', environment.id, { relation: true, status: 'verified', confidence: 0.8 });
      if (/^[A-Z][A-Z0-9_]{1,119}$/.test(envName)) {
        const variable = addNode('configuration', `${projectKey}:environment-variable:${envName}`, envName);
        addClaim(environment.id, 'declares', variable.id, { relation: true, status: 'verified', confidence: 0.9 });
      }
    }
    for (const value of parsed.safeValues ?? []) {
      const safe = scrubSafeValue(value.value);
      if (safe) addClaim(pipeline.id, bounded(value.key, 120), safe, { status: 'verified', confidence: 0.78 });
    }
    for (const key of parsed.keys ?? []) {
      const configuration = addNode('configuration', `${projectKey}:configuration:${relativePath}:${key}`, key);
      addClaim(fileNode.id, 'defines', configuration.id, { relation: true, status: 'verified', confidence: 0.74 });
    }
  } else if (isManifestPath(relativePath) || isConfigPath(relativePath)) {
    category = isManifestPath(relativePath) ? 'manifest' : 'configuration';
    parsed = parseManifest(relativePath, text);
    if (/(?:^|\/)(?:openapi|swagger)\.(?:json|yaml|yml)$/i.test(relativePath)) parsed = { ...parsed, ...parseApiSpec(text) };
    const fields = parsed.fields ?? {};
    // A monorepo may contain many package manifests.  Qualify manifest-level
    // literals so a child package name never becomes a false project-level
    // exclusive conflict with the identity's directory name.
    if (fields.name) addClaim(projectNode.id, 'packageName', fields.name, { status: 'verified', confidence: 0.92 });
    if (fields.private) addClaim(projectNode.id, 'packagePrivate', fields.private, { status: 'verified', confidence: 0.92 });
    if (fields.packageManager) addClaim(projectNode.id, 'packageManager', fields.packageManager, { status: 'verified', confidence: 0.9 });
    if (fields.module) addClaim(projectNode.id, 'modulePath', fields.module, { status: 'verified', confidence: 0.9 });
    if (fields.type) addClaim(fileNode.id, 'moduleType', fields.type, { status: 'verified', confidence: 0.9 });
    for (const key of parsed.keys ?? []) {
      const configuration = addNode('configuration', `${projectKey}:configuration:${relativePath}:${key}`, key);
      addClaim(fileNode.id, 'defines', configuration.id, { relation: true, status: 'verified', confidence: 0.74 });
    }
    for (const dependency of parsed.dependencies ?? []) {
      if (!dependency?.name) continue;
      const dependencyNode = addNode('dependency', dependencyKey(projectKey, dependency.name), dependency.name);
      addClaim(projectNode.id, 'uses', dependencyNode.id, { relation: true, status: 'verified', confidence: 0.94 });
      addClaim(fileNode.id, 'declares', dependencyNode.id, { relation: true, status: 'verified', confidence: 0.98 });
      if (dependency.version) addClaim(dependencyNode.id, 'requestedVersion', dependency.version, { status: 'verified', confidence: 0.9 });
      if (dependency.section) addClaim(dependencyNode.id, 'dependencyScope', dependency.section, { status: 'verified', confidence: 0.88 });
    }
    for (const framework of parsed.frameworks ?? []) {
      const frameworkNode = addNode('component', `${projectKey}:framework:${framework.name}`, framework.name);
      addClaim(projectNode.id, 'usesFramework', frameworkNode.id, { relation: true, status: 'verified', confidence: 0.91 });
      if (framework.package) {
        const dependencyNode = addNode('dependency', dependencyKey(projectKey, framework.package), framework.package);
        addClaim(dependencyNode.id, 'provides', frameworkNode.id, { relation: true, status: 'verified', confidence: 0.9 });
      }
    }
    for (const script of parsed.scripts ?? []) {
      const pipeline = addNode('pipeline', `${projectKey}:script:${relativePath}:${script}`, script);
      addClaim(fileNode.id, 'defines', pipeline.id, { relation: true, status: 'verified', confidence: 0.9 });
      addClaim(pipeline.id, 'name', script, { status: 'verified', confidence: 0.9 });
    }
    for (const workspace of parsed.workspaces ?? []) addClaim(projectNode.id, 'workspacePattern', workspace, { status: 'verified', confidence: 0.92 });
    for (const engine of parsed.engines ?? []) addClaim(projectNode.id, 'declaresRuntime', engine, { status: 'verified', confidence: 0.86 });
    for (const api of parsed.apis ?? []) {
      const apiNode = addNode('api', `${projectKey}:api:${api.method}:${api.route}`, `${api.method} ${api.route}`);
      addClaim(fileNode.id, 'defines', apiNode.id, { relation: true, status: 'verified', confidence: 0.9 });
      addClaim(apiNode.id, 'method', api.method, { status: 'verified', confidence: 0.9 });
      addClaim(apiNode.id, 'route', api.route, { status: 'verified', confidence: 0.9 });
    }
  } else if (isSourcePath(relativePath) || /(?:^|\/)(?:migrations?|schemas?|schema)\//i.test(relativePath) || /\.(?:sql|graphql|gql)$/i.test(relativePath)) {
    parsed = parseCode(relativePath, text);
    for (const item of parsed.imports ?? []) {
      const local = resolveLocal(item.specifier);
      if (local) {
        const target = addNode('file', fileKey(projectKey, local), local);
        addClaim(fileNode.id, 'imports', target.id, { relation: true, status: 'inferred', confidence: 0.84 });
      } else {
        const bare = item.specifier.replace(/^node:/, '').split('/').slice(0, item.specifier.startsWith('@') ? 2 : 1).join('/');
        if (/^[A-Za-z0-9@_.-][A-Za-z0-9@_.+:/-]{0,158}$/.test(bare) && !bare.startsWith('.')) {
          const dependency = addNode('dependency', dependencyKey(projectKey, bare), bare);
          addClaim(fileNode.id, 'imports', dependency.id, { relation: true, status: 'inferred', confidence: 0.62 });
        }
      }
    }
    for (const api of parsed.apis ?? []) {
      const apiNode = addNode('api', `${projectKey}:api:${api.method}:${api.route}`, `${api.method} ${api.route}`);
      addClaim(fileNode.id, 'exposes', apiNode.id, { relation: true, status: 'inferred', confidence: 0.72 });
      addClaim(apiNode.id, 'method', api.method, { status: 'inferred', confidence: 0.72 });
      addClaim(apiNode.id, 'route', api.route, { status: 'inferred', confidence: 0.72 });
    }
    for (const table of parsed.tables ?? []) {
      const database = addNode('database', `${projectKey}:database:local`, 'Local or configured database');
      const tableNode = addNode('table', `${projectKey}:table:${table.name}`, table.name);
      addClaim(projectNode.id, 'contains', database.id, { relation: true, status: 'inferred', confidence: 0.58 });
      addClaim(fileNode.id, 'defines', tableNode.id, { relation: true, status: /\.sql$/i.test(relativePath) ? 'verified' : 'inferred', confidence: /\.sql$/i.test(relativePath) ? 0.9 : 0.65 });
      addClaim(database.id, 'contains', tableNode.id, { relation: true, status: 'inferred', confidence: 0.62 });
    }
    for (const envName of parsed.environmentVariables ?? []) {
      const configuration = addNode('configuration', `${projectKey}:environment-variable:${envName}`, envName);
      addClaim(fileNode.id, 'reads', configuration.id, { relation: true, status: 'inferred', confidence: 0.88 });
    }
    for (const componentName of parsed.components ?? []) {
      const component = addNode('component', `${projectKey}:component:${componentName}`, componentName);
      addClaim(fileNode.id, 'defines', component.id, { relation: true, status: 'inferred', confidence: 0.62 });
    }
  }
  const payload = { schema: SOURCE_SCHEMA_VERSION, category, path: relativePath, contentHash, nodes: [...nodes.values()], claims };
  return { nodes: [...nodes.values()], claims, fingerprint: sourceFingerprint(payload), category, parsed };
}

function makeRootSource(identity, scope, projectNode, previous, now) {
  const id = sourceId(scope, 'project/root');
  const source = makeSource({
    id,
    scope,
    kind: 'agent',
    locator: 'project root metadata',
    fingerprint: sourceFingerprint({ schema: SOURCE_SCHEMA_VERSION, id: identity.id, checkoutId: identity.checkoutId, name: identity.name, git: Boolean(identity.git) }),
    nodes: [projectNode],
    claims: [claim(projectNode.id, 'name', safeLabel(identity.name, path.basename(String(identity.root ?? 'project'))), { status: 'verified', confidence: 0.88 })].filter(Boolean),
    previous,
    observedAt: now,
  });
  return source;
}

function parseGitBranches(raw) {
  const branches = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const [name, hash] = line.split('\t');
    if (!name || !/^[^\u0000\r\n]{1,220}$/.test(name)) continue;
    branches.push({ name: bounded(name, 220), hash: /^[0-9a-f]{7,128}$/i.test(hash ?? '') ? hash : '' });
    if (branches.length >= LIMITS.maxGitBranches) break;
  }
  return branches.sort((a, b) => a.name.localeCompare(b.name));
}

function parseGitRemotes(raw) {
  const remotes = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = /^remote\.([^.\s]+)\.url\s+(.+)$/.exec(line);
    if (!match) continue;
    const safe = redactRemote(match[2]);
    if (!safe.host && !safe.value) continue;
    remotes.push({ name: bounded(match[1], 80), ...safe });
    if (remotes.length >= LIMITS.maxGitRemotes) break;
  }
  return remotes.sort((a, b) => `${a.name}:${a.value}`.localeCompare(`${b.name}:${b.value}`));
}

function parseGitWorktrees(raw) {
  const paths = [];
  for (const line of String(raw ?? '').split('\0')) {
    if (!line.startsWith('worktree ')) continue;
    const value = line.slice(9).trim();
    if (value && !paths.includes(value)) paths.push(value);
    if (paths.length >= 64) break;
  }
  return paths;
}

function parseGitHistory(raw) {
  const commits = [];
  let current = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const header = /^([0-9a-f]{7,128})\t(.*)$/.exec(line);
    if (header) {
      if (current) commits.push(current);
      current = { hash: header[1], subject: scrubHistorySubject(header[2]), files: [] };
      if (commits.length >= LIMITS.maxGitHistoryCommits) break;
      continue;
    }
    const file = bounded(line, 260);
    if (current && file && !file.startsWith('commit ') && !file.includes('\0') && !isProtectedPath(file) && !isGeneratedPath(file) && current.files.length < 64) current.files.push(file);
  }
  if (current && commits.length < LIMITS.maxGitHistoryCommits) commits.push(current);
  return commits.map(commit => ({ ...commit, files: [...new Set(commit.files)].sort() }));
}

function parseNulList(raw, max = LIMITS.maxFiles) {
  return String(raw ?? '').split('\0').filter(Boolean).map(value => bounded(value, 320)).filter(Boolean).slice(0, max);
}

async function gitCommand(root, args, signal, timeout = 1800) {
  abortIfNeeded(signal);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  try {
    const result = await execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
      env,
      signal,
      timeout,
      maxBuffer: LIMITS.maxGitOutputBytes,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { ok: false, code: error?.code ?? 'GIT_FAILED', stdout: '', stderr: '' };
  }
}

async function discoverGit(identity, root, scope, projectNode, factory, knownFiles, previousMetadata, signal, now) {
  const probe = await gitCommand(root, ['rev-parse', '--show-toplevel'], signal);
  if (!probe.ok || !probe.stdout.trim()) return { available: false, sources: [], metadata: { available: false } };
  abortIfNeeded(signal);
  const commands = await Promise.all([
    gitCommand(root, ['rev-parse', '--git-dir'], signal),
    gitCommand(root, ['rev-parse', '--git-common-dir'], signal),
    gitCommand(root, ['rev-parse', '--verify', 'HEAD'], signal),
    gitCommand(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal),
    gitCommand(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'], signal),
    gitCommand(root, ['config', '--get-regexp', '^remote\\..*\\.url$'], signal),
    gitCommand(root, ['worktree', 'list', '--porcelain', '-z'], signal),
    gitCommand(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], signal),
    gitCommand(root, ['log', '-12', '--no-decorate', '--pretty=format:%H%x09%s', '--name-only', '--no-renames'], signal, 2200),
    gitCommand(root, ['ls-files', '--cached', '--full-name', '-z'], signal, 2200),
  ]);
  abortIfNeeded(signal);
  const [gitDirResult, commonDirResult, headResult, branchResult, refsResult, remoteResult, worktreeResult, indexResult, historyResult, trackedResult] = commands;
  const gitDir = bounded(gitDirResult.stdout.trim(), 500);
  const commonDir = bounded(commonDirResult.stdout.trim(), 500);
  const head = bounded(headResult.stdout.trim(), 128);
  const branch = bounded(branchResult.stdout.trim(), 220);
  const branches = parseGitBranches(refsResult.stdout);
  const remotes = parseGitRemotes(remoteResult.stdout);
  const worktrees = parseGitWorktrees(worktreeResult.stdout);
  const history = parseGitHistory(historyResult.stdout);
  // Git path listings are metadata too.  Keep runtime/generated and protected
  // paths out of the durable cache so the discovery result never becomes a
  // side channel for dotenv/credential filenames.
  const trackedPaths = parseNulList(trackedResult.stdout).filter(file => !isProtectedPath(file) && !isGeneratedPath(file));
  let indexStat = null;
  if (indexResult.ok && indexResult.stdout.trim()) {
    const indexPath = indexResult.stdout.trim();
    const result = await lstatRegular(indexPath);
    if (!result.missing && !result.symlink) indexStat = statSignature(result.stat);
  }
  let configStat = null;
  for (const gitBase of [commonDir, gitDir, '.git']) {
    if (!gitBase) continue;
    const configPath = path.resolve(root, gitBase, 'config');
    const result = await lstatRegular(configPath);
    if (!result.missing && !result.symlink && result.stat?.isFile()) {
      configStat = statSignature(result.stat);
      break;
    }
  }
  const repository = factory.node('repository', `${String(identity.id ?? root)}:repository:${commonDir || root}`, identity.name ? `${identity.name} repository` : 'Git repository');
  const repoNodes = [projectNode, repository];
  const repoClaims = [claim(projectNode.id, 'contains', repository.id, { relation: true, status: 'verified', confidence: 0.99 })].filter(Boolean);
  for (const remote of remotes) {
    const remoteNode = factory.node('external', `${String(identity.id ?? root)}:remote:${remote.name}:${remote.host}:${remote.path}`, remote.host || remote.name);
    repoNodes.push(remoteNode);
    repoClaims.push(claim(repository.id, 'hasRemote', remoteNode.id, { relation: true, status: 'verified', confidence: 0.98 }));
    if (remote.value) repoClaims.push(claim(remoteNode.id, 'url', remote.value, { status: 'verified', confidence: 0.98 }));
    if (remote.transport) repoClaims.push(claim(remoteNode.id, 'transport', remote.transport, { status: 'verified', confidence: 0.98 }));
    repoClaims.push(claim(remoteNode.id, 'configuredAs', remote.name, { status: 'verified', confidence: 0.98 }));
  }
  // Absolute Git directory names are local placement details.  Keeping them
  // out of the semantic fingerprint means moving a checkout on the same
  // filesystem does not create a spurious remote/repository change.
  const repoPayload = { available: true, remotes, repository: repository.id };
  const repoSource = makeSource({
    id: sourceId('shared', 'git/repository'),
    scope: 'shared',
    kind: 'git',
    locator: '.git/config — git repository and remotes',
    fingerprint: sourceFingerprint(repoPayload),
    nodes: repoNodes,
    claims: repoClaims,
    previous: null,
    observedAt: now,
  });

  const branchNodes = [projectNode, repository];
  const branchClaims = [];
  for (const item of branches) {
    const branchNode = factory.node('branch', `${String(identity.id ?? root)}:branch:${item.name}`, item.name);
    branchNodes.push(branchNode);
    branchClaims.push(claim(repository.id, 'hasBranch', branchNode.id, { relation: true, status: 'verified', confidence: 0.99 }));
    if (item.hash) branchClaims.push(claim(branchNode.id, 'head', item.hash, { status: 'verified', confidence: 0.98, exclusive: true }));
  }
  const branchSource = makeSource({
    id: sourceId('shared', 'git/branches'),
    scope: 'shared',
    kind: 'git',
    locator: '.git/refs/heads — git local branch refs',
    fingerprint: sourceFingerprint({ branches: branches.map(item => [item.name, item.hash]) }),
    nodes: branchNodes,
    claims: branchClaims,
    previous: null,
    observedAt: now,
  });

  const checkoutNodes = [projectNode, repository];
  const checkoutClaims = [];
  if (branch) {
    const currentBranch = factory.node('branch', `${String(identity.id ?? root)}:branch:${branch}`, branch);
    checkoutNodes.push(currentBranch);
    checkoutClaims.push(claim(projectNode.id, 'checkedOutBranch', currentBranch.id, { relation: true, status: 'verified', confidence: 0.99, exclusive: true }));
  }
  if (head) checkoutClaims.push(claim(projectNode.id, 'head', head, { status: 'verified', confidence: 0.99, exclusive: true }));
  checkoutClaims.push(claim(projectNode.id, 'checkout', scope, { status: 'verified', confidence: 0.98, exclusive: true }));
  for (const worktreePath of worktrees) {
    const label = path.basename(worktreePath) || 'worktree';
    const worktreeNode = factory.node('repository', `${String(identity.id ?? root)}:worktree:${worktreePath}`, label);
    checkoutNodes.push(worktreeNode);
    checkoutClaims.push(claim(repository.id, 'hasWorktree', worktreeNode.id, { relation: true, status: 'verified', confidence: 0.9 }));
  }
  if (indexStat) checkoutClaims.push(claim(projectNode.id, 'indexState', 'present', { status: 'verified', confidence: 0.92 }));
  const checkoutSource = makeSource({
    id: sourceId(scope, 'git/checkout'),
    scope,
    kind: 'git',
    locator: '.git/HEAD and checkout index',
    // Hash full worktree paths for change detection while keeping absolute
    // checkout locations out of durable claims and source metadata.
    fingerprint: sourceFingerprint({ head, branch, index: indexStat, worktrees: worktrees.map(value => sha256(value)) }),
    nodes: checkoutNodes,
    claims: checkoutClaims,
    previous: null,
    observedAt: now,
  });

  const historyNodes = [projectNode, repository];
  const historyClaims = [];
  for (const item of history) {
    const change = factory.node('change', `${String(identity.id ?? root)}:commit:${item.hash}`, `${item.hash.slice(0, 12)} ${item.subject || 'commit'}`);
    historyNodes.push(change);
    historyClaims.push(claim(repository.id, 'hasChange', change.id, { relation: true, status: 'historical', confidence: 0.99 }));
    if (item.subject) historyClaims.push(claim(change.id, 'subject', item.subject, { status: 'historical', confidence: 0.96 }));
    for (const file of item.files) {
      if (relativePathFor(root, file) === null) continue;
      const changedFile = factory.node('file', fileKey(String(identity.id ?? root), file), file);
      historyNodes.push(changedFile);
      historyClaims.push(claim(change.id, 'touches', changedFile.id, { relation: true, status: 'historical', confidence: 0.9 }));
    }
  }
  const historySource = makeSource({
    id: sourceId('shared', 'git/history'),
    scope: 'shared',
    kind: 'git',
    locator: '.git/log — bounded local Git history (12 commits)',
    fingerprint: sourceFingerprint({ history: history.map(item => ({ hash: item.hash, subject: item.subject, files: item.files })) }),
    nodes: historyNodes,
    claims: historyClaims,
    previous: null,
    observedAt: now,
  });
  const metadata = {
    available: true,
    commonDir: commonDir || null,
    gitDir: gitDir || null,
    head: head || null,
    branch: branch || null,
    branchesFingerprint: sha256(branches.map(item => `${item.name}\0${item.hash}`).join('\n')),
    remotesFingerprint: sha256(remotes.map(item => `${item.name}\0${item.value}`).join('\n')),
    config: configStat,
    index: indexStat,
    trackedCount: trackedPaths.length,
    historyFingerprint: historySource.fingerprint,
    worktreeCount: worktrees.length,
    previous: {
      headChanged: Boolean(previousMetadata?.head && previousMetadata.head !== (head || null)),
      branchChanged: Boolean(previousMetadata?.branch && previousMetadata.branch !== (branch || null)),
      remotesChanged: Boolean(previousMetadata?.remotesFingerprint && previousMetadata.remotesFingerprint !== sha256(remotes.map(item => `${item.name}\0${item.value}`).join('\n'))),
      configChanged: Boolean(previousMetadata?.config && !sameStat(previousMetadata.config, configStat)),
      indexChanged: Boolean(previousMetadata?.index && !sameStat(previousMetadata.index, indexStat)),
    },
  };
  return { available: true, sources: [repoSource, branchSource, checkoutSource, ...(history.length ? [historySource] : [])], metadata };
}

function sourceLocatorRelative(root, locator) {
  if (typeof locator !== 'string' || !locator || locator.startsWith('git ') || locator.includes('metadata')) return null;
  const first = locator.split(/\s+/)[0];
  return relativePathFor(root, first);
}

async function exactMissing(root, locator) {
  const relative = sourceLocatorRelative(root, locator);
  if (!relative) return false;
  const absolute = absolutePathFor(root, relative);
  if (!absolute) return false;
  const result = await lstatRegular(absolute);
  return Boolean(result.missing);
}

/**
 * Discover bounded project structure without writing the store.
 *
 * `previousSources` may contain store summaries or complete prior sources.
 * `metadata` is the opaque cache returned from a prior call.  Every returned
 * source carries the version observed at call start as `expectedVersion`.
 */
export async function discoverProject(identity, options = {}) {
  const started = Date.now();
  const signal = options.signal;
  abortIfNeeded(signal);
  const inputIdentity = asObject(identity);
  const requestedRoot = String(inputIdentity.root ?? '');
  const root = requestedRoot ? await fs.realpath(requestedRoot).catch(() => path.resolve(requestedRoot)) : path.resolve('.');
  const projectKey = String(inputIdentity.id ?? root);
  const scope = bounded(inputIdentity.checkoutId ?? `${projectKey}:checkout`, 180) || `${projectKey}:checkout`;
  const name = safeLabel(inputIdentity.name, path.basename(root) || 'project');
  const normalizedIdentity = { ...inputIdentity, id: projectKey, checkoutId: scope, root, name };
  const previous = normalizePrevious(options.previousSources);
  const inputMetadata = asObject(options.metadata);
  const cache = asObject(inputMetadata.sources ?? inputMetadata.sourceCache);
  const oldEntries = decodeEntryIndex(inputMetadata.entries ?? inputMetadata.files);
  const oldDirectories = decodeDirectoryIndex(inputMetadata.directories);
  const parserCacheCompatible = Number(inputMetadata.schemaVersion) === METADATA_SCHEMA_VERSION && Number(inputMetadata.parserSchemaVersion) === SOURCE_SCHEMA_VERSION;
  const now = new Date().toISOString();
  const stats = {
    durationMs: 0,
    filesSeen: 0,
    filesDiscovered: 0,
    filesParsed: 0,
    filesReused: 0,
    filesHashed: 0,
    filesSkipped: 0,
    newFiles: [],
    changedFiles: [],
    deletedFiles: [],
    newDirectories: [],
    deletedDirectories: [],
    bytesRead: 0,
    directoriesVisited: 0,
    generatedDirectoriesSkipped: 0,
    protectedFilesSkipped: 0,
    symlinksSkipped: 0,
    unreadableDirectories: 0,
    staleCacheEntries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    sourcesReused: 0,
    sourcesChanged: 0,
    sourcesNew: 0,
    removedSources: 0,
    truncated: false,
    coverageComplete: false,
    gitAvailable: false,
    headChanged: false,
    branchChanged: false,
    remoteChanged: false,
    configChanged: false,
    indexChanged: false,
    worktreesChanged: false,
    rootManifestChanged: false,
  };
  const factory = createNodeFactory(projectKey);
  const projectNode = factory.project;
  const sources = [];
  const sourceIds = new Set();
  // `sources` contains only replacements needed by the store.  This separate
  // set represents the complete current inventory so an omitted warm source
  // is not mistaken for a deleted source during exact-missing withdrawal.
  const presentSourceIds = new Set();
  const addSource = (candidate, metadataEntry = null) => {
    if (!candidate || !candidate.id || sourceIds.has(candidate.id) || sources.length >= LIMITS.maxSources) {
      stats.truncated = true;
      return null;
    }
    const prior = previous.get(candidate.id);
    const current = sourceWithVersion(candidate, prior, cache, Boolean(options.force), now);
    sourceIds.add(current.id);
    sources.push(current);
    if (prior) {
      if (prior.fingerprint === current.fingerprint) stats.sourcesReused++;
      else stats.sourcesChanged++;
    } else stats.sourcesNew++;
    return current;
  };

  const rootSource = makeRootSource(normalizedIdentity, scope, projectNode, previous.get(sourceId(scope, 'project/root')), now);
  presentSourceIds.add(rootSource.id);
  if (options.force || !previousSourceUsable(previous.get(rootSource.id)) || previous.get(rootSource.id)?.fingerprint !== rootSource.fingerprint) addSource(rootSource);
  else {
    stats.sourcesReused++;
    stats.cacheHits++;
  }
  const workspace = await collectWorkspace(root, { ...options, signal }, stats);
  const knownFiles = new Set(workspace.files.keys());
  stats.filesDiscovered = knownFiles.size;
  const oldFilePaths = new Set(Object.keys(oldEntries));
  const inventoryChanged = !options.paths && workspace.coverageComplete && (oldFilePaths.size !== knownFiles.size || [...knownFiles].some(relativePath => !oldFilePaths.has(relativePath)));
  const currentEntries = {};
  const sortedFiles = [...workspace.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [relativePath, file] of sortedFiles) {
    abortIfNeeded(signal);
    const priorEntry = asObject(oldEntries[relativePath]);
    const sourceForPath = sourceId(scope, relativePath);
    const priorSource = previous.get(sourceForPath);
    const cachedSource = cache[sourceForPath] ?? (previous.get(sourceForPath)?.nodes ? previous.get(sourceForPath) : null);
    const currentStat = statSignature(file.stat);
    const statUnchanged = sameStat(currentStat, priorEntry.stat);
    const priorEvidence = Boolean(parserCacheCompatible && !options.force && previousSourceUsable(priorSource) && priorEntry.contentHash && priorEntry.fingerprint && priorSource.fingerprint === priorEntry.fingerprint && ['file', 'deployment'].includes(String(priorSource.kind ?? '').toLowerCase()));
    const importInventoryRefresh = inventoryChanged && (isSourcePath(relativePath) || /(?:^|\/)(?:migrations?|schemas?|schema)\//i.test(relativePath) || /\.(?:sql|graphql|gql)$/i.test(relativePath));
    presentSourceIds.add(sourceForPath);
    if (!(relativePath in oldEntries)) stats.newFiles.push(relativePath);
    else if (!statUnchanged) stats.changedFiles.push(relativePath);

    // The compact index makes the common warm path stat-only.  The previous
    // store summary proves that this exact source and parser fingerprint are
    // still active, so reparsing would only recreate the same graph payload.
    if (priorEvidence && statUnchanged && !importInventoryRefresh) {
      currentEntries[relativePath] = {
        contentHash: priorEntry.contentHash,
        fingerprint: priorEntry.fingerprint,
        category: priorEntry.category ?? 'source',
        stat: currentStat,
      };
      stats.cacheHits++;
      stats.filesReused++;
      stats.sourcesReused++;
      continue;
    }
    let contentHash = '';
    let evidence = null;
    let reused = false;
    const reusable = priorEvidence || Boolean(parserCacheCompatible && !options.force && previousSourceUsable(priorSource) && priorEntry.contentHash && cachedSource?.fingerprint && cachedSource.id === sourceForPath);
    const read = await readBounded(file.absolute, file.stat, signal);
    stats.bytesRead += read.bytes ?? 0;
    if (stats.bytesRead > LIMITS.maxTotalBytes) {
      stats.truncated = true;
      workspace.coverageComplete = false;
      break;
    }
    if (read.tooLarge || read.binary || read.unreadable || read.text === null) {
      // A stat-identical unreadable file can safely retain its cached source;
      // a changed one must remain untouched until a later complete scan.
      if (priorEvidence) {
        currentEntries[relativePath] = {
          contentHash: priorEntry.contentHash,
          fingerprint: priorEntry.fingerprint,
          category: priorEntry.category ?? 'source',
          // Retain the old stat when the new file could not be read.  This
          // forces a retry on the next scan instead of certifying unknown
          // contents as unchanged.
          stat: priorEntry.stat,
        };
        stats.filesSkipped++;
        if (read.tooLarge) stats.staleCacheEntries++;
        continue;
      }
      if (reusable && cachedSource && statUnchanged) {
        contentHash = priorEntry.contentHash;
        evidence = { fingerprint: cachedSource.fingerprint, category: priorEntry.category ?? 'source', nodes: cloneJson(cachedSource.nodes) ?? [], claims: cloneJson(cachedSource.claims) ?? [] };
        stats.cacheHits++;
        stats.filesReused++;
        reused = true;
      } else {
        stats.filesSkipped++;
        if (read.tooLarge) stats.staleCacheEntries++;
        // Retain skipped files in the inventory even though no source is
        // emitted.  Otherwise a complete scan of a project with a handful of
        // oversized/binary files looks like an inventory change on every
        // warm run and needlessly invalidates every import graph.
        currentEntries[relativePath] = {
          contentHash: '',
          fingerprint: '',
          category: 'skipped',
          stat: currentStat,
        };
        continue;
      }
    } else {
      contentHash = sha256(read.text);
      stats.filesHashed++;
      if (priorEvidence && priorEntry.contentHash === contentHash && !importInventoryRefresh) {
        currentEntries[relativePath] = {
          contentHash: priorEntry.contentHash,
          fingerprint: priorEntry.fingerprint,
          category: priorEntry.category ?? 'source',
          stat: currentStat,
        };
        stats.cacheHits++;
        stats.filesReused++;
        stats.sourcesReused++;
        continue;
      }
      if (reusable && cachedSource && priorEntry.contentHash === contentHash && !importInventoryRefresh) {
        evidence = { fingerprint: cachedSource.fingerprint, category: priorEntry.category ?? 'source', nodes: cloneJson(cachedSource.nodes) ?? [], claims: cloneJson(cachedSource.claims) ?? [] };
        stats.cacheHits++;
        stats.filesReused++;
        reused = true;
      } else {
        evidence = buildEvidence(normalizedIdentity, root, relativePath, read.text, contentHash, { knownFiles });
        stats.filesParsed++;
        stats.cacheMisses++;
      }
    }
    const source = makeSource({
      id: sourceForPath,
      scope,
      kind: evidence.category === 'deployment' ? 'deployment' : 'file',
      locator: relativePath,
      fingerprint: evidence.fingerprint,
      nodes: evidence.nodes,
      claims: evidence.claims,
      previous: previous.get(sourceForPath),
      observedAt: reused ? (cachedSource?.observedAt ?? now) : now,
    });
    addSource(source);
    currentEntries[relativePath] = {
      contentHash,
      fingerprint: source.fingerprint,
      category: evidence.category,
      stat: currentStat,
    };
  }
  for (const oldPath of Object.keys(oldEntries).sort()) {
    if (!knownFiles.has(oldPath) && workspace.coverageComplete) stats.deletedFiles.push(oldPath);
  }
  for (const relativePath of [...workspace.directories.keys()].sort()) {
    if (!(relativePath in oldDirectories)) stats.newDirectories.push(relativePath);
  }
  // `workspace.directories` is a Map; use `.has` for deletion checks so a
  // warm compact index does not report every existing directory as deleted.
  if (workspace.coverageComplete) for (const oldPath of Object.keys(oldDirectories).sort()) if (!workspace.directories.has(oldPath)) stats.deletedDirectories.push(oldPath);

  const git = await discoverGit(normalizedIdentity, root, scope, projectNode, factory, knownFiles, asObject(inputMetadata.git), signal, now);
  stats.gitAvailable = Boolean(git.available);
  if (git.available) {
    stats.headChanged = Boolean(git.metadata?.previous?.headChanged);
    stats.branchChanged = Boolean(git.metadata?.previous?.branchChanged);
    stats.remoteChanged = Boolean(git.metadata?.previous?.remotesChanged);
    stats.configChanged = Boolean(git.metadata?.previous?.configChanged);
    stats.indexChanged = Boolean(git.metadata?.previous?.indexChanged);
    const priorWorktreeCount = Number(inputMetadata.git?.worktreeCount);
    stats.worktreesChanged = Number.isFinite(priorWorktreeCount) && priorWorktreeCount !== Number(git.metadata?.worktreeCount);
  }
  stats.rootManifestChanged = [...stats.changedFiles, ...stats.newFiles, ...stats.deletedFiles].some(file => !file.includes('/') && isManifestPath(file));
  if (git.available) for (const source of git.sources) {
    const prior = previous.get(source.id);
    presentSourceIds.add(source.id);
    // Git summaries are enough to prove an unchanged repository/branch/
    // checkout.  Avoid rebuilding the graph payload in the warm batch.
    if (!options.force && previousSourceUsable(prior) && prior?.fingerprint === source.fingerprint) {
      stats.sourcesReused++;
      stats.cacheHits++;
    } else addSource(source);
  }

  const coverageComplete = Boolean(workspace.coverageComplete && !stats.truncated && stats.bytesRead <= LIMITS.maxTotalBytes);
  stats.coverageComplete = coverageComplete;
  const removedSourceIds = [];
  if (coverageComplete || options.paths) {
    for (const [id, prior] of previous) {
      if (presentSourceIds.has(id)) continue;
      // `previousSources` also contains durable session, agent, and curated
      // memory records owned by the worker.  Their locators (for example
      // `session:session-7`) are identifiers, not workspace paths.  Discovery
      // may withdraw only its own deterministic source records; otherwise an
      // exact-missing check can silently delete unrelated project evidence.
      if (!id.startsWith('src_')) continue;
      if (!['agent', 'deployment', 'file', 'git'].includes(String(prior.kind ?? '').toLowerCase())) continue;
      if (await exactMissing(root, prior.locator)) removedSourceIds.push(id);
    }
  }
  stats.removedSources = removedSourceIds.length;
  const nextMetadata = {
    schemaVersion: METADATA_SCHEMA_VERSION,
    parserSchemaVersion: SOURCE_SCHEMA_VERSION,
    projectId: projectKey,
    checkoutId: scope,
    root,
    name,
    lastScan: now,
    // Full source payloads are authoritative in the store.  Metadata only
    // keeps the compact stat/hash ownership index needed for warm scans.
    entries: encodeEntryIndex(currentEntries),
    directories: encodeDirectoryIndex(Object.fromEntries(workspace.directories)),
    sources: {},
    git: git.metadata ?? { available: false },
    limits: LIMITS,
    scan: {
      complete: coverageComplete,
      files: knownFiles.size,
      directories: workspace.directories.size,
    },
  };
  // Keep the compact cache below the storage owner's metadata quota.  Under
  // normal limits the Brotli indexes are tiny; retain a bounded fallback for
  // malformed or unexpectedly large metadata so setMeta cannot fail.
  let metadataTrimmed = false;
  const metadataSize = () => Buffer.byteLength(JSON.stringify(nextMetadata));
  if (metadataSize() > LIMITS.maxMetadataBytes) {
    nextMetadata.entries = {};
    metadataTrimmed = true;
  }
  if (metadataSize() > LIMITS.maxMetadataBytes) {
    nextMetadata.directories = {};
    metadataTrimmed = true;
  }
  if (metadataSize() > LIMITS.maxMetadataBytes) {
    nextMetadata.git = { available: Boolean(git.available) };
    metadataTrimmed = true;
  }
  if (metadataTrimmed) {
    nextMetadata.cacheTruncated = true;
    stats.truncated = true;
  }
  stats.newFileCount = stats.newFiles.length;
  stats.changedFileCount = stats.changedFiles.length;
  stats.deletedFileCount = stats.deletedFiles.length;
  stats.newDirectoryCount = stats.newDirectories.length;
  stats.deletedDirectoryCount = stats.deletedDirectories.length;
  stats.durationMs = Date.now() - started;
  return { sources, removedSourceIds: removedSourceIds.sort(), metadata: nextMetadata, stats };
}

export { LIMITS as DISCOVERY_LIMITS };
