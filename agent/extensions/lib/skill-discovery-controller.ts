import path from 'node:path';
import { buildSkillDiscoveryRequest, parseSkillDiscoverySuggestions } from './skill-discovery.ts';
import { skillEvidenceContext, type SkillInfo } from './skill-relevance.ts';

const RUNNER = Symbol.for('yunus-pi.skill-discovery-runner.v1');
const OBSERVED_TOOLS = new Set(['read','edit','write','grep','find','ls','symbol_search','lsp_diagnostics','project_report','package_probe','openapi_probe','sqlite_probe','render_see','fetch_content','web_search','data_query','syntax_check','browser','browser_navigate','browser_snapshot','browser_click','browser_screenshot','http_request','coverage_probe','contract_diff','env_audit','net_probe','archive_probe','artifact_check']);

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
      if (typeof input.path === 'string' && /(?:^|[\\/])SKILL\.md$/i.test(input.path)) return;
      let file = '';
      if (typeof input.path === 'string' && input.path.length <= 1024) {
        const relative = path.relative(ctx.cwd, path.resolve(ctx.cwd, input.path));
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) file = relative;
      }
      const action = typeof input.action === 'string' && /^[a-z_]{1,24}$/.test(input.action) ? input.action : '';
      const key = `${event.toolName}:${file}:${action}`;
      if (observations.has(key)) return;
      if (observations.size >= 24) observations.delete(observations.values().next().value!);
      observations.add(key); tools.add(event.toolName);
      if (file && files.size < 12) files.add(file);
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
