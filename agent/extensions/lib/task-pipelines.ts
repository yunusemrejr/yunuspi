import { createHash } from 'node:crypto';
import { classifyExecution, type ExecutionProfile } from './adaptive-execution.ts';
import { seoTaskIntent } from './seo-policy.ts';
import { uiFileCue } from './ui-doctrine.ts';
import { skillActionSegments, skillIntentSegments, skillTaskText } from './skill-routing.ts';

export type TaskPipelineId = 'php' | 'node' | 'frontend-js' | 'vanilla-frontend' | 'react-cdn' | 'react-node' |
  'go' | 'rust' | 'java' | 'python' | 'python-flask' | 'bash' | 'c' | 'cpp' | 'linux-native' |
  'local-webapp' | 'algorithms' | 'ai-ml' | 'finetuning' | 'colab' | 'ui-quality' | 'git-ssh-deploy' |
  'image-media' | 'video' | 'audio' | 'svg-art' | 'debugging' | 'blender-3d' | 'seo' | 'llm-app' | 'api-automation' | 'office-docs' | 'file-organization' | 'data-wrangling' | 'research' | 'reinforcement-learning' | 'edge-ml' |
  'ui-motion' | 'ui-scroll' | 'ui-responsive' | 'ui-consistency' | 'web-3d' | 'codebase-control';
export type PipelinePhase = 'discovery' | 'implementation' | 'validation' | 'delivery';
export const PIPELINE_EVIDENCE_KINDS = ['inspection', 'artifact', 'execution', 'assessment', 'pixels', 'interaction', 'evaluation', 'remote', 'live', 'playback', 'listening'] as const;
export type PipelineEvidenceKind = (typeof PIPELINE_EVIDENCE_KINDS)[number];
export type PipelineStage = {
  id: string;
  phase: PipelinePhase;
  check: string;
  evidenceKinds: PipelineEvidenceKind[];
  dependsOn: string[];
  tools: string[];
};
export type PipelineSelection = {
  ids: TaskPipelineId[];
  fingerprint: string;
  skills: string[];
  tools: string[];
  stages: PipelineStage[];
};
export type TaskPipelineInput = {
  /** User request only. Tool-output prose must never become routing instructions. */
  prompt: string;
  /** Explicitly observed relevant files, not a crawl of every repository asset. */
  files?: readonly string[];
  /** Names from an inspected manifest; no dependency installation or scanning. */
  dependencies?: readonly string[] | Record<string, unknown>;
  /** Syntax facts from explicitly read/changed source, never tool-output instructions. */
  signals?: readonly PipelineSourceSignal[];
  /** Inherited authored constraints are checked without routing from parent subject nouns. */
  constraints?: string;
  /** Model-authored subtask descriptions cannot cancel parent exclusions. */
  inheritedConstraints?: string;
};

export type AutomaticPipelineInput = {
  prompt: string;
  /** The live scope may have escalated since initial intent selection. */
  profile?: Pick<ExecutionProfile, 'tier' | 'failures'>;
  files?: readonly string[];
  ledger?: PipelineLedger;
  coordinate?: PipelineCoordinate;
  constraints?: string;
  inheritedConstraints?: string;
};

export type PipelineSourceSignal = 'ui' | 'motion' | 'scroll' | 'responsive' | 'consistency' | 'web3d' | 'image-assets';
export type PipelineSourceMetadata = { dependencies: string[]; signals: PipelineSourceSignal[] };

/** Inspect bounded local syntax only. Comments, prose and dependency versions
 * are not instructions, and an installed package is not evidence of execution. */
export function inspectPipelineSource(file: string, source: string): PipelineSourceMetadata {
  const result: PipelineSourceMetadata = { dependencies: [], signals: [] };
  if (/(?:^|\/)package\.json$/i.test(file)) {
    try {
      const manifest = JSON.parse(source);
      result.dependencies = [...new Set(['dependencies', 'devDependencies', 'peerDependencies'].flatMap(key =>
        manifest?.[key] && typeof manifest[key] === 'object' && !Array.isArray(manifest[key]) ? Object.keys(manifest[key]) : []))].slice(0, 128);
    } catch { /* A malformed manifest supplies no dependency evidence. */ }
    return result;
  }
  if (!/\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte)$/i.test(file)) return result;
  const code = source.slice(0, 262144).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[^]*?-->/g, ' ').replace(/(^|[;\s])\/\/[^\n]*/gm, '$1');
  const add = (signal: PipelineSourceSignal, observed: boolean) => { if (observed) result.signals.push(signal); };
  add('ui', /<(?:html|main|div|section|button|canvas)\b|\b(?:document\.(?:querySelector|createElement)|createRoot\s*\()|(?:^|[{};])\s*[.#][\w-]+[^{}]*\{/m.test(code));
  add('motion', /@keyframes\b|\banimation(?:-name)?\s*:|\.animate\s*\(|\b(?:gsap|anime)\s*\.|(?:from\s*|import\s*\()['"](?:gsap|animejs|motion|framer-motion)['"]/.test(code));
  add('scroll', /\banimation-timeline\s*:\s*(?:scroll|view)|\b(?:ScrollTrigger|ScrollTimeline|ViewTimeline|IntersectionObserver)\b|\bscrollTrigger\s*:/.test(code));
  add('responsive', /@(?:media|container)\b|\b(?:matchMedia|ResizeObserver)\s*\(|\bclamp\s*\(/.test(code));
  add('consistency', /--[\w-]+\s*:|\bvar\s*\(\s*--|(?:from\s*|import\s*\()['"][^'"]*(?:tokens|theme|design-system)[^'"]*['"]/.test(code));
  add('web3d', /(?:from\s*|import\s*\()['"](?:three(?:\/[^'"]*)?|@react-three\/[^'"]+)['"]|\bTHREE\.|\b(?:WebGLRenderer|GLTFLoader|useGLTF)\b|getContext\s*\(\s*['"]webgl2?['"]/.test(code));
  add('image-assets', /url\s*\([^)]*\.(?:png|jpe?g|webp|avif)|<(?:img|picture)\b|(?:from\s*|import\s*\()['"][^'"]+\.(?:png|jpe?g|webp|avif)['"]/.test(code));
  return result;
}

const UI_SUBJECT = /\b(?:UI|UX|front[- ]?end|website|web ?page|landing page|dashboard|interface|layout|hero|typography|palette|spacing|scroll|responsive|mobile|tablet|breakpoints?|webgl|three\.?js)\b/i;
/** Short steering keeps the authored objective. Self-contained replacement
 * tasks and factual questions start fresh; synthetic prompts never call this. */
export function resolveRoutingTask(previous: string, next: string): { task: string; continuing: boolean } {
  if (!previous || !next.trim()) return { task: next, continuing: false };
  const text = skillTaskText(next);
  const reset = /^\s*(?:new task|different task|unrelated(?: task)?|start (?:over|fresh)|forget (?:that|the previous)|instead|what|why|who|when|where|which|explain|describe|define|tell me)\b/i.test(text)
    || /\b(?:build|create|make|start)\s+(?:me\s+)?(?:a|an|new|another|different)\b[^\n]{0,60}\b(?:app|website|project|service|tool|script|api|report|video|document)\b/i.test(text);
  const linked = /\b(?:it|its|them|that|same|continue|keep going|remaining|still)\b/i.test(text)
    || UI_SUBJECT.test(previous) && UI_SUBJECT.test(text) && !/\b(?:backend|database|authentication)\b/i.test(text);
  if (reset || text.length > 1600 || !linked) return { task: next, continuing: false };
  const boundedPrevious = previous.length > 20000 ? previous.slice(0, 14000) + '\n' + previous.slice(-6000) : previous;
  return { task: `${boundedPrevious}\n[User follow-up]\n${next}`, continuing: true };
}

/** Last authored positive/negative directive wins, including follow-up
 * corrections. Feature exclusions also apply to inspected source evidence. */
function featureExcluded(prompt: string, pattern: RegExp): boolean {
  let excluded = false;
  for (const clause of skillTaskText(prompt).split(/\n|[.!?](?:\s|$)|;|\bbut\b/i)) {
    if (!pattern.test(clause)) continue;
    const negative = [...clause.matchAll(/\b(?:no|without|skip|avoid|do not|don't|never|disable|exclude)\b([^.;\n!?]{0,90})/gi)].some(match => pattern.test(match[1]));
    if (negative) excluded = true;
    else if (skillActionSegments(clause).length || !QUESTION.test(clause) && (WORK.test(clause) || ACTION.test(clause))) excluded = false;
  }
  return excluded;
}

const FEATURE_TOOLS: ReadonlyArray<{ feature: RegExp; tools: readonly string[] }> = [
  { feature: /\b(?:git|github|version control)\b/i, tools: ['git_info'] },
  { feature: /\b(?:motion|animations?|animated|parallax|scroll[- ]?(?:animations?|driven|story|telling)|gsap|framer.motion)\b/i, tools: ['motion_inspect', 'motion_examples'] },
  { feature: /\b(?:scroll[- ]?(?:animations?|driven|story|telling)|scroll choreography|parallax)\b/i, tools: ['motion_inspect'] },
  { feature: /\b(?:3d|webgl|three\.?js|gltf|glb)\b/i, tools: ['video_shot', 'asset_register', 'blender_setup', 'blender_inspect', 'blender_run', 'blender_render', 'blender_export'] },
  { feature: /\bblender\b/i, tools: ['blender_setup', 'blender_inspect', 'blender_run', 'blender_render', 'blender_export'] },
  { feature: /\b(?:image generation|generate\w* images?|generated (?:images?|imagery))\b/i, tools: ['image_generate'] },
  { feature: /\b(?:responsive|multi[- ]device|device matrix|breakpoints?)\b/i, tools: ['ui_explore'] },
  { feature: /\b(?:consistency|design systems?|shared tokens?|token consistency)\b/i, tools: ['ui_consistency'] },
];
export function pipelineToolExcluded(prompt: string, name: string): boolean {
  const exact = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return featureExcluded(prompt, exact) || FEATURE_TOOLS.some(rule => rule.tools.includes(name) && featureExcluded(prompt, rule.feature));
}

/** Pipelines whose work is judged on the produced file or the resulting folder, not on project tests. */
const MEDIA_ONLY: readonly TaskPipelineId[] = ['image-media', 'video', 'audio', 'svg-art', 'blender-3d', 'office-docs', 'file-organization', 'data-wrangling', 'research'];

/** A negative request must not stage the very tool it excludes. Kept shared
 * with legacy intent bundles so activation owners cannot disagree. */
export const pipelineGitExcluded = (prompt: string): boolean =>
  featureExcluded(prompt, /\b(?:git(?:hub)?|version control)\b/i);

/** A catalog lists every available stage, not every schema needed now. Both
 * initial intent and live scope activation use this single, I/O-free policy.
 * Explicit discovery remains the wire owner's authority outside this policy. */
export function automaticPipelineTools(selection: PipelineSelection, input: AutomaticPipelineInput): string[] {
  if (!selection.ids.length) return [];
  const prompt = typeof input?.prompt === 'string' ? input.prompt.slice(0, 32768) : '';
  const constraints = typeof input?.constraints === 'string' ? input.constraints.slice(0, 32768) : prompt;
  const excluded = (name: string) => pipelineToolExcluded(constraints, name) || Boolean(input.inheritedConstraints && pipelineToolExcluded(input.inheritedConstraints, name));
  const profile = input.profile ?? classifyExecution({ task: prompt });
  const quality = selection.stages.some(stage => stage.id === 'source-quality') || profile.tier === 'complex' || profile.tier === 'critical' || profile.failures >= 2 ||
    /\b(?:code_quality|refactor\w*|architectur\w*|code (?:quality|review|smells?)|source (?:audit|review)|(?:audit|review) (?:[\w.+/-]+ ){0,3}(?:code|source)|tech(?:nical)? debt|duplicat\w* (?:code|logic)|dead code|unused (?:code|imports?|exports?)|cyclomatic|lint(?:ing|er|s)?)\b/i.test(prompt);
  const gitMetadata = (input.files ?? []).some(file => typeof file === 'string' &&
    /(?:^|\/)(?:\.git\/(?:HEAD|config|index|refs\/[^\n]+)|\.gitmodules)$/i.test(file.replaceAll('\\', '/')));
  const git = !excluded('git_info') && (selection.ids.includes('git-ssh-deploy') || gitMetadata ||
    /\b(?:git(?:hub)?|commits?|committing|pull requests?|pre-?commit|rebase|repository history|release (?:process|pipeline|version|tag)|(?:push|merge) (?:the |this |my )?(?:branch|commit|changes)|push (?:to )?(?:origin|upstream))\b/i.test(prompt));
  const control = selection.ids.some(id => ['ui-motion', 'ui-scroll', 'ui-responsive', 'ui-consistency', 'web-3d', 'codebase-control'].includes(id)) || profile.tier === 'complex' || profile.tier === 'critical' ||
    /\b(?:task_pipeline|pipelines?|workflows?|subtask scopes?|stage (?:status|evidence|receipts?))\b/i.test(prompt);
  const codeWork = selection.ids.some(id => !MEDIA_ONLY.includes(id));
  const ready = input.ledger && input.coordinate ? nextPipelineStages(selection, input.ledger, input.coordinate) : selection.stages.filter(stage => stage.phase === 'discovery');
  const currentTools = new Set(ready.flatMap(stage => stage.tools));
  // Keep planning/building schemas usable during repair. Temporal/matrix
  // validators appear when their prerequisites have actual evidence.
  const deferred = new Set(['motion_inspect', 'ui_explore', 'ui_consistency']);
  return [...new Set([
    ...selection.tools.filter(name => !excluded(name) && (!deferred.has(name) || currentTools.has(name)) &&
      (name === 'code_quality' ? codeWork && quality : name === 'project_tests' ? codeWork : name === 'git_info' ? git : name !== 'task_pipeline')),
    ...(control && !excluded('task_pipeline') ? ['task_pipeline'] : []),
    ...(profile.failures >= 2 ? ['symbol_search', 'context_slice', 'code_audit'].filter(name => !excluded(name)) : []),
  ])];
}

type Recipe = { skills: string[]; discovery: string; validation: string; tools?: string[] };
const RECIPES: Record<TaskPipelineId, Recipe> = {
  'ui-motion': { skills: ['motion', 'motion-approaches'], discovery: 'Choose motion from the subject and existing design direction: one signature, focal hierarchy, transform ownership and cleanup. Use ui_recipe plan for an editable starting point; choose a static baseline and reduced-motion fallback before choreography.', validation: 'Use motion_inspect for current temporal samples and reduced-motion evidence. Inspect real playback and keyboard/focus behavior separately; sampled motion and exit zero do not establish aesthetic or interaction approval.', tools: ['creative_direct', 'ui_recipe', 'motion_examples', 'motion_inspect'] },
  'ui-scroll': { skills: ['motion', 'browser-javascript-engineering'], discovery: 'Inspect the real scroll container, sticky owners, source timelines and content order. Plan scroll-reveal or scroll-story with ui_recipe; preserve native scrolling, direct anchor navigation and a static fallback without forcing every block to fade up.', validation: 'Use motion_inspect mode scroll for forward/backtrack positions and reduced motion on one persistent page. Check pinned content, progress boundaries, resize and keyboard navigation; unavailable coverage remains unresolved.', tools: ['creative_direct', 'ui_recipe', 'motion_inspect'] },
  'ui-responsive': { skills: ['product-ui-verification', 'web-performance'], discovery: 'Identify content-driven breakpoints, intended devices, pointer/touch/DPR assumptions and long-content states from the existing owner. Responsive styling needs bounded served-device evidence; a CSS declaration is not device coverage.', validation: 'Use ui_explore devices and breakpoint neighbors for a bounded capture matrix. Preserve explicit omitted coverage; resolve overflow and content failures. Emulation, DOM facts and captures do not prove real hardware performance or interaction.', tools: ['ui_explore'] },
  'ui-consistency': { skills: ['design-systems', 'accessible-interaction-design'], discovery: 'Inspect the shared component/token owner and established visual identity before local overrides. Keep a subject-specific direction with creative_direct; retain declared variants instead of making every component identical.', validation: 'Use ui_consistency on representative routes/components and tokens. Resolve measured role/token drift and missing coverage against declared variants, then judge actual pixels. No default gradient, card grid, fake metric or generic editorial formula substitutes for the product identity.', tools: ['creative_direct', 'ui_consistency'] },
  'web-3d': { skills: ['threejs', 'web-performance'], discovery: 'Inspect the installed Three.js/renderer version, target asset format, camera/material/animation ownership and loader cleanup. Use ui_recipe three-model plan, reuse licensed assets or author a Blender asset, and register provenance. Plan a static/no-WebGL/phone/reduced-motion fallback.', validation: 'Inspect exported glTF/GLB dependencies and budgets with asset_register, then capture the actual served integration and exercise load failure, resize, reduced motion, context loss and disposal. Software-rendered pixels do not measure GPU performance.', tools: ['creative_direct', 'ui_recipe', 'asset_register', 'blender_inspect', 'blender_run', 'blender_render', 'blender_export', 'image_analyze', 'image_generate'] },
  'codebase-control': { skills: ['coding-practices', 'software-engineering-wisdom'], discovery: 'Use bounded project_report/module_report, symbol_search and context_slice evidence to identify the established owner, callers, shared UI/API contracts, affected files and checks before editing. Do not infer impact from a directory name or scan every file.', validation: 'Use code_quality/code_audit for the affected revision and existing focused checks where warranted. bulk_edit preview supports a reviewable multi-file change; its apply remains an explicit agent action. Repeated failures require narrowed source/impact evidence before another attempt.', tools: ['project_report', 'module_report', 'symbol_search', 'context_slice', 'code_quality', 'code_audit', 'bulk_edit'] },
  php: { skills: ['php-application-engineering'], discovery: 'Inspect Composer PHP constraints, PHP 8+ syntax support, CLI and web SAPI versions/extensions, document root and session/filesystem rules.', validation: 'Run PHP lint on changed sources and the existing focused request/auth/database checks; check CLI versus FPM/shared-host behavior where relevant.' },
  node: { skills: ['node-runtime-engineering'], discovery: 'Inspect package scripts, lockfile, installed Node version, ESM/CJS mode and the actual service/CLI entry point.', validation: 'Use the project scripts or Node check/test runner for affected behavior, async failures, shutdown and resource cleanup.' },
  'frontend-js': { skills: ['frontend-js', 'browser-javascript-engineering'], discovery: 'Identify browser versus Node execution from the actual entry point. For browser work inspect module/load order, supported browsers and existing DOM/state conventions.', validation: 'Check modules in their actual runtime. Browser changes need relevant events, async failures, repeated mounting and cleanup checks; a pure function can use a focused local check.' },
  'vanilla-frontend': { skills: ['vanilla-web-libs', 'browser-javascript-engineering'], discovery: 'Keep the existing HTML/CSS/DOM stack; inspect native controls, module/CDN policy and any necessary small library before adding dependencies.', validation: 'Verify the page through its real served URL, including load order and keyboard operation; avoid requiring a build step for a working static page.' },
  'react-cdn': { skills: ['modern-frontend-frameworks'], discovery: 'Inspect pinned React/ReactDOM CDN URLs, globals or import maps, JSX transformation and root mounting. Preserve the chosen no-build deployment mode.', validation: 'Run the served CDN edition in a browser; inspect React/ReactDOM compatibility, network/CSP/module failures and the representative interaction.' },
  'react-node': { skills: ['modern-frontend-frameworks'], discovery: 'Inspect React versions, bundler, package scripts, lockfile, route/state ownership and client/server boundaries.', validation: 'Run the affected type/build/test scripts and use the actual served application to check the representative React state transition.' },
  go: { skills: ['go-service-engineering'], discovery: 'Inspect go.mod/toolchain, package boundaries, entry point, context cancellation and service/CLI contracts.', validation: 'Run focused go test and applicable vet/build checks; use the race detector when shared-state changes warrant it.' },
  rust: { skills: ['rust-systems-engineering'], discovery: 'Inspect Cargo workspace, edition/toolchain, feature flags, target and ownership/error conventions.', validation: 'Run the affected Cargo tests/checks and relevant lint/build profile; exercise failure and cleanup paths rather than inventing new unsafe code.' },
  java: { skills: ['java-platform-engineering'], discovery: 'Inspect the JDK target, Maven/Gradle wrapper, modules, dependencies and runtime/service entry point.', validation: 'Use the existing Maven/Gradle wrapper for affected tests and packaging; check cancellation/resource disposal where changed.' },
  python: { skills: ['python-software-engineering'], discovery: 'Inspect pyproject/requirements, the actual interpreter/environment and module/CLI entry point.', validation: 'Run changed-source syntax and affected existing tests; check the intended interpreter and dependency versions.' },
  'python-flask': { skills: ['python-software-engineering', 'web-security'], discovery: 'Inspect Flask app factory, routes, environment, auth/session/CSRF handling and development versus production WSGI entry points.', validation: 'Exercise representative Flask routes with the test client and real serving path where relevant, including boundary validation and error responses.' },
  bash: { skills: ['linux'], discovery: 'Inspect the shebang, target shell, quoting, exit/status handling and command side effects.', validation: 'Use bash -n or the declared shell plus available ShellCheck; exercise representative failure/cleanup paths safely.' },
  c: { skills: ['c-systems-engineering'], discovery: 'Inspect the C standard, compiler/build flags, ABI, allocation ownership and integer boundaries.', validation: 'Run the affected build/tests and applicable warnings/sanitizers for memory or integer changes; verify cleanup/failure paths.' },
  cpp: { skills: ['cpp-performance-engineering', 'c-cpp-multiplatform'], discovery: 'Inspect the C++ standard, CMake/Make target, compiler, ABI and resource/concurrency ownership.', validation: 'Run the affected build/tests and applicable warnings/sanitizers; measure performance claims on the actual workload.' },
  'linux-native': { skills: ['linux', 'desktop-app-dev'], discovery: 'Inspect the actual Linux entry point, toolkit, packaging, display/audio services and host dependencies.', validation: 'Launch the installed/native application normally and exercise its actual CLI or GUI input and shutdown. For a GUI inspect real displayed content; an offscreen render does not prove the native UI.' },
  'local-webapp': { skills: ['web-security', 'product-ui-verification'], discovery: 'Inspect local host/port ownership, startup/shutdown, persistent data boundaries and frontend/backend connection.', validation: 'Start through the documented local command and check a representative browser-to-backend task, error state and cleanup.' },
  algorithms: { skills: ['algorithm-design', 'numerical-computing'], discovery: 'State the input contract, invariants, scale, exactness requirements and existing baseline before choosing the algorithm.', validation: 'Use a reference/oracle or invariant-based checks for boundaries and adversarial inputs; measure claimed complexity or speed on representative inputs.' },
  'ai-ml': { skills: ['ml-engineering', 'model-evaluation'], discovery: 'Inspect objective, dataset provenance/splits, baseline, model/runtime versions and deployment constraints. Use ml_lab preflight and split_audit; recipe supplies bounded local MLP/Q and embedding/LoRA trainers.', validation: 'Use ml_lab evaluate on aligned frozen predictions and the same baseline; inspect slices and uncertainty. Keep train-only preprocessing, durable checkpoints, data/config hashes and resume evidence; separate quality, latency and cost from availability.', tools: ['ml_lab'] },
  research: { skills: ['research', 'data-lineage-validation'], discovery: 'State question, date/region/version scope and source coverage. Use varied queries and primary source reads with web_research; reuse cached pages and query-ranked passages with hashes/locations.', validation: 'Use research_toolkit dossier on attributable snapshots and explicit claims. Resolve missing/stale quotations, copied-source independence, dates/units and contradictions; inspect context before conclusions. Distinguish facts, interpretations and unknowns.', tools: ['web_research', 'fetch_content', 'get_search_content', 'research_toolkit', 'claim_check'] },
  'reinforcement-learning': { skills: ['reinforcement-learning', 'rl-decision-systems'], discovery: 'Inspect real reset/step observations, actions, rewards, seeds, time limits and partial observability. Run a random/scripted baseline. Use ml_lab rl_targets on a tiny trajectory; tabular_q is an offline reference, not environment policy evidence.', validation: 'Check final-observation bootstraps, reward hacking, finite updates, replay/rollout boundaries and checkpoints. Evaluate frozen greedy policies on separate seeds/tasks without exploration or learning; compare baseline returns with uncertainty.', tools: ['ml_lab'] },
  'edge-ml': { skills: ['edge-model-deployment', 'numerical-computing'], discovery: 'Inspect actual target ISA/runtime, RAM/flash/latency/energy budgets, dataset and simple baseline. Use train-only quantization calibration and keep original checkpoints.', validation: 'Compare original and exported/quantized predictions on the same frozen cases with ml_lab evaluate. Measure target inference/memory/latency and boundary errors; a small file or catalog entry does not verify target support.', tools: ['ml_lab'] },
  finetuning: { skills: ['llm-fine-tuning', 'llm-dataset-preparation'], discovery: 'Inspect immutable model/tokenizer revision, license, GPU memory, data hashes/splits, loss masking, training method and checkpoint destination.', validation: 'Validate collated batches and the requested preparation/execution scope. A prepared script or notebook is not a successful training run.' },
  colab: { tools: ['ml_lab', 'browser_session', 'bg_run'], skills: ['google-colab-training'], discovery: 'Choose the actually available Colab browser/CLI/Enterprise/local-Jupyter connection; inspect real runtime/GPU and durable storage only within authorized scope.', validation: 'Validate notebook cells as independently rerunnable setup/data/smoke/train/evaluate/export steps. Report connected runtime and resource state; never infer GPU access from a local notebook.' },
  'ui-quality': { skills: ['design-slop-prevention', 'ui-antipattern-review', 'accessible-interaction-design', 'product-ui-verification'], discovery: 'Inspect the existing product, tasks, real content, tokens and components before choosing a direction. Ground palette/type/layout and purposeful motion in the subject and user ambition. Consult design guides when useful; avoid template identities, fake proof and ornaments without a job.', validation: 'Use ui_explore at 320px, mobile, tablet and desktop, including relevant dark/reduced-motion/full-page states. Judge current pixels with visual_review and its runId; text-only routes use permitted image_understand/vision evidence. Check real interaction and keyboard/focus with browser_session. Unknown or stale evidence remains open.', tools: ['render_see', 'design_audit', 'ui_explore', 'visual_review', 'image_understand', 'quality_review'] },
  'image-media': { skills: ['key-visual-art-direction', 'svg-assessment'], discovery: 'Identify image roles, exact generation/edit model and reference/mask constraints. Preserve originals and inspect source dimensions/alpha. Use image_understand with the selected vision model for semantic questions and image_analyze for pixel measurements.', validation: 'Decode delivered images and review actual pixels at intended sizes. Inspect edit fidelity, alpha, crop and source hashes. Provider catalog presence and model observations do not prove artistic quality or factual accuracy.', tools: ['image_generate', 'image_understand', 'image_convert', 'image_analyze', 'visual_review'] },
  video: { skills: ['code-first-video', 'motion-approaches', 'key-visual-art-direction', 'terminal-video-editing', 'video-analysis'], discovery: 'Probe existing source streams, frame timing and audio for editing or analysis. For creation, establish a topic-specific storyboard and one master video.json timeline. Preserve the full creative_direct brief with video_project direction. For fixed-camera ambient environments, approve a detailed image/Blender plate and sky mask first, then use video_ambient for deterministic RGB clouds/rain/lighting while terrain/buildings stay still. A primitive blockout cannot satisfy a photographic reference. Choose the hero by semantic intent and reference quality; use Blender code/models for editable geometry, image_generate with the explicit selected image model for artwork/backplates/textures, and video_assets import to preserve provenance. Combine native image/shot/video layers or image-plane cards in Blender depth; mark blockout/draft assets explicitly. Use video_project compose for native fitted typography and reserved asset regions before inventing custom scene code. video_generate plans hosted clips with the exact selected video route and durable submission/status receipts. video_shot scene builds editable devices/forms with shared instances, per-key easing, camera paths, smooth object motion, PBR maps and tracked screen corners; imported blends retain authored cameras. video_browser supplies real mobile/desktop interactions; importing take metadata gives cursor-follow framing and accents on observed clicks. Use video_project action:plan for the current flow and exact next calls. Retain beat claim/visualAction; use custom code when native layers cannot express the argument. Prove a demanding scene with video_render mode:review before expensive full-film or Blender finals, inspect its critical cue/cut pixels and bounded playback, then cover every remaining scene. Discover motion_examples for specialized motion beyond the native compositor. Narration backend:auto prefers configured ElevenLabs. Long films use resumable video_render segments on the global frame clock; continue complete:false receipts until assembly is complete.', validation: 'Run media_sync for word coverage, cue frames, narration/cut boundaries and the delivered A/V end. Reuse decode and mastering receipts. Inspect full-size hero/detail frames against the brief and reference pixels; record art-direction separately from composition/typography and playback verdicts with video_qa. Inspect frames and actual playback across scene and segment joins; listen to the final encoding for narration, music and clean endings.', tools: ['creative_direct', 'image_generate', 'image_understand', 'image_convert', 'video_generate', 'video_assets', 'blender_run', 'video_project', 'motion_examples', 'video_shot', 'video_browser', 'video_ambient', 'narration_tts', 'media_sync', 'video_render', 'video_qa', 'media_info', 'video_frames', 'media_pipeline', 'scene_create', 'scene_render'] },
  audio: { skills: ['audio-processing', 'sound-analysis', 'music-composition'], discovery: 'Probe channels, sample rates and durations; establish voice/music/effect roles and delivery format. Discover narration_tts (ElevenLabs preferred when configured, Piper available), narration_align for supplied transcript timing, audio_generate for instrumental music/SFX, and music_compose for editable scores. Arrange longer soundtracks in sections.', validation: 'Check media_sync word/cue precision and music_grid against an authored tempo. Reuse delivered mastering measurements, then listen for intelligibility, artifacts, seams and endings; provider alignment is not independent transcription and oscillator previews do not establish instrument quality. music_compose can render real SoundFont instruments with a supplied SF2/SF3 bank and libfluidsynth; keep editable MIDI and audition release tails.', tools: ['media_info', 'audio_analyze', 'narration_tts', 'narration_align', 'audio_generate', 'music_compose', 'audio_mix', 'media_sync'] },
  'svg-art': { skills: ['custom-svg', 'svg-assessment'], discovery: 'Inspect viewBox, geometry, transforms, inherited paint, references, accessibility and the intended sizes/backgrounds. Keep the requested visual direction and a consistent icon-set grammar.', validation: 'Use svg_inspect source measurements and svg_render at intended sizes and explicit CSS/SMIL/data-track timestamps; fix owner collisions and inspect cadence/loop diagnostics. Inspect pixels for clipping, small-size legibility, optical balance and consistent visual weight; approximate geometry does not establish conformance.', tools: ['svg_inspect', 'svg_render'] },
  debugging: { skills: ['debugging'], discovery: 'Capture the actual failing command/input, first diagnostic, source location and relevant runtime versions. Use symbol_search/context_slice to follow the established owner; minimize one falsifiable hypothesis before repair.', validation: 'Rerun the same minimal reproducer after repair, then affected project checks. Preserve first-failure diagnostics and source-bound receipts; a retry, background launch or zero collected tests cannot establish a fix.', tools: ['project_tests', 'symbol_search', 'context_slice'] },
  'blender-3d': { skills: ['blender-production', 'gaussian-splatting'], discovery: 'Inspect the saved scene or source assets with blender_inspect (units, scale, object and material inventory, polygon and texture budgets). Inspect layered keyframe channels and evaluated frames for drivers/NLA; establish source fps, destination format, axes, budgets and the look reference before modeling. video_shot action:plan validates pixel-sample work, references, shared arrays and camera paths before creating output; render a short draft first. Prefer native video_shot scene graphs for designed forms/devices and licensed imported assets for detailed heroes; preserve authored cameras and stage foreground/midground relationships before adding detail.', validation: 'Run blender_inspect on the final scene (manifold, normals, applied scale, UV coverage, budgets) and validate every exported file in its target format. Verify stepped sequence timing and delivered video decode; an explicit output fps retimes rendered samples. Inspect actual playback for motion and narration sync. A viewport or one turntable orbit is not evidence of appearance.', tools: ['blender_setup', 'blender_inspect', 'blender_run', 'blender_render', 'blender_export', 'video_shot', 'image_generate', 'image_understand', 'image_convert', 'video_generate', 'video_assets'] },
  seo: { skills: ['search-discoverability', 'organic-growth-engineering'], discovery: 'Website/content work includes SEO without an explicit SEO request. Establish public/private routes, canonical host, locales, audience questions and page purpose with seo_toolkit plan. Audit the served public site or inspect built HTML before changing common owners; private apps stay private.', validation: 'Use seo_toolkit inspect/audit and discovery for canonical/status/robots/sitemap/link graph/hreflang/schema/media/cache and synchronized public discovery files. Review useful original content, genuine identity and source dates; inspect rendered/mobile behavior, measure performance and re-audit production after authorized deployment. No fabricated claims, demand or freshness; submitted/crawled/indexed differ.', tools: ['seo_toolkit', 'web_probe', 'web_search', 'fetch_content'] },
  'llm-app': { skills: ['llm-systems-engineering', 'rag-engineering', 'model-evaluation'], discovery: 'Inspect the provider interface, prompt and tool contracts, retrieval sources, existing evals and cost and latency budgets. Freeze a representative golden set and a simple baseline before changing prompts or models.', validation: 'Validate structured outputs and tool contracts, and exercise prompt-injection, malformed-output, timeout and refusal paths. Compare against the baseline on the frozen set with a slice breakdown.' },
  'api-automation': { skills: ['api-design', 'evidence-first-engineering', 'distributed-systems'], discovery: 'Read each provider\'s auth, scope, rate-limit, pagination and webhook-delivery documentation, and inspect existing clients, secret handling and the state the workflow must persist. Define the state machine, idempotency keys and approval points before coding.', validation: 'Dry-run or sandbox the workflow first, then run a failure-injection pass (timeout, 429, 5xx, partial batch) and an idempotent re-run. Verify there are no duplicate side effects and that secrets never reach logs or prompts.', tools: ['http_request'] },
  'office-docs': { skills: ['spreadsheet-authoring', 'word-document-authoring', 'presentation-authoring'], discovery: 'Open the source, template or example first (office_doc read) and settle structure, language, units and the real data before writing. Never hand-write OOXML: build docx, xlsx and pptx from a spec with office_doc build; edit an existing file on a copy and keep the original.', validation: 'Open the produced file with office_doc read or verify, or deliverable_check, and resolve every error and warning (placeholders, uncalculated or error formulas, empty slides, damaged package). For anything a person will look at, render pages (office_doc render) and judge layout. A script printing "Saved x" is not evidence.', tools: ['office_doc', 'deliverable_check'] },
  'file-organization': { skills: ['file-organization'], discovery: 'Resolve a loosely named folder with ls or find, then run fs_organize scan on it before choosing a scheme. Do not move files with mv or find loops: they overwrite on name clashes and cannot be undone.', validation: 'fs_organize apply verifies itself: check verification.ok and the file counts, report moved and skipped counts and the folders created, and keep the planId for undo. Never delete files; identical copies go to Duplicates for the user to decide.', tools: ['fs_organize', 'ls', 'find'] },
  'data-wrangling': { skills: ['data-analysis', 'data-lineage-validation'], discovery: 'Profile every input before transforming it: columns and types, row counts, empty and duplicate keys, encodings, date and number formats, units, and what each field means. Keep the originals untouched and write results to new files.', validation: 'Reconcile the output with the input: row counts in and out with every dropped, merged or split row accounted for, totals and distinct keys on the numeric and key columns, and a spot check of a few real rows. Look for silent type changes (lost leading zeros, mangled dates, long ids in scientific notation). Open the produced file with deliverable_check. A script that exits zero is not a reconciliation.', tools: ['deliverable_check', 'office_doc'] },
  'git-ssh-deploy': { skills: ['git-github', 'multi-developer-pipelines'], discovery: 'Inspect Git source/remote/history and the explicitly authorized SSH destination, document root, runtime, protected data and rollback path. Namecheap/GoDaddy branding does not establish account capabilities; discover actual cPanel/VPS/SSH support.', validation: 'Verify the local release/build, deployment manifest and rollback before remote promotion. Keep secrets, uploads and databases outside accidental sync; Git push alone does not prove a live deployment.', tools: ['git_info', 'ssh_plan', 'net_probe', 'env_audit'] },
};

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const bounded = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';
const WORK = /\b(?:build|create|implement|fix|debug|improve|refactor|edit|change|update|test|validate|verify|review|audit|write|develop|deploy|publish|release|train|finetune|fine[- ]tune|prepare|design|optimize|optimise|run|add|remove|make|render|mix|compose|denoise|normalize|synthesize|time[- ]stretch)\b/i;
/** Further action verbs. Measured: 23 of 24 ordinary imperative prompts ("Generate a REST API in Go",
 * "Export the Blender scene", "Migrate the PHP app", "Cut the interview video") matched no pipeline because
 * none of the verbs above appeared, so their skills, evidence stages and tool schemas never activated.
 * Nouns such as model, port or cut only count when imperative, and question-shaped requests never do. */
const ACTION = /\b(?:organi[sz]e|declutter|tidy|de-?duplicate|dedupe|rename|generate|convert|export|import|automate|integrate|configure|set ?up|migrate|scrape|crawl|analy[sz]e|enhance|upgrade|rewrite|install|wire|schedule|connect|sync|ship|produce|craft|trim|composite|extend|polish|harden|benchmark|investigate|diagnose|troubleshoot|clean ?up|speed ?up|extract|parse|transcribe|translate|compress|encode|merge|restructure|scaffold|bootstrap|launch|bake|unwrap|retopologi[sz]e|port|cut|capture|record|profile|monitor|document)\b|(?:^|[.!?:]\s+)(?:please\s+)?(?:model|sculpt|animate|rig|texture|illustrate|paint|draw)\b/i;
/** Transforming tabular data: a data verb followed by a data noun, or two or more data files named together. */
const DATA_TASK = /\b(?:clean(?:\s|-)?up|clean|merge|join|combine|consolidate|reconcile|de-?duplicate|dedupe|normali[sz]e|transform|aggregate|pivot|split|convert|parse|extract|summari[sz]e|filter|sort|fix|repair|import|export)\b[^\n.]{0,60}\b(?:csv|tsv|jsonl|ndjson|json files?|data ?sets?|spreadsheets?|excel (?:files?|sheets?)|tables?|rows|columns|records|log files?|exports?)\b/i;
const QUESTION = /^\s*(?:what|why|how|who|whom|whose|when|where|which|is|are|was|were|does|do|did|explain|describe|define|tell me|summari[sz]e|list|compare)\b/i;
const IGNORED_FILE = /(?:^|\/)(?:node_modules|vendor|\.git|skills)(?:\/|$)|(?:^|\/)SKILL\.md$/i;

/** Metadata-only routing: no models, commands, project crawling, or skill-body injection. */
export function selectTaskPipelines(input: TaskPipelineInput): PipelineSelection {
  const prompt = bounded(skillTaskText(typeof input?.prompt === 'string' ? input.prompt : ''), 24000);
  const constraints = bounded(input?.constraints, 32768) || prompt;
  const excluded = (pattern: RegExp) => featureExcluded(constraints, pattern) || Boolean(input.inheritedConstraints && featureExcluded(input.inheritedConstraints, pattern));
  const files = (Array.isArray(input?.files) ? input.files : []).slice(-64)
    .filter(file => typeof file === 'string' && file.length <= 2048)
    .map(file => file.replaceAll('\\', '/')).filter(file => !IGNORED_FILE.test(file));
  const dependencies = new Set((Array.isArray(input?.dependencies) ? input.dependencies : Object.keys(input?.dependencies ?? {})).slice(0, 128).map(name => String(name).toLowerCase()));
  const signals = new Set(Array.isArray(input?.signals) ? input.signals : []);
  const clauses = unique([...skillActionSegments(prompt), ...skillIntentSegments(prompt).filter(clause => !QUESTION.test(clause) && (WORK.test(clause) || ACTION.test(clause)))]);
  const requested = (pattern: RegExp) => clauses.some(clause => pattern.test(clause)) && !excluded(pattern);
  const ids: TaskPipelineId[] = [];
  const add = (id: TaskPipelineId, selected: boolean) => { if (selected) ids.push(id); };
  const has = (pattern: RegExp) => files.some(file => pattern.test(file));
  const dataTask = DATA_TASK.test(prompt) && !QUESTION.test(prompt);
  const research = !QUESTION.test(prompt) && (/\bresearch\b|\b(?:investigate|analy[sz]e|read)\b[^\n]{0,60}\b(?:papers|sources|web pages|literature)\b/i.test(prompt))
    && (!/\b(?:codebase|repo(?:sitory)?|local project|project structure)\b/i.test(prompt) || /\b(?:web|online|literature|papers|github|primary sources|external sources)\b/i.test(prompt));
  const active = WORK.test(prompt) || (ACTION.test(prompt) && !QUESTION.test(prompt)) || research || dataTask || files.length > 0;
  if (!active || excluded(/\b(?:tools?|workflows?|pipelines?)\b/i))
    return { ids, fingerprint: 'none', skills: [], tools: [], stages: [] };

  const cdn = /\breact(?:\.js)?\b/i.test(prompt) && /\b(?:cdn|no[- ]build|import[- ]map|script[- ]tag)\b/i.test(prompt);
  const react = /\breact(?:\.js)?\b/i.test(prompt) || has(/\.(?:jsx|tsx)$/i) || dependencies.has('react');
  const backendOnly = /\b(?:backend|api|authentication|database)\b/i.test(prompt) && !/\b(?:front[- ]?end|layout|palette|css|html|visual|form|screen|UI|UX|render)\b/i.test(prompt);
  const frontend = (!backendOnly && /\b(?:front[- ]?end|browser|webpage|web page|website|webapp|landing page|home ?page|html|css|DOM|vanilla javascript|vanilla js)\b/i.test(prompt)) || has(/\.(?:html|css|jsx|tsx|vue|svelte)$/i) || react || signals.has('ui');
  add('php', /\bphp(?:\s*8(?:\.\d+)?\+?)?\b/i.test(prompt) || has(/\.(?:php|phtml)$/i) || has(/(?:^|\/)composer\.json$/i));
  add('node', /\bnode(?:\.js|js)?\b/i.test(prompt) || has(/\.(?:mjs|cjs)$/i) || (has(/(?:^|\/)package\.json$/i) && !cdn) || dependencies.has('express') || dependencies.has('fastify'));
  add('frontend-js', frontend || /\b(?:javascript|js)\b/i.test(prompt) || has(/\.(?:js|ts)$/i));
  add('vanilla-frontend', frontend && !react && (/\bvanilla\b|\bstatic (?:site|page|website)\b/i.test(prompt) || has(/\.(?:html|css)$/i)));
  add('react-cdn', cdn);
  add('react-node', react && !cdn);
  add('go', /\bGo\b/.test(prompt) || /\b(?:golang|go (?:language|service|server|module|application|app|cli|code|test|build)|(?:in|using) go)\b/i.test(prompt) || has(/\.go$|(?:^|\/)go\.mod$/i));
  add('rust', /\brust\b/i.test(prompt) || has(/\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$/i));
  add('java', /\bjava\b/i.test(prompt) || has(/\.java$|(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/i));
  add('python', /\bpython\b/i.test(prompt) || has(/\.(?:py|ipynb)$|(?:^|\/)(?:pyproject\.toml|requirements[^/]*\.txt)$/i) || dependencies.has('flask'));
  add('python-flask', /\bflask\b/i.test(prompt) || dependencies.has('flask'));
  add('bash', /\b(?:bash|shell script|shell scripting)\b/i.test(prompt) || has(/\.(?:sh|bash)$/i));
  add('c', /(?:\bC programming\b|\bC language\b|\bC\/C\+\+\b)/i.test(prompt) || has(/\.c$/i));
  add('cpp', /(?:\bC\+\+|\bcpp\b|\bC\/C\+\+)/i.test(prompt) || has(/\.(?:cpp|cc|cxx|hpp)$/i));
  add('linux-native', /\blinux[- ]native\b|\bnative (?:linux|desktop|application|app)\b/i.test(prompt));
  add('local-webapp', /\blocal (?:webapp|web app|website)\b|\blocalhost\b/i.test(prompt));
  add('algorithms', /\balgorithm(?:s|ic)?\b|\bdata structures?\b/i.test(prompt));
  const tuning = /\b(?:finetun(?:e|ing)|fine[- ]tun(?:e|ing)|lora|qlora|sft|dpo)\b/i.test(prompt) || dependencies.has('peft') || dependencies.has('trl');
  const rl = /\b(?:reinforcement learning|RL|q[- ]learning|policy gradient|rollout buffer|bandits?)\b/i.test(prompt);
  const edge = /\b(?:edge (?:devices?|models?|AI)|tinyml|microcontroller|tflite|onnx|quantiz(?:e|ation|ing))\b/i.test(prompt);
  add('ai-ml', tuning || rl || edge || /\b(?:machine learning|deep learning|neural networks?|AI\/ML|ML (?:models?|algorithms?|training)|model (?:training|evaluation)|embedding models?|local (?:LM|LLM))\b/i.test(prompt) || ['torch', 'tensorflow', 'scikit-learn', 'sklearn', 'transformers', 'jax', 'onnxruntime'].some(name => dependencies.has(name)));
  add('research', research); add('reinforcement-learning', rl); add('edge-ml', edge);
  add('finetuning', tuning);
  add('colab', /\b(?:google )?colab\b/i.test(prompt));
  const ui = frontend || files.some(file => uiFileCue(file)) || /\b(?:UI|UX|user interface|dashboard|app screen|desloppification|deslop|visual design|responsive design|mobile layout|design[- ]systems?|typography|palette|spacing)\b|\b(?:anti[- ]?(?:ai[- ]?)?slop|design slop)\b[^.\n]{0,60}\b(?:design|interface|layout)\b/i.test(prompt)
    || !backendOnly && requested(/\b(?:interface|layout|hero)\b/i) && !/\b(?:command[- ]line interface|network interfaces?|api interface|class interface|type interface|(?:typescript|java|go) interfaces?|interface (?:types|contracts|definitions)|memory layout|disk layout)\b/i.test(prompt);
  add('ui-quality', ui);
  const broadDesign = ui && requested(/\b(?:build|create|design|redesign|restyle|revamp|rework|moderni[sz]e|polish)\b|\b(?:shared (?:ui|components?|owners?|tokens?)|design systems?|multi[- ](?:page|route|component))\b/i);
  const uiMotion = ui && !excluded(/\b(?:motion|animations?|animated|gsap|framer.motion)\b/i) &&
    (signals.has('motion') || ['gsap', 'motion', 'framer-motion', 'animejs'].some(name => dependencies.has(name)) || requested(/\b(?:motion|animat\w*|gsap|framer.motion|kinetic|parallax)\b/i));
  const uiScroll = ui && !excluded(/\b(?:motion|animations?|scroll[- ]?(?:animations?|driven|story|telling)|parallax)\b/i) &&
    (signals.has('scroll') || ['lenis', '@studio-freight/lenis', 'scrolltrigger'].some(name => dependencies.has(name)) || requested(/\b(?:scroll[- ]?(?:animations?|driven|story|telling)|scroll choreography|parallax|ScrollTrigger)\b/i));
  const responsive = ui && !excluded(/\b(?:responsive|multi[- ]device|device matrix|breakpoints?)\b/i) &&
    (broadDesign || signals.has('responsive') || requested(/\b(?:responsive|multi[- ]device|breakpoints?|phone|mobile|tablet|portrait|landscape)\b/i));
  const consistency = ui && !excluded(/\b(?:consistency|design systems?|shared tokens?)\b/i) &&
    (broadDesign || signals.has('consistency') || requested(/\b(?:consisten\w*|design systems?|shared (?:ui|components?|tokens?|owners?)|token drift)\b/i));
  const web3d = ui && !excluded(/\b(?:3d|webgl|three\.?js|gltf|glb)\b/i) &&
    (signals.has('web3d') || ['three', '@react-three/fiber', '@react-three/drei', 'babylonjs', '@babylonjs/core'].some(name => dependencies.has(name)) || requested(/\b(?:webgl|three\.?js|3d (?:hero|web|experience|model|scene)|gltf|glb)\b/i));
  const codeControl = requested(/\b(?:refactor\w*|architectur\w*|multi[- ]file|codebase controls?|api (?:contract|migration)|shared (?:ui|components?|owners?)|common (?:ui|components?|owners?)|cross[- ](?:module|cutting)|impact (?:analysis|discovery))\b/i)
    || !tuning && !rl && !edge && !research && files.filter(file => /\.(?:[cm]?[jt]sx?|php|py|go|rs|java|c|cpp|css|html|vue|svelte)$/i.test(file)).length >= 3;
  add('ui-motion', uiMotion); add('ui-scroll', uiScroll); add('ui-responsive', responsive); add('ui-consistency', consistency); add('web-3d', web3d); add('codebase-control', codeControl);
  const imageInspection = requested(/\b(?:image (?:editing|understanding|conver(?:t|sion))|(?:edit|convert|inspect|understand|analy[sz]e) (?:the |this |an? )?(?:images?|pictures?|photos?)|image_understand|image_convert)\b/i);
  const imageGeneration = requested(/\b(?:image generation|generate (?:the |this |an? )?(?:images?|pictures?|photos?)|image_generate)\b/i) && !pipelineToolExcluded(constraints, 'image_generate');
  add('image-media', imageInspection || imageGeneration || has(/\.(?:png|jpe?g|webp|tiff?|qoi)$/i) || signals.has('image-assets'));
  const video = /\b(?:video|footage|storyboard|montage)\b/i.test(prompt) || !ui && /\bmotion graphics\b/i.test(prompt) || has(/\.(?:mp4|mov|webm|mkv|avi)$/i);
  const audio = !/\b(?:no|without)\s+(?:audio|sound|music|soundtrack)\b/i.test(prompt) &&
    (/\b(?:audio|soundtrack|music|narration|voiceover|podcast|sound effects?|ducking|midi)\b/i.test(prompt) || has(/\.(?:wav|mp3|flac|ogg|aac|m4a|mid|midi)$/i));
  const art = /\b(?:svgs?|vector (?:art|icons?|illustrations?)|icon (?:set|pack)|logo (?:mark|design))\b|\.svg\b/i.test(prompt) || has(/\.svg$/i);
  const debugging = /\b(?:debug|debugging|troubleshoot|reproduce|reproducer|regression|crash|stack\s?trace)\b|\b(?:fix|investigate|diagnose)\b[^.\n]{0,80}\b(?:bug|failure|failing|error|hang|leak|race)\b/i.test(prompt);
  add('video', video); add('audio', audio); add('svg-art', art); add('debugging', debugging);
  add('blender-3d', !excluded(/\b(?:blender|3d|gltf|glb)\b/i) &&
    (/\bblender\b|\bgaussian splat(?:ting)?\b|\bphotogrammetry\b/i.test(skillTaskText(prompt)) || has(/\.(?:blend|fbx|usd[azc]?|splat)$/i) ||
      !web3d && (/\b3d (?:model(?:l?ing)?|scene|asset|render(?:ing)?|animation)\b|\b(?:glb|gltf)\b/i.test(prompt) || has(/\.(?:glb|gltf)$/i))));
  add('seo', seoTaskIntent(prompt, files).relevant);
  add('llm-app', /\b(?:llm|rag|retrieval[- ]augmented|prompt engineering|agent(?:ic)? (?:workflow|loop|system|framework)s?|tool[- ]calling|function[- ]calling|prompt injection|evals? (?:harness|suite)|ai (?:agent|assistant|chatbot)s?|chat ?bots?)\b/i.test(prompt));
  add('api-automation', /\b(?:api (?:integration|workflow|orchestration|automation)s?|workflow automation|webhooks?|(?:third[- ]party|external|multiple|several|various) apis?|idempoten\w+|rate[- ]limit\w*|scheduled (?:jobs?|tasks?)|cron jobs?|etl (?:pipeline|job)s?)\b/i.test(prompt));
  add('git-ssh-deploy', /\b(?:namecheap|godaddy|cpanel)\b|\b(?:deploy|deployment|production|website|site)\b[^\n]{0,100}\b(?:ssh|git)\b|\b(?:ssh|git)\b[^\n]{0,100}\b(?:deploy|deployment|production|website|site)\b/i.test(prompt));
  const produces = /\b(?:create|make|write|build|generate|draft|prepare|produce|fill(?: in| out)?|update|edit|fix|convert|export|format|redline|compile|assemble|design|turn|populate|add)\b/i.test(prompt);
  add('office-docs', produces && (/\b(?:docx|xlsx|xlsm|pptx|odt|ods|odp|word (?:document|doc|file)s?|excel|spreadsheets?|workbooks?|powerpoint|slide deck|pitch deck|libreoffice (?:writer|calc|impress)|google sheets)\b/i.test(prompt) || has(/\.(?:docx|xlsx|xlsm|pptx|odt|ods|odp)$/i)));
  const codeContext = /\b(?:code ?base|repo(?:sitory)?|source (?:code|tree)|function|class|variables?|modules?|packages?|git|src\/)\b/i.test(prompt);
  add('data-wrangling', DATA_TASK.test(prompt) && !codeContext && !QUESTION.test(prompt));
  add('file-organization', !codeContext && (/\b(?:organi[sz]e|declutter|tidy(?: up)?|de-?duplicate|dedupe|(?:bulk|batch)[ -]rename|rename)\b[^\n.]{0,70}\b(?:files?|folders?|director(?:y|ies)|downloads?|desktop|photos?|pictures|screenshots|scans|pdfs|invoices|receipts)\b|\b(?:sort|group|arrange|file away|clean ?up)\b[^\n.]{0,40}\b(?:downloads?|photos|pictures|screenshots|scans|invoices|receipts|desktop)\b|\b(?:messy|cluttered|disorgani[sz]ed|unsorted)\b[^\n.]{0,30}\b(?:folder|directory|downloads|desktop|files)\b|\b(?:downloads?|desktop|folder)\b[^\n.]{0,40}\b(?:a mess|messy|cluttered)\b/i.test(prompt)));

  if (research && !files.length && !/\b(?:implement|build|fix|refactor|debug|train|fine[- ]tune|benchmark)\b/i.test(prompt)) {
    // Subject nouns in a literature report do not request model training,
    // source tests or UI/media production. A requested Office report remains.
    const reportIds = ids.filter(id => id === 'research' || id === 'office-docs');
    ids.splice(0, ids.length, ...reportIds);
  }
  if (!ids.length) return { ids, fingerprint: 'none', skills: [], tools: [], stages: [] };
  const recipes = ids.map(id => RECIPES[id]);
  const skills = unique(recipes.flatMap(recipe => recipe.skills));
  const codeWork = ids.some(id => !MEDIA_ONLY.includes(id));
  const validationTools = codeWork ? ['project_tests', 'code_quality'] : unique(recipes.flatMap(recipe => recipe.tools ?? []));
  const baseTools = ['project_intel', 'read', ...validationTools];
  const stages: PipelineStage[] = [
    { id: 'discovery', phase: 'discovery', check: recipes.map((recipe, i) => `${ids[i]}: ${recipe.discovery}`).join('\n'), evidenceKinds: ['inspection'], dependsOn: [], tools: ['project_intel', 'read'] },
    ...(debugging ? [{ id: 'debug-reproduction', phase: 'discovery' as const, check: 'Run the minimal reproducer and retain the observed failure before repair. Expected failure is successful reproduction evidence; missing reproduction remains blocked, not a claimed diagnosis.', evidenceKinds: ['execution' as const], dependsOn: ['discovery'], tools: ['project_tests', 'bash'] }] : []),
    ...(codeControl ? [{ id: 'source-impact', phase: 'discovery' as const, check: RECIPES['codebase-control'].discovery, evidenceKinds: ['inspection' as const], dependsOn: ['discovery'], tools: ['project_report', 'module_report', 'symbol_search', 'context_slice'] }] : []),
    { id: 'implementation', phase: 'implementation', check: 'Implement in the established owner and preserve unrelated work. Use relevant tools for each stage; consult skill guides only when they help the next decision and adapt their steps to the task. Keep a reviewable artifact/diff.', evidenceKinds: ['artifact'], dependsOn: [...(debugging ? ['debug-reproduction'] : ['discovery']), ...(codeControl ? ['source-impact'] : [])], tools: ['read', 'edit', 'write', ...(uiMotion || uiScroll || web3d ? ['ui_recipe'] : []), ...(consistency || uiMotion || web3d ? ['creative_direct'] : []), ...(codeControl ? ['bulk_edit'] : [])] },
    { id: 'validation', phase: 'validation', check: recipes.map((recipe, i) => `${ids[i]}: ${recipe.validation}`).join('\n') + '\nReuse current native execution receipts. For a low-impact change, an explicit reasoned assessment may establish that additional tests are unnecessary; an assessment cannot claim a test passed.', evidenceKinds: research && !codeWork ? ['inspection', 'assessment'] : ['execution', 'assessment'], dependsOn: ['implementation'], tools: validationTools },
  ];
  const sourceAudit = codeWork && /\b(?:refactor\w*|code (?:quality|review)|source (?:audit|review)|architectur\w*|redundan\w*|DRY|linters?|security audit)\b/i.test(prompt);
  if (ids.includes('seo')) {
    stages.push({ id: 'seo-raw', phase: 'validation', check: 'Inspect built raw HTML or audit representative served public pages with seo_toolkit. Resolve observed crawl/index/canonical/sitemap/link/schema errors; limited or unavailable coverage remains explicit. Evidence must describe the current revision.', evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['seo_toolkit', 'web_probe'] });
    stages.push({ id: 'seo-content', phase: 'validation', check: 'Review page purpose, distinct useful answers/original value, intent overlap/topic links, genuine entities and visible schema facts, real dates, and public/private discovery parity. Record a concrete assessment; do not create irrelevant blogs, fake credentials or thin mass pages.', evidenceKinds: ['assessment', 'inspection'], dependsOn: ['implementation'], tools: ['seo_toolkit', 'web_search', 'fetch_content'] });
  }
  if (sourceAudit) stages.push({ id: 'source-quality', phase: 'validation', check: 'Run code_quality baseline on the affected revision, with changed:true when Git is available. Inspect DRY groups, security/backend/UI cues and structure; reuse the established owner and retain justified repetition. Missing/truncated coverage stays unresolved. Use syntax_check and actual project linters/types/tests as applicable.', evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['code_quality', 'syntax_check', 'code_audit'] });
  if (research) stages.push({ id: 'research-evidence', phase: 'validation', check: 'Build a source/claim dossier, verify exact quotes/hashes and reconcile conflicting evidence. Inspect context, authority, dates/periods/units and independence; lexical passages do not establish semantic support. Report unresolved gaps.', evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['research_toolkit', 'claim_check'] });
  if (ui) {
    stages.push({ id: 'ui-responsive', phase: 'validation', check: 'Render 320px/mobile/tablet/desktop with ui_explore. Inspect matrix pixels and measured overflow, controls, image loading and solid-text contrast. Check breakpoint edges, short height, long content and relevant dark/reduced-motion states. Truncated/capped or failed captures do not pass. Native apps use the actual window/device size path.', evidenceKinds: ['pixels', 'inspection'], dependsOn: ['implementation'], tools: ['ui_explore', 'design_audit', 'image_understand'] });
    stages.push({ id: 'ui-pixels', phase: 'validation', check: 'Inspect current actual application pixels. Judge hierarchy, type, spacing, color, composition, SVG optical weight and identity against real content and the requested direction. Use visual_review run then record its runId and every rubric section. Text-only models use permitted image_understand for the capture. UNKNOWN, stale captures and source inference cannot approve appearance.', evidenceKinds: ['pixels'], dependsOn: ['implementation'], tools: ['visual_review', 'render_see', 'image_understand', 'quality_review'] });
    stages.push({ id: 'ui-interaction', phase: 'validation', check: 'Exercise the representative user task, keyboard/focus and relevant loading/empty/error/disabled states in the actual application. Record real interaction evidence.', evidenceKinds: ['interaction'], dependsOn: ['implementation'], tools: ['browser_session', 'quality_review'] });
  }
  if (consistency) stages.push({ id: 'ui-consistency', phase: 'validation', check: RECIPES['ui-consistency'].validation, evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['ui_consistency', 'creative_direct'] });
  if (uiMotion) stages.push({ id: 'ui-motion', phase: 'validation', check: RECIPES['ui-motion'].validation, evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['motion_inspect', 'browser_session'] });
  if (uiScroll) stages.push({ id: 'ui-scroll', phase: 'validation', check: RECIPES['ui-scroll'].validation, evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['motion_inspect', 'browser_session'] });
  if (web3d) stages.push({ id: 'web-3d', phase: 'validation', check: RECIPES['web-3d'].validation, evidenceKinds: ['inspection'], dependsOn: ['implementation'], tools: ['asset_register', 'render_see', 'browser_session'] });
  if (video) {
    stages.push({ id: 'video-art', phase: 'validation', check: 'Inspect full-size delivered hero/detail pixels against the creative brief and reference pixels: specific silhouettes, semantic accuracy, coherent materials/light/shadow, deliberate hierarchy and typography. Finish blockouts and draft assets. Preserve the requested style, including intentional abstract, flat or richly illustrated work; no automatic taste score replaces this review.', evidenceKinds: ['pixels'], dependsOn: ['validation'], tools: ['video_render','video_qa','image_understand'] });
    stages.push({ id: 'video-playback', phase: 'validation', check: 'Inspect actual playback of the final video for pacing, framing, motion, transitions and audio sync. A sparse contact sheet, successful decode or timeline JSON cannot establish continuous playback quality.', evidenceKinds: ['playback'], dependsOn: ['validation'], tools: ['video_frames', 'video_qa'] });
  }
  if (audio) stages.push({ id: 'audio-listening', phase: 'validation', check: 'Listen to the delivered encoding at representative quiet/loud sections and edits. Resolve audible artifacts, intelligibility and ending defects; LUFS, true peak and a synthesized preview cannot establish audible quality.', evidenceKinds: ['listening'], dependsOn: ['validation'], tools: ['audio_analyze'] });
  if (ids.includes('blender-3d')) stages.push({ id: 'render-pixels', phase: 'validation', check: 'Inspect rendered frames from at least three angles and one close-up against the requested look; resolve noise, fireflies, light and material errors. A viewport capture, a script exit code or one orbit cannot settle appearance.', evidenceKinds: ['pixels'], dependsOn: ['validation'], tools: ['blender_render'] });
  if (ids.includes('llm-app')) stages.push({ id: 'llm-evaluation', phase: 'validation', check: 'Score the final configuration and the simplest baseline on the same frozen cases with recorded model, prompt and parameter versions; report slice failures, cost and latency. A handful of hand-picked examples is not an evaluation.', evidenceKinds: ['evaluation'], dependsOn: ['implementation'], tools: ['project_tests'] });
  if (art) stages.push({ id: 'art-pixels', phase: 'validation', check: 'Inspect the rendered art at intended sizes and backgrounds against the requested direction. Resolve clipping, small-size legibility and inconsistent weight; retain the render matrix with the finding.', evidenceKinds: ['pixels'], dependsOn: ['validation'], tools: ['svg_inspect'] });
  const artifactOnly = /\b(?:prepare|draft|write|create|build|validate)\b[^\n]{0,100}\b(?:notebook|training script|training pipeline|recipe)\b/i.test(prompt)
    && !/\b(?:start|execute|run)\b[^\n]{0,80}\b(?:training|finetuning|fine[- ]tuning|notebook)\b/i.test(prompt);
  const executeTraining = /\b(?:train|finetune|fine[- ]tune)\s+(?:(?:the|a|an|this|my|our)\s+)?(?:(?:embedding|small|super small|local|neural|decision|edge|robotics|reinforcement learning)\s+){0,3}(?:models?|LM|LLM|networks?|adapters?|weights?|policy)\b|\b(?:start|execute|run)\b[^\n]{0,80}\b(?:training|finetuning|fine[- ]tuning|reinforcement learning)\b/i.test(prompt);
  if ((tuning || ids.includes('ai-ml')) && !artifactOnly && executeTraining) {
    stages.push({ id: 'training-smoke', phase: 'validation', check: 'Observe a collated batch and finite update/save/reload/resume smoke test on the actual runtime before scaling. Use ml_lab split_audit and rl_targets where relevant. Record versions, data hashes, masking, runtime and observed memory.', evidenceKinds: ['execution'], dependsOn: ['implementation'], tools: ['ml_lab', 'project_tests', 'bg_run'] });
    stages.push({ id: 'model-evaluation', phase: 'validation', check: 'Compare baseline, trained and exported models on the same frozen slices/seeds/settings using ml_lab evaluate. Record quality/retention/cost/latency and durable checkpoints; missing training/inference stays unresolved. Offline Bellman residual or exploratory reward is not policy-success evidence.', evidenceKinds: ['evaluation'], dependsOn: ['training-smoke'], tools: ['ml_lab', 'project_tests'] });
  }
  const deploying = ids.includes('git-ssh-deploy') && /\b(?:deploy|publish|promote|sync|upload)\b/i.test(prompt)
    && !/\b(?:prepare|plan|draft|design)\b[^\n]{0,80}\b(?:deployment|deploy|pipeline|workflow)\b/i.test(prompt);
  if (deploying) {
    stages.push({ id: 'deploy-preflight', phase: 'delivery', check: 'Confirm the concrete authorized source/destination, trusted host, artifact manifest, protected data and tested rollback. Use ssh_plan only as an argv plan; it proves no authentication or connectivity.', evidenceKinds: ['inspection'], dependsOn: stages.filter(stage => stage.phase === 'validation').map(stage => stage.id), tools: ['git_info', 'ssh_plan', 'env_audit'] });
    stages.push({ id: 'deploy-remote', phase: 'delivery', check: 'Execute the authorized promotion using actual host/account capabilities and record the remote revision/artifact. Do not overwrite databases/uploads or claim promotion from a plan.', evidenceKinds: ['remote'], dependsOn: ['deploy-preflight'], tools: ['bash'] });
    stages.push({ id: 'deploy-live', phase: 'delivery', check: 'Verify the deployed revision through the public serving path and representative live behavior. DNS/TLS/SSH banner probes and Git push alone do not prove the application works.', evidenceKinds: ['live'], dependsOn: ['deploy-remote'], tools: ['net_probe', 'browser_session'] });
    if (ids.includes('seo')) stages.push({ id: 'seo-live', phase: 'delivery', check: 'Re-audit the actual production canonical origin after the deployment with seo_toolkit audit. Confirm raw status/robots/canonical/sitemap/schema/link/discovery/cache parity on the deployed revision; local build checks and a pre-deployment audit cannot establish this live state.', evidenceKinds: ['live'], dependsOn: ['deploy-remote'], tools: ['seo_toolkit', 'web_probe'] });
  }
  stages.push({ id: 'delivery', phase: 'delivery', check: 'Report the concrete artifact/revision, reused validation evidence and unresolved gaps. Follow the actual project Git/release/install process when requested; prepared notebooks and deployment plans stay labeled as prepared.', evidenceKinds: ['artifact'], dependsOn: stages.filter(stage => stage.id !== 'discovery' && stage.id !== 'implementation').map(stage => stage.id), tools: ['git_info'] });
  const tools = unique([...baseTools, ...recipes.flatMap(recipe => recipe.tools ?? []), ...stages.flatMap(stage => stage.tools)]);
  const fingerprint = createHash('sha256').update(JSON.stringify({ ids, stages: stages.map(stage => stage.id) })).digest('hex').slice(0, 16);
  return { ids, fingerprint, skills, tools, stages };
}

export type PipelineCoordinate = { scope: string; revision: string; maxChars?: number };
export type PipelineReceipt = {
  scope: string;
  /** Observed source/content identity; a task-local counter alone is insufficient across reloads. */
  revision: string;
  stageId: string;
  status: 'passed' | 'failed' | 'blocked';
  evidenceKind: PipelineEvidenceKind;
  /** Reference to existing native evidence, not a shell command to execute. */
  source: string;
  summary?: string;
};
export type PipelineLedger = { receipts: Array<PipelineReceipt & { failures: number }> };
export type PendingPipelineStage = PipelineStage & { ready: boolean; status: 'pending' | 'failed' | 'blocked'; failures: number };
const MAX_RECEIPTS = 256;
const EVIDENCE_KINDS = new Set<PipelineEvidenceKind>(PIPELINE_EVIDENCE_KINDS);

export function createPipelineLedger(): PipelineLedger { return { receipts: [] }; }
function coordinateValid(value: PipelineCoordinate): boolean {
  return typeof value?.scope === 'string' && value.scope.trim().length > 0 && value.scope.length <= 240 &&
    typeof value?.revision === 'string' && value.revision.trim().length > 0 && value.revision.length <= 160;
}
function latestReceipt(ledger: PipelineLedger, coordinate: PipelineCoordinate, stageId: string): (PipelineReceipt & { failures: number }) | undefined {
  return ledger.receipts.findLast(receipt => receipt.scope === coordinate.scope.trim() && receipt.revision === coordinate.revision.trim() && receipt.stageId === stageId);
}

/** Stage indexing only. Existing project_tests/quality_review/native tools own execution evidence. */
export function recordPipelineEvidence(ledger: PipelineLedger, receipt: PipelineReceipt, selection: PipelineSelection): { recorded: boolean } {
  if (!coordinateValid(receipt) || typeof receipt.source !== 'string' || !receipt.source.trim() || receipt.source.length > 2048 ||
      !['passed', 'failed', 'blocked'].includes(receipt.status) || !EVIDENCE_KINDS.has(receipt.evidenceKind))
    throw Error('A bounded scope, content revision, status, evidence kind and native evidence source are required');
  const stage = selection.stages.find(candidate => candidate.id === receipt.stageId);
  if (!stage) throw Error(`Unknown pipeline stage: ${bounded(receipt.stageId, 80)}`);
  if (receipt.status === 'passed' && !stage.evidenceKinds.includes(receipt.evidenceKind)) throw Error(`${stage.id} requires ${stage.evidenceKinds.join(' or ')} evidence`);
  if (receipt.status === 'passed' && stage.dependsOn.some(id => latestReceipt(ledger, receipt, id)?.status !== 'passed'))
    throw Error(`${stage.id} has unresolved prerequisite stages`);
  const clean = { ...receipt, scope: receipt.scope.trim(), revision: receipt.revision.trim(), source: receipt.source.trim(), ...(receipt.summary ? { summary: bounded(receipt.summary, 1200) } : {}) };
  const previous = latestReceipt(ledger, clean, clean.stageId);
  if (previous && previous.status === clean.status && previous.evidenceKind === clean.evidenceKind && previous.source === clean.source && previous.summary === clean.summary)
    return { recorded: false };
  // A new result for an upstream stage invalidates its descendants even if a
  // caller reused a revision. Keep unrelated validators and other scopes.
  const invalidated = new Set([stage.id]);
  for (const candidate of selection.stages) if (candidate.dependsOn.some(id => invalidated.has(id))) invalidated.add(candidate.id);
  ledger.receipts = ledger.receipts.filter(item => item.scope !== clean.scope || item.revision !== clean.revision || !invalidated.has(item.stageId));
  ledger.receipts.push({ ...clean, failures: (previous?.failures ?? 0) + (clean.status === 'failed' ? 1 : 0) });
  if (ledger.receipts.length > MAX_RECEIPTS) ledger.receipts.splice(0, ledger.receipts.length - MAX_RECEIPTS);
  return { recorded: true };
}

/** Never reuse receipts from another task/todo or from stale content. */
export function pendingPipelineStages(selection: PipelineSelection, ledger: PipelineLedger, coordinate: PipelineCoordinate): PendingPipelineStage[] {
  if (!coordinateValid(coordinate)) throw Error('A scope and observed content revision are required');
  return selection.stages.flatMap(stage => {
    const receipt = latestReceipt(ledger, coordinate, stage.id);
    if (receipt?.status === 'passed') return [];
    const failures = receipt?.failures ?? 0;
    return [{ ...stage, ready: stage.dependsOn.every(id => latestReceipt(ledger, coordinate, id)?.status === 'passed'), status: receipt?.status ?? 'pending', failures }];
  });
}
export function nextPipelineStages(selection: PipelineSelection, ledger: PipelineLedger, coordinate: PipelineCoordinate): PendingPipelineStage[] {
  return pendingPipelineStages(selection, ledger, coordinate).filter(stage => stage.ready);
}

/** Bounded next-step context; completed recipes and skill bodies are never repeated. */
export function buildPipelineContext(selection: PipelineSelection, ledger: PipelineLedger, coordinate: PipelineCoordinate): string | undefined {
  if (!selection.ids.length) return undefined;
  const pending = pendingPipelineStages(selection, ledger, coordinate);
  if (!pending.length) return undefined;
  const maxChars = Number.isFinite(coordinate.maxChars) ? Math.max(0, Math.min(12000, Math.floor(coordinate.maxChars!))) : 2400;
  if (maxChars < 160) return undefined;
  const ready = pending.filter(stage => stage.ready);
  const header = `[Task pipelines: ${selection.ids.join(', ')}]\nScope ${coordinate.scope}; revision ${coordinate.revision}. Reuse current native receipts; do not repeat passed stages.\n`;
  const skills = ready.some(stage => stage.phase === 'discovery') ? `Optional reference guides: ${selection.skills.join(', ')}. Consult only when useful; these are not tool prerequisites.\n` : '';
  // Share the bound across ready stages and recipe paragraphs, so a long
  // language recipe cannot hide the current responsive/motion/impact step.
  const stageBudget = Math.max(80, Math.floor((maxChars - header.length - skills.length) / Math.max(1, ready.length)));
  const body = ready.map(stage => {
    const label = `${stage.id}${stage.failures ? ` (${stage.failures} failure receipts: diagnose/escalate before retrying)` : ''}: `;
    const lines = stage.check.split('\n');
    const lineBudget = Math.max(40, Math.floor((stageBudget - label.length) / lines.length));
    return label + lines.map(line => line.length > lineBudget ? line.slice(0, Math.max(0, lineBudget - 1)) + '…' : line).join('\n');
  }).join('\n');
  const blocked = ready.length ? '' : 'Prerequisite evidence is unresolved; inspect pipeline status before proceeding.';
  return (header + skills + body + blocked).slice(0, maxChars);
}
