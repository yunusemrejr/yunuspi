import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSkillDiscoveryRequest, parseSkillDiscoverySuggestions } from './skill-discovery.ts';
import { skillEvidenceContext, type SkillInfo } from './skill-relevance.ts';

const RUNNER = Symbol.for('yunus-pi.skill-discovery-runner.v1');
const OBSERVED_TOOLS = new Set([
  'read','edit','write','grep','find','ls',
  // Source-intelligence tools expose bounded path metadata and are useful
  // evidence for skill discovery when they replace broad shell searches.
  'symbol_search','module_report','read_symbol','symbol_references',
  'lsp_navigation','ast_grep_search','context_slice','symbol_expand','context_code',
  'lsp_diagnostics','project_report','package_probe','openapi_probe','sqlite_probe','render_see','fetch_content','web_search','data_query','syntax_check',
  'browser','browser_navigate','browser_snapshot','browser_click','browser_screenshot','http_request','coverage_probe','contract_diff','env_audit','net_probe','archive_probe','artifact_check',
  'agentmail_status','agentmail_send','agentmail_messages','agentmail_search','agentmail_message',
]);

/** Advisory discovery piggybacks on successful native observations. No timers
 * start work, no transcript/body is copied, and results never wake the agent. */
export function createSkillDiscoveryController(options: {
  catalog: () => SkillInfo[];
  covered: (file: string) => boolean;
  enabled: () => boolean;
  offer: (skill: SkillInfo, reason: string) => void;
}) {
  let ctx: any, prompt = '', generation = 0, attempted = false;
  let controller: AbortController | undefined;
  const observations = new Set<string>(), files = new Set<string>(), tools = new Set<string>();
  const seen = new Set<string>();
  const cancel = (clearCache = false) => {
    generation++; controller?.abort(); controller = undefined; ctx = undefined;
    observations.clear(); files.clear(); tools.clear(); attempted = false;
    if (clearCache) seen.clear();
  };
  const permitted = () => options.enabled() && process.env.PI_OFFLINE !== '1' && !process.env.PI_SUBAGENT_CHILD
    && !['off','0'].includes(process.env.PI_SKILL_DISCOVERY ?? 'on');
  return {
    cancel,
    start(event: any, context: any) {
      cancel(); ctx = context; const raw = String(event.prompt ?? '');
      prompt = raw.length <= 4000 ? raw : raw.slice(0,2000) + '\n[Middle omitted]\n' + raw.slice(-1900);
    },
    observe(event: any) {
      if (!ctx || attempted || !permitted() || event.isError || !OBSERVED_TOOLS.has(event.toolName)) return;
      const input = event.input ?? {};
      // Several read-only diagnostics and query tools report their concrete
      // scope as `paths:[...]`. Treat that as the same bounded metadata as a
      // singular path; otherwise two successful path-scoped observations can
      // trigger discovery with no file evidence at all. Keep only workspace
      // relative paths and never include skill bodies or arbitrary URLs.
      const rawFiles = [
        ...(typeof input.path === 'string' ? [input.path] : []),
        ...(typeof input.file_path === 'string' ? [input.file_path] : []),
        ...(Array.isArray(input.paths) ? input.paths.slice(0, 24) : []),
      ];
      const observedFiles: string[] = [];
      for (const value of rawFiles) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /(?:^|[\\/])SKILL\.md$/i.test(value)) continue;
        const relative = path.relative(ctx.cwd, path.resolve(ctx.cwd, value));
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        const normalized = relative.replaceAll(path.sep, '/');
        if (!observedFiles.includes(normalized)) observedFiles.push(normalized);
        if (observedFiles.length >= 12) break;
      }
      if (!observedFiles.length && rawFiles.some(value => typeof value === "string" && /(?:^|[\\/])SKILL\.md$/i.test(value))) return;
      const file = JSON.stringify(observedFiles);
      const action = [input.action, input.operation, input.view].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value)) ?? '';
      // Search and AST tools often carry only a query/pattern/rule. Distinct
      // bounded values should count as distinct observations, but the value
      // itself must never enter the discovery packet or persisted metadata.
      const variant = [input.query, input.pattern, input.rule].find(value => typeof value === 'string' && value.length <= 4096);
      const variantKey = typeof variant === 'string'
        ? createHash('sha256').update(variant).digest('hex').slice(0, 16)
        : '';
      const key = `${event.toolName}:${file}:${action}:${variantKey}`;
      if (observations.has(key)) return;
      if (observations.size >= 24) observations.delete(observations.values().next().value!);
      observations.add(key); tools.add(event.toolName);
      for (const observedFile of observedFiles) {
        if (files.size >= 12) break;
        files.add(observedFile);
      }
      if (observations.size < 2) return;
      const runner = (globalThis as any)[RUNNER];
      if (typeof runner !== 'function') return;
      const catalog = options.catalog();
      if (!catalog.some(skill => !options.covered(skill.file))) return;
      const request = buildSkillDiscoveryRequest(catalog, {prompt, files:[...files], tools:[...tools], observations:[skillEvidenceContext({files:[...files],tools:[...tools]})]});
      if (!request.brief || !request.catalog.length) { attempted = true; return; }
      attempted = true; // Includes unavailable/invalid outcomes: no retry loop.
      if (seen.has(request.fingerprint)) return;
      seen.add(request.fingerprint);
      if (seen.size > 16) seen.delete(seen.values().next().value!);
      const epoch = generation, current = ctx;
      const abort = controller = new AbortController();
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(25_000), ...(current.signal ? [current.signal] : [])]);
      void Promise.resolve().then(() => {
        if (epoch !== generation || signal.aborted || !permitted()) return;
        return runner({brief:request.brief, task:prompt}, current, signal);
      }).then(body => {
        if (epoch !== generation || signal.aborted || !permitted() || typeof body !== 'string') return;
        for (const suggestion of parseSkillDiscoverySuggestions(body, request.catalog)) {
          const skill = options.catalog().find(item => item.name === suggestion.skill.name && item.file === suggestion.skill.file);
          if (skill && !options.covered(skill.file)) options.offer(skill, suggestion.reason);
        }
      }).catch(() => { /* Unavailable discovery leaves deterministic routing intact. */ })
        .finally(() => { abort.abort(); if (controller === abort) controller = undefined; });
    },
  };
}
