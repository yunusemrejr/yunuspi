// On-demand local facts for Lens project_report. No cache, persistence, remote
// connection, shell, hooks, manifest commands or mutation. Git is read-only.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const MARKERS = ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','package-lock.json','yarn.lock','bun.lock','Cargo.toml','go.mod','go.work','pyproject.toml','requirements.txt','composer.json','Gemfile','Makefile','Dockerfile','compose.yaml','docker-compose.yml','AGENTS.md','WORKSPACE.md','OPERATIONS.md','DEPLOYMENT.md'];
const DIRS = ['src','app','pages','public','tests','test','scripts','.github/workflows'];
const RUNTIME = ['uploads','storage','logs','data','db','var','.env'];
function classification(file) {
  if (/(^|\/)(\.env[^/]*|secrets?|credentials?)(\/|$)|\.(pem|key)$/i.test(file)) return 'protected/configuration candidate';
  if (/(^|\/)(uploads?|storage|logs?|data|db|var|dist|build|coverage)(\/|$)|\.(db|sqlite3?|dump|bak)$/i.test(file)) return 'runtime/generated candidate';
  return 'unclassified';
}
function publicRemote(line) {
  const m = /^(remote\.(.+)\.url)\s+(.+)$/.exec(line);
  if (!m) return null;
  const raw = m[3];
  let host = null, transport = 'local-or-custom (not inspected)';
  try { const u = new URL(raw); if (['https:','http:','ssh:','git:'].includes(u.protocol)) { host = u.hostname.slice(0, 160); transport = u.protocol.slice(0,-1); } }
  catch { const scp = /^(?:[^@\s]+@)?([a-zA-Z0-9.-]+):[^/].*$/.exec(raw); if (scp) { host = scp[1].slice(0,160); transport = 'ssh'; } }
  return { name: m[2].slice(0,80), host, transport, locationOmitted: true, source: m[1].slice(0,100), contacted: false };
}
export async function workspaceFacts(cwd, signal) {
  signal?.throwIfAborted();
  const started = Date.now();
  const deadline = AbortSignal.timeout(5000);
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const root = await fs.realpath(cwd);
  const result = { available: true, view: 'workspace', root, observedAt: new Date().toISOString(), source: 'fresh local filesystem and read-only Git', manifests: [], directories: [], commands: [], dependencyEvidence: [], protectedCandidates: [], git: { available: false }, authority: 'unresolved', remoteState: 'not inspected; remote configuration is not production evidence', synchronization: 'not authorized or assessed', truncated: false, limits: { markerPaths: MARKERS.length + DIRS.length + RUNTIME.length, gitCommands: 13, gitOutputBytesPerCommand: 16384, changedPaths: 40, worktrees: 10, manifestBytes: 65536, outputChars: 12000, scopeProbes: 160, scopeCandidates: 24, scopeAncestorLevels: 4, scopeEntriesPerContainer: 64 }, limitations: ['Filename classifications are hints, not ownership or safety decisions.', 'Local, repository and production are not assumed equal. Databases, uploads, secrets and generated state are not mergeable source by default.', 'No remote probes, hooks, deployment commands, Git diff filters or manifest scripts are executed.', 'No persistent manifest or authority declarations are created. Use existing workspace documentation/memory for explicit declarations.'] };
  const exists = async (rel) => { operationSignal.throwIfAborted(); try { const s = await fs.lstat(path.join(root, rel)); return !s.isSymbolicLink() && (s.isFile() || s.isDirectory()); } catch (e) { if (e.code === 'ENOENT') return false; result.truncated = true; return false; } };
  for (const name of MARKERS) if (await exists(name)) result.manifests.push({ path: name, source: 'lstat' });
  for (const name of DIRS) if (name.includes('/') ? await exists('.github') && await exists(name) : await exists(name)) result.directories.push(name);
  for (const name of RUNTIME) if (await exists(name)) result.protectedCandidates.push({ path: name, classification: classification(name), authority: 'unresolved', source: 'filename only' });
  if (result.manifests.some(m => m.path === 'package.json')) {
    let handle;
    try {
      handle = await fs.open(path.join(root, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error('manifest limit');
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error('manifest grew past limit');
      const data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const scripts = data.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts) ? data.scripts : {};
        for (const key of Object.keys(scripts).sort().slice(0,32)) if (typeof scripts[key] === 'string') result.commands.push({ name: key.slice(0,80), source: 'package.json#/scripts/' + key.slice(0,80), bodyOmitted: true, executed: false });
        if (Object.keys(scripts).length > 32) result.truncated = true;
        const deps = { ...data.dependencies, ...data.devDependencies };
        result.dependencyEvidence = ['react','next','vue','svelte','@sveltejs/kit','astro','vite','express','typescript','vitest','@playwright/test'].filter(k => Object.hasOwn(deps,k)).map(name => ({ name, source: 'package.json dependency key (not runtime verification)' }));
      }
    } catch { result.manifestWarning = 'package.json unavailable, invalid or over 64KiB; no commands inferred'; }
    finally { await handle?.close(); }
  }
  // Strip inherited Git routing/config overrides; never inherit GIT_DIR pointing
  // somewhere other than the explicit cwd. fsmonitor is the status hook seam.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' });
  const git = async (args) => {
    operationSignal.throwIfAborted();
    try { const r = await exec('git', ['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args], { env, signal: operationSignal, timeout: Math.max(1,5000-(Date.now()-started)), maxBuffer: 16384, encoding:'utf8' }); return { ok:true, text:r.stdout }; }
    catch (e) { operationSignal.throwIfAborted(); return { ok:false, code:e.code, reason: e.code === 'ENOENT' ? 'git unavailable' : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git output exceeded 16KiB' : 'Git query unavailable (not a repository, permissions, or command failure)' }; }
  };
  const repo = await git(['rev-parse','--show-toplevel']);
  if (repo.ok) {
    result.git = { available:true, root:repo.text.trim(), source:'git rev-parse --show-toplevel', remoteState:'not contacted' };
    const [status, untracked, ignored, remotes, worktrees, hooks] = await Promise.all([
      git(['diff','--cached','--name-status','-z','--no-renames','--no-ext-diff','--no-textconv','--ignore-submodules=all']),
      git(['ls-files','--others','--exclude-standard','--directory','--full-name','-z','--',':/']),
      git(['ls-files','--others','--ignored','--exclude-standard','--directory','--full-name','-z','--',':/']),
      git(['config','--get-regexp','^remote\\..*\\.url$']),
      git(['worktree','list','--porcelain','-z']),
      git(['rev-parse','--git-path','hooks']),
    ]);
    const [head, branch, commonDir, gitDir, upstream, divergence] = await Promise.all([
      git(['rev-parse','--verify','HEAD']), git(['symbolic-ref','--quiet','--short','HEAD']),
      git(['rev-parse','--path-format=absolute','--git-common-dir']), git(['rev-parse','--absolute-git-dir']),
      git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']),
      git(['rev-list','--left-right','--count','HEAD...@{upstream}']),
    ]);
    result.git.versionControl = { head: head.ok ? head.text.trim() : null, branch: branch.ok ? branch.text.trim() : null,
      headState: branch.ok ? (head.ok ? 'attached' : 'unborn') : head.ok ? 'detached' : 'unavailable',
      commonDirectory: commonDir.ok ? commonDir.text.trim() : null,
      upstream: upstream.ok ? upstream.text.trim() : null, remoteFreshness: 'local tracking refs only; no fetch, GitHub/CI state unverified',
      operations: [], collaboration: 'Branches/refs are shared across linked worktrees; working files and indexes are per-worktree. Session checkpoints are not commits. Before staging, committing or changing branches, inspect current scope and peer work; verify the exact resulting commit, not just a branch name.' };
    if (divergence.ok && /^\d+\s+\d+\s*$/.test(divergence.text)) {
      const [ahead,behind]=divergence.text.trim().split(/\s+/).map(Number);
      result.git.versionControl.divergence={ahead,behind,source:'local upstream tracking ref'};
    }
    if (gitDir.ok) for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','index.lock']) {
      operationSignal.throwIfAborted();
      try { const stat=await fs.lstat(path.join(gitDir.text.trim(),marker)); if(!stat.isSymbolicLink()) result.git.versionControl.operations.push(marker); } catch {}
    }
    // Never refresh/compare tracked worktree contents: even a read-only status
    // can execute conversion filters. Config enumeration cannot close that race.
    result.git.statusScope = 'Staged, untracked and ignored paths only. Unstaged tracked contents and submodule contents NOT compared; not an atomic workspace snapshot.';
    result.git.trackedClean = null;
    const changes = [];
    const appendChange = (file, code) => {
      if (changes.length < 40) changes.push({ path:file.slice(0,240), status:code, classification:classification(file), authority:'unresolved' });
      else result.truncated = true;
    };
    if (status.ok) {
      const records = status.text.split('\0').filter(Boolean);
      for (let i=0;i+1<records.length;i+=2) appendChange(records[i+1],records[i]+' ');
      result.git.stagedClean = records.length === 0;
    } else { result.git.statusWarning = status.reason; result.truncated=true; }
    for (const [query, code] of [[untracked,'??'],[ignored,'!!']]) {
      if (query.ok) for (const file of query.text.split('\0').filter(Boolean)) appendChange(file,code);
      else { result.git.statusWarning = query.reason; result.truncated=true; }
    }
    result.git.changes = changes;
    result.git.remotes = remotes.ok ? remotes.text.split('\n').filter(Boolean).slice(0,10).map(publicRemote).filter(Boolean) : [];
    if (!remotes.ok) result.git.remoteWarning = 'No remote URLs returned (none configured or query unavailable)';
    if (remotes.ok && remotes.text.split('\n').filter(Boolean).length > 10) result.truncated=true;
    if (worktrees.ok) {
      const entries = worktrees.text.split('\0').filter(x => x.startsWith('worktree '));
      result.git.worktrees = entries.slice(0,10).map(x => ({ path:x.slice(9,249), source:'git worktree list', isolation:'shares project Git database, not a separate harness repository' }));
      if (entries.length>10) result.truncated=true;
    } else result.git.worktreeWarning = worktrees.reason;
    if (hooks.ok) result.git.hooksPath = { path:hooks.text.trim().slice(0,240), source:'git rev-parse --git-path hooks', contentInspected:false, executed:false };
  } else result.git.reason=repo.reason;
  result.scope = await workspaceScope(root, operationSignal);
  result.truncated ||= result.scope.truncated;
  operationSignal.throwIfAborted();
  result.elapsedMs = Date.now()-started;
  // Preserve valid JSON under the model-facing budget, including unusual names.
  while (JSON.stringify(result).length > 12000 && result.scope.candidates.length) { result.scope.candidates.pop(); result.truncated=true; result.scope.truncated=true; }
  for (const key of ['changes','worktrees','remotes']) while (JSON.stringify(result).length > 12000 && result.git[key]?.length) { result.git[key].pop(); result.truncated=true; }
  while (JSON.stringify(result).length > 12000 && result.commands.length) { result.commands.pop(); result.truncated=true; }
  return result;
}

/** Bounded relationship discovery, not an edit-scope or deployment authority. */
export async function workspaceScope(root, signal) {
  const result = { base: root, candidates: [], truncated: false, probes: 0,
    policy: 'Inspect related contracts and tests when relevant to the user task. A relationship is not permission to edit another folder. Confirm ownership before expanding edits; remote systems remain unverified.',
    limitations: ['Only bounded local manifest relationships and conventional module containers are inspected.', 'Unsupported workspace globs and non-JSON dependency declarations require targeted inspection; absence is not proof of independence.'] };
  const seen = new Set();
  const probe = async file => {
    signal?.throwIfAborted();
    if (result.probes >= 160) { result.truncated = true; return null; }
    result.probes++;
    try { const stat = await fs.lstat(file); return stat.isSymbolicLink() ? null : stat; } catch { return null; }
  };
  const json = async dir => {
    const file = path.join(dir, 'package.json');
    const stat = await probe(file);
    if (!stat?.isFile()) return null;
    if (stat.size > 65536) { result.truncated = true; return null; }
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) { result.truncated = true; return null; }
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { result.truncated = true; return null; } finally { await handle?.close(); }
  };
  const add = (target, relationship, evidence, existenceChecked = false) => {
    const key = target + ':' + relationship;
    if (seen.has(key) || target === root) return;
    if (result.candidates.length >= 24) { result.truncated = true; return; }
    seen.add(key); result.candidates.push({ path: target, relationship, evidence, existenceChecked, editScope: 'not established' });
  };
  const patterns = data => Array.isArray(data?.workspaces) ? data.workspaces : Array.isArray(data?.workspaces?.packages) ? data.workspaces.packages : [];
  // Only literal segments and a terminal * are supported; no arbitrary glob traversal.
  const safePattern = value => typeof value === 'string' && value.length <= 160 && /^(?:[\w@.-]+\/)*[\w@.*-]+$/.test(value) && !value.split('/').some(x => x === '..' || x === '.' || x.startsWith('.')) && (!value.includes('*') || value.endsWith('/*') && value.indexOf('*') === value.length - 1);
  const list = async dir => {
    if (!(await probe(dir))?.isDirectory()) return [];
    let handle; const names = [];
    try { handle = await fs.opendir(dir); for await (const entry of handle) {
      signal?.throwIfAborted();
      if (names.length >= 64) { result.truncated = true; break; }
      names.push(entry);
    } } catch (error) { signal?.throwIfAborted(); result.truncated = true; }
    return names.filter(x => x.isDirectory() && !x.name.startsWith('.')).map(x => x.name).sort();
  };
  const safeDirectory = async (base, relative) => {
    let target = base;
    for (const segment of relative.split('/').filter(Boolean)) {
      target = path.join(target, segment);
      if (!(await probe(target))?.isDirectory()) return null;
    }
    return target;
  };
  const data = await json(root);
  for (const pattern of patterns(data).slice(0, 24)) {
    if (!safePattern(pattern)) { result.truncated = true; continue; }
    if (pattern.endsWith('/*')) {
      const base = await safeDirectory(root, pattern.slice(0, -2));
      if (base) for (const name of await list(base)) add(path.join(base, name), 'declared workspace member', 'package.json#/workspaces: ' + pattern, true);
    } else {
      const target = await safeDirectory(root, pattern);
      if (target) add(target, 'declared workspace member', 'package.json#/workspaces: ' + pattern, true);
    }
  }
  if (patterns(data).length > 24) result.truncated = true;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = data?.[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const entries = Object.entries(deps);
    if (entries.length > 128) result.truncated = true;
    for (const [name, value] of entries.slice(0,128)) {
      if (typeof value !== 'string' || !/^(file|link):/.test(value)) continue;
      const relative = value.replace(/^(file|link):/, '');
      if (!relative || relative.length > 240 || /[\x00-\x1f]/.test(relative)) continue;
      add(path.resolve(root, relative), 'declared local dependency (existence unverified)', 'package.json#/' + section + '/' + name.slice(0,100));
    }
  }
  for (const container of ['apps', 'packages', 'services', 'libs', 'modules']) {
    for (const name of await list(path.join(root, container))) {
      const dir = path.join(root, container, name);
      if (result.candidates.some(candidate => candidate.path === dir)) continue;
      for (const marker of ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'composer.json', 'CMakeLists.txt']) {
        if ((await probe(path.join(dir, marker)))?.isFile()) { add(dir, 'module candidate; task relevance unverified', path.relative(root, path.join(dir, marker)), true); break; }
      }
    }
  }
  let parent = path.dirname(root);
  for (let depth = 0; depth < 4 && parent !== path.dirname(parent); depth++, parent = path.dirname(parent)) {
    const parentData = await json(parent), relative = path.relative(parent, root).split(path.sep).join('/');
    for (const pattern of patterns(parentData).slice(0,24)) {
      if (!safePattern(pattern)) continue;
      const member = pattern.endsWith('/*') ? relative.startsWith(pattern.slice(0,-1)) && relative.slice(pattern.length-1).split('/')[0] : relative === pattern || relative.startsWith(pattern + '/');
      if (member) { add(parent, 'declared containing workspace', path.join(parent, 'package.json') + '#/workspaces: ' + pattern, true); break; }
    }
  }
  signal?.throwIfAborted();
  return result;
}

const TEST_SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|cs|fs|php|rb|swift|c|cc|cpp|cxx|h|hpp|sh|bash|ex|exs|erl|scala|clj|cljs|vue|svelte)$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)|(?:^|[._-])(?:test|spec)(?:[._-]|$)|_test\.[^/]+$/i;
const TEST_MANIFEST = /^(?:package\.json|pyproject\.toml|pytest\.ini|tox\.ini|Cargo\.toml|go\.mod|composer\.json|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt|Makefile|.*\.(?:csproj|fsproj))$/;
const TEST_SKIP = /^(?:\..*|node_modules|vendor|target|dist|build|coverage|__pycache__|venv|env|logs?|artifacts?|backups?|sessions?|worktrees?|uploads?|storage|data|secrets?|credentials?)$/i;

export function isProjectTestSource(file) {
  return !file.split(/[\\/]/).some(part => TEST_SKIP.test(part)) && TEST_SOURCE.test(file) && !/\.min\.[cm]?js$/i.test(file);
}

const reviewSkip = part => TEST_SKIP.test(part) && !/^(?:\.github|\.circleci|\.gitlab-ci\.yml)$/.test(part);
export function isProjectReviewSource(file) {
  return !file.split(/[\\/]/).some(reviewSkip) &&
    !/(?:^|\/)(?:auth|settings|models|credentials)\.json$|\.(?:min|generated)\./i.test(file) &&
    (TEST_SOURCE.test(file) || /\.(?:html?|css|scss|sass|less|mdx?|rst|txt|json|ya?ml|toml|xml|sql|tf|wat|wasm)$/i.test(file));
}

/** Local test setup and source metadata only. Never executes project code,
 * imports a config, reads secrets or follows a symlink. A bounded scan cannot
 * establish absence or ownership of every test/change in a large workspace. */
export async function projectTestFacts(cwd, signal, options = {}) {
  signal?.throwIfAborted();
  const root = await fs.realpath(cwd);
  const maxEntries = Math.min(4000, Math.max(1, options.maxEntries ?? 1200));
  const deadline = Date.now() + Math.min(2000, Math.max(1, options.timeoutMs ?? 400));
  const result = { root, source: 'bounded local filenames and stat metadata', manifests: [], tests: [], scripts: [], sources: {}, reviewSources: {}, truncated: false, entries: 0,
    limitations: ['No scripts/configs executed. Test filenames and script names do not establish coverage or safety.', 'Source stat changes include shell/external writes; attribution and same-metadata changes are not established.', 'Ignored/generated directories, symlinks and paths beyond scan limits are not inspected.'] };
  const queue = [{ dir: root, depth: 0 }];
  const manifests = [];
  while (queue.length && !result.truncated) {
    const { dir, depth } = queue.shift();
    try {
      const directory = await fs.opendir(dir);
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++result.entries > maxEntries || Date.now() >= deadline) { result.truncated = true; break; }
        if (entry.isSymbolicLink() || reviewSkip(entry.name)) continue;
        const absolute = path.join(dir, entry.name), relative = path.relative(root, absolute).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (depth < 5) queue.push({ dir: absolute, depth: depth + 1 });
          else result.truncated = true;
        } else if (entry.isFile()) {
          if (TEST_MANIFEST.test(entry.name) && result.manifests.length < 32) {
            result.manifests.push(relative);
            if (entry.name === 'package.json' && manifests.length < 8) manifests.push(absolute);
          }
          const testSource = isProjectTestSource(relative) || TEST_MANIFEST.test(entry.name) || /(?:vitest|jest|pytest|test).*config\./i.test(entry.name);
          if (testSource || isProjectReviewSource(relative)) {
            const stat = await fs.lstat(absolute);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
            if (testSource) result.sources[relative] = fingerprint;
            if (isProjectReviewSource(relative)) result.reviewSources[relative] = fingerprint;
            if (TEST_PATH.test(relative) && result.tests.length < 40) result.tests.push(relative);
          }
        }
      }
    } catch (error) { signal?.throwIfAborted(); result.truncated = true; }
  }
  // Read only literal JSON keys through the same no-follow, bounded contract as
  // workspaceFacts. Script bodies stay out of automatic model-facing notices.
  for (const file of manifests) {
    let handle;
    try {
      signal?.throwIfAborted();
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) { result.truncated = true; continue; }
      const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) { result.truncated = true; continue; }
      const data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (data?.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts)) {
        for (const name of Object.keys(data.scripts).filter(name => /^(?:test|check|verify)(?:$|[:-])/.test(name)).slice(0, 16)) {
          if (typeof data.scripts[name] === 'string') result.scripts.push({ manifest: path.relative(root, file), name: name.slice(0, 80), executed: false, bodyOmitted: true });
        }
      }
    } catch { result.truncated = true; }
    finally { await handle?.close(); }
  }
  signal?.throwIfAborted();
  return result;
}
