/** Bounded capability hints and pre-edit skill review owned by reminders.ts.
 * No inference or autonomous tool execution. Only catalog heading metadata is
 * read; tool-output prose does not become routing instructions. */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { sourceCheckSupported } from "./source-check.ts";
import { qualityReviewSignals } from "./quality-review-signals.ts";
import { slopGuidanceSignals } from "./slop-guidance-signals.ts";
import { codeGuidanceSignals } from "./code-guidance-signals.ts";
import { checkpointPath } from "./checkpoint-files.ts";
import { matchGuidanceTopics } from "./guidance-topics.ts";
import { routeSkills, skillTaskText, skillIntentSegments } from "./skill-routing.ts";
import { buildSkillIndex, rankSkills, skillTerms, headingOutline, bestSkillSection } from "./skill-relevance.ts";

const ENTRY = "relevant-guidance";
const LIMIT = 96; // bounded recent delivery receipts, not a lifetime usage quota
const MAX_PENDING = 32;
const MAX_RUN_HINTS = 20;
const MAX_RESTORE_ENTRIES = 2000; // restore is metadata recovery, not a history scan
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k]!));
const action = /\b(add|publish|export|convert|render|build|make|design|create|implement|fix|change|edit|refactor|debug|investigate|inspect|review|audit|improve|deploy|migrate|redesign|update|updating|repair|refine|polish|animate|optimize)\b/i;
const ui = /\b(ui|interface|frontend|front-end|layout|styles?|responsive|website|component|page|aesthetics|animations?)\b/i;
const env = /\b(production|deploy(?:ment)?|ci\/cd|server|migration|database|postgres|mysql|sqlite)\b/i;
const uiFile = /\.(?:tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const envFile = /(?:^|\/)(?:migrations?|\.github\/workflows|terraform)(?:\/|$)|(?:^|\/)(?:Dockerfile|compose\.ya?ml)|\.(?:sql|tf)$/i;
type Skill = { name: string; file: string; description: string };
type Hint = { key: string; text: string; tool?: string; skill?: string; priority?: number; sourceFile?: string; expiresAt?: number };

export function createRelevantGuidance(pi: any) {
  let cwd = "", shown = new Set<string>(), read = new Set<string>();
  let skills: Skill[] = [], pending = new Map<string, Hint>(), used = new Set<string>(), unavailable = new Set<string>();
  let context: string[] = [], extensions = new Set<string>(), skillIndex: ReturnType<typeof buildSkillIndex> | null = null;
  let skillOffers = new Map<string, { n: number; at: number }>();
  const outlines = new Map<string, { mtimeMs: number; headings: Array<{ text: string; line: number }> }>();
  let lastFailure = "", failures = 0, urgentCount = 0;
  let searches = 0, polling = "", polls = 0, runCount = 0, codeSeen = false;
  let requestNumber = 0, topicSeen = new Map<string, number>(), topicCount = 0, toolStep = 0;
  let matchingPrompt = false, requestDisabled = false;
  let skillReviewDisabled = false;
  const reviewTargets = new Map<string, { skill: Skill; reason: string }>();
  const deferredSkills = new Map<string, string>();
  const reviewEnabled = () => enabled() && !skillReviewDisabled && process.env.PI_SKILL_REVIEW !== 'off'
    && tools().has('read') && tools().has('skill_review');
  // Small requests keep three ordinary hints; sustained work earns another
  // opportunity every four completed tool steps. Repeated candidates() calls
  // cannot refill this allowance. One urgent recovery cue has a separate slot.
  const runAllowance = () => Math.min(MAX_RUN_HINTS, 3 + Math.floor(toolStep / 4));
  const isTopic = (key: string) => key.startsWith("topic:");
  const wasShown = (key: string) => isTopic(key)
    ? topicSeen.has(key) && requestNumber - topicSeen.get(key)! < 3 : shown.has(key);
  const tools = () => {
    try { return new Set<string>(pi.getActiveTools?.() ?? []); }
    catch { return new Set<string>(); }
  };
  const enabled = () => !requestDisabled && process.env.PI_RELEVANT_GUIDANCE !== "off";
  const renderEnvironmentFailure = (event: any) => event.toolName === "render_see" && event.isError === true &&
    /browser startup failure|browserType\.launch|EROFS|EACCES|EPERM|read.only file system|No usable sandbox|Chromium sandboxing failed|SUID sandbox helper|Executable doesn.t exist|Unsupported chromium channel|Cannot find (?:module|package).*playwright/i.test(
      (event.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? '').slice(0,8192)).slice(0,3).join('\n').split(/; diagnostics:|\nBrowser logs:/)[0]);
  const observeAvailability = (event: any) => {
    if (event.toolName !== "render_see") return false;
    const before = unavailable.has("render_see");
    if (!event.isError) unavailable.delete("render_see");
    else if (renderEnvironmentFailure(event)) unavailable.add("render_see");
    return before !== unavailable.has("render_see");
  };
  const add = (hint: Hint) => {
    // Task-level suggestions remain relevant until the next prompt. File/edit
    // cues still expire quickly so stale local observations cannot linger.
    if (!matchingPrompt && !hint.key.startsWith("signal:") && hint.expiresAt === undefined) hint = {...hint, expiresAt:toolStep+4};
    if (!enabled() || wasShown(hint.key)) return;
    if (hint.tool && (!tools().has(hint.tool) || used.has(hint.tool) || unavailable.has(hint.tool))) return;
    if (hint.skill && (skillReviewDisabled || read.has(hint.skill))) return;
    for (const [key, value] of pending) if (value.expiresAt !== undefined && toolStep > value.expiresAt) pending.delete(key);
    const previous = pending.get(hint.key);
    if (previous && (previous.priority ?? 0) >= (hint.priority ?? 0)) {
      if (hint.sourceFile && (isTopic(hint.key) || previous.sourceFile) && (previous.priority ?? 0) === (hint.priority ?? 0)) pending.set(hint.key, hint);
      return;
    }
    if (!previous && pending.size >= MAX_PENDING) {
      const weakest = [...pending.values()].sort((a,b)=>(a.priority ?? 0)-(b.priority ?? 0))[0];
      if ((weakest.priority ?? 0) >= (hint.priority ?? 0)) return;
      pending.delete(weakest.key);
    }
    pending.set(hint.key, hint);
  };
  const skillHint = (topic: string, preferred: string[], terms: RegExp, nameOnly = false, priority = 0) => {
    // Exact known skills first; otherwise use a matching *loaded* description.
    // No fabricated paths and no catalogue/skill-body injection.
    const skill = preferred.map(n => skills.find(s => s.name === n)).find(Boolean)
      ?? skills.find(s => terms.test(s.name))
      ?? (!nameOnly ? skills.find(s => terms.test(s.description)) : undefined);
    if (skill) add({ key: `skill:${skill.file}`, skill: skill.file, priority,
      text: `${topic}: if useful and not already covered, read skill ${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)}.${sectionPointer(skill.file, [...skillTerms(topic, 8), ...context.slice(-16)])} User instructions and project conventions take precedence.` });
  };
  const practice = (key: string, topic: string, preferred: string[], text: string) => {
    const skill = preferred.map(n => skills.find(s => s.name === n)).find(Boolean);
    if (skill) {
      // A short operational check still helps models that overlook skill discovery.
      if (!read.has(skill.file)) add({ key: `skill:${skill.file}`, skill: skill.file,
        text: `${topic}: ${text} Read ${JSON.stringify(skill.file)} for the relevant workflow.${sectionPointer(skill.file, [...skillTerms(topic, 8), ...context.slice(-16)])} User intent and project conventions win.` });
    } else add({ key: `practice:${key}`, text: `${topic}: ${text}` });
  };
  const routedSkills = (prompt = "", file = "") => {
    for (const route of routeSkills(prompt, file)) {
      const skill = skills.find(s => s.name === route.name);
      if (skill) add({key:`skill:${skill.file}`, skill:skill.file, priority:route.priority,
        text:`${route.check} Read ${JSON.stringify(skill.file)} for the applicable workflow and examples.${sectionPointer(skill.file, skillTerms(`${prompt} ${file}`, 24))} User intent and project conventions take precedence.`});
    }
  };
  const skillKey = (key: string) => key.startsWith("skillctx:") ? key.slice(9) : key.startsWith("skill:") ? key.slice(6) : "";
  const skillCovered = (file: string) => read.has(file) || [...pending.values()].some(h => h.skill === file) || shown.has(`skill:${file}`) || shown.has(`skillctx:${file}`);
  // Derived context terms only: bounded, newest-kept, never raw prompt text persisted.
  const remember = (text: string) => {
    const current = skillTerms(text);
    context = [...context.filter(term => !current.includes(term)), ...current].slice(-48);
  };
  // Section targeting: read only a skill's headings (bounded, cached by mtime)
  // so a recommendation points at the useful part instead of the whole file.
  const sectionPointer = (file: string, terms: string[]): string => {
    if (!file || !terms.length) return "";
    try {
      const stat = fs.statSync(file);
      let entry = outlines.get(file);
      if (!entry || entry.mtimeMs !== stat.mtimeMs) {
        if (stat.size > 96 * 1024) return "";
        entry = { mtimeMs: stat.mtimeMs, headings: headingOutline(fs.readFileSync(file, "utf8")) };
        if (outlines.size >= 24) outlines.delete(outlines.keys().next().value!);
        outlines.set(file, entry);
      }
      const section = bestSkillSection(entry.headings, terms);
      return section ? ` Start at ${JSON.stringify(section.text)} (line ${section.line}); skip unrelated sections.` : "";
    } catch { return ""; }
  };
  /** Catalog-wide relevance against the ongoing session profile. Weak or generic
   * overlap yields nothing; explicit routes and signals keep their priority. */
  const contextSkill = (priority = 55) => {
    if (!skillIndex || !context.length) return;
    let offered = 0;
    const coveredTerms = new Set<string>();
    for (const ranked of rankSkills(skillIndex, context.join(" "), 6)) {
      if (skillCovered(ranked.skill.file)) continue;
      const terms = ranked.matched.map(term => term.split('~').at(-1)!);
      if (terms.every(term => coveredTerms.has(term))) continue;
      add({ key: `skillctx:${ranked.skill.file}`, skill: ranked.skill.file, priority,
        text: `Session context (${ranked.matched.slice(0,4).join(', ')}): if useful and not already covered, read skill ${JSON.stringify(ranked.skill.name)} at ${JSON.stringify(ranked.skill.file)}.${sectionPointer(ranked.skill.file, ranked.matched)} Advisory; user instructions and project conventions take precedence.` });
      // Up to three distinct relevant workflows can enter the pending queue;
      // the ordinary two-hint delivery and run budgets still apply.
      for (const term of terms) coveredTerms.add(term);
      if (++offered >= 3) break;
    }
  };
  const signalHint = (key: string, skillName: string, check: string, sourceFile?: string) => {
    const skill = skills.find(s=>s.name === skillName);
    // A read receipt must not hide a new code/failure signal. No raw code is echoed.
    const workflow = skill ? read.has(skill.file)
      ? ` Apply the relevant checks from ${JSON.stringify(skill.name)} already read.`
      : ` Read ${JSON.stringify(skill.file)} for the relevant workflow.` : '';
    add({key:`signal:${key}`, priority:90, sourceFile, text:check + workflow + ' This is a review cue, not proof of a defect; preserve user scope.'});
  };
  const topicHints = (input: {prompt?: string; file?: string; text?: string}) => {
    const families = new Set<string>();
    for (const topic of matchGuidanceTopics(input)) {
      const family = topic.family ?? topic.id;
      if (families.has(family)) continue;
      if (families.size >= 4) break;
      families.add(family);
      add({
      key: `topic:${family}`, priority: 78, sourceFile: input.file,
      expiresAt: input.file ? toolStep + 4 : undefined,
      text: `${topic.check} Apply only within the current task and project conventions.`,
      });
    }
  };
  const utilityHint = (tool: string, text: string) => add({key:`utility:${tool}`,tool,priority:79,text});
  const utilityHints = (prompt: string) => {
    const parts=prompt.replace(/```[^]*?(?:```|$)/g,' ').replace(/^\s*>.*$/gm,' ').split(/\n|[.!?](?:\s|$)|;/);
    for (const part of parts) {
      if (!/\b(test|reproduce|try|check|inspect|calculate|compute|measure|analy[sz]e|evaluate|audit|verify|fix|lint|convert|encode|decode|format|compact|compare|review|rank|retrieve|cache|reuse|prepare|prioriti[sz]e|read|query|extract|count|replace|rename|run|start|launch|wait|track|plan|fill|submit|navigate|delegate|use|fuse|merge|consolidate)\b/i.test(part) || /\b(explain|what is|how does|do not|don't|never|without tools|no tools)\b/i.test(part)) continue;
      if (/\b(json|yaml|yml)\b/i.test(part) && /\b(read|query|extract|count|filter|convert|inspect|compare)\b/i.test(part))
        utilityHint('data_query','Structured data: data_query reads, filters, counts and converts bounded JSON/YAML values without a shell script. Use its supported operations; it does not validate an arbitrary schema or write files.');
      if (/\b(syntax|parse errors?|syntax errors?|configuration files?|config files?)\b/i.test(part))
        utilityHint('syntax_check','Syntax checks: syntax_check({paths:[...]}) batches installed language/configuration parsers with compact per-file results. Use explicit changed paths; unavailable or incomplete checks are not passes. Keep project type checks, tests and configuration schema validation.');
      if (/\b(git|uncommitted|staged|commit history|branch status)\b/i.test(part) && /\b(check|inspect|compare|review|read)\b/i.test(part))
        utilityHint('git_info','Git evidence: git_info({action:"scope"}) identifies project/worktree ownership; session history branches and checkpoints are not commits. git_info reads status, diffs, history and branches with bounded structured arguments. Inspect the relevant scope before staging task-owned changes; use the normal Git workflow for mutations.');
      if (/\b(browser|website|web page)\b/i.test(part) && /\b(navigate|fill|submit|inspect|use)\b/i.test(part))
        utilityHint('browser_session','Browser interaction: browser_session owns isolated HTTP(S) state for this agent. Inspect a fresh snapshot before choosing an exact target; use logs and state to reconcile timeouts before retrying. No shared personal browser profile. For local SVG/HTML/images/PDF use render_see.');
      if (/\b(research|search)\b/i.test(part) && /\b(background|multiple|several|thorough|comprehensive)\b/i.test(part))
        utilityHint('web_research','Research discovery: web_research runs 2–12 distinct supplied queries in background with shared provider pacing. Read the retained query receipts after completion; unavailable/empty results do not prove absence. Respect cooldowns and verify primary sources before concluding.');
      if (/\b(sandbox(?:es)?|isolated? (?:experiment|test|reproduction)s?|disposable|scratch environment|without (?:affecting|changing|touching) (?:the )?(?:project|workspace))\b/i.test(part))
        utilityHint('sandbox_run','Disposable experiments: sandbox_run runs a bounded script in a fresh environment with explicit copied files or fixtures, no project/home mounts or network, and automatic cleanup. Combine related steps in one call. If isolation cannot start, report it; never silently run the experiment on the host.');
      if (/\b(http|api endpoint|response headers?|status code)\b/i.test(part))
        utilityHint('http_request','HTTP inspection: http_request returns status, headers and a capped body for a bounded request. Reuse it for endpoint diagnostics; preserve authorization and do not repeat an uncertain mutation.');
      if (/\b(listening ports?|systemd|service status|processes|cpu usage|memory usage)\b/i.test(part))
        utilityHint('sys_probe','System facts: sys_probe inspects processes, listening ports and systemd state without assembling shell pipelines. Use the narrowest supported operation and the returned current facts.');
      if (/\b(replace|rename)\b/i.test(part) && /\b(across|multiple|several|all)\b[^.!?]{0,60}\bfiles\b/i.test(part))
        utilityHint('bulk_edit','Repeated edits: bulk_edit previews a bounded multi-file literal/regex replacement, then applies its preview token. Review the matched files and diff; use semantic rename tooling when identifiers need binding-aware changes.');
      if (/\b(fill|submit|navigate|inspect)\b/i.test(part) && /\b(web|website|browser|login|checkout)\b/i.test(part) && /\b(forms?|login|checkout)\b/i.test(part))
        utilityHint('web_probe','Web forms: web_probe gives read-only page reconnaissance, including visible form field names and browser handoff hints. Use an available interactive browser for filling/submitting and verify the postcondition. The probe has no cookies, login state or submission ability.');
      if (/\b(run|start|launch)\b/i.test(part) && /\b(full test suite|integration tests|build|benchmark|dev server|long.running|background (?:job|task)|queued jobs)\b/i.test(part))
        utilityHint('bg_run','Long-running work: bg_run owns process execution, output and completion notifications. Retain its task ID, continue independent work and inspect that task when needed; do not create a shell polling loop or duplicate queue.');
      if (/\b(wait|check|verify)\b/i.test(part) && /\b(readiness|ready|file appears|url available)\b/i.test(part))
        utilityHint('wait_for','Readiness: wait_for checks HTTP readiness, file existence or a literal in a file with a finite timeout. Prefer an observable ready condition to a guessed sleep; preserve an existing task ID and use its owner for process completion.');
      if (/\b(track|plan)\b/i.test(part) && /\b(tasks|milestones|multi.step|dependencies|work queue)\b/i.test(part))
        utilityHint('todo','Task tracking: use todo for the existing task list, dependencies and completion state. Update the current owner as evidence arrives instead of maintaining a second checklist or queue.');
      if (!/\b(no subagents|no delegation|without delegation|do not delegate|don't delegate)\b/i.test(prompt) && /\b(subagents?|workers|reviewers|swarm|fusion)\b/i.test(part)) {
        if (/\b(fuse|fusion|merge|consolidate)\b/i.test(part))
          add({key:'workflow:fusion',tool:'subagent',priority:79,text:'Fusion: inspect the active subagent contract and use its supported fusion helper when combining independent child findings. In a workflow-enabled session, runs.fuse returns a fused body and provenance without launching more children. Preserve failures and disagreements, inspect cited evidence, and make the parent acceptance decision. Do not build another model fan-out or silently assume workflowScript is enabled.'});
        else
          add({key:'delegation-contract',tool:'subagent',priority:79,text:'Independent work: inspect subagent({action:"list",capabilities:true}) to select an executable agent with the needed tools. Use native tasks/chain and commonTask for bounded shared briefs, or the supported workflow helpers for dependencies and recovery. Pass task-relevant skills and acceptance checks to each child, retain successful outputs, and consume completion notifications. Delegate only within the user’s scope and keep one writer per file.'});
      }
      if (process.env.PI_SMALL_TOOLS!=='off' && process.env.PI_REASONING_AIDS!=='off') {
        if (/\b(median|standard deviation|quartiles?|mae|rmse|r2|confusion matrix|precision and recall|f1|cosine|dot product|euclidean distance|split overlap|train.test overlap)\b/i.test(part)
          || /\b(?:calculate|compute|measure|compare|check|verify|estimate)\b[^;.!?]{0,80}\b(?:the |an? )?(?:arithmetic |geometric |harmonic |weighted )?mean\b/i.test(part.replace(/\bI mean\b/gi, ' ')))
          utilityHint('math_check','Numerical evidence: math_check computes summaries, regression/classification metrics, vector comparisons and exact split-ID overlap. Supply actual observations; undefined metrics remain null and exact-ID checks cannot rule out all leakage.');
        if (/\b(unicode|charset|mojibake|bidi|zero.width|line endings|nfc|(?:image|png|jpeg|gif|webp) (?:dimensions|size))\b/i.test(part))
          utilityHint('artifact_check','Artifact checks: artifact_check inspects Unicode controls/normalization or local image header dimensions. Use a specific workspace path or text. It does not verify font rendering, full image decoding or visual quality.');
        if (/\b(base64|URL (?:encod|decod)\w*|percent.encod\w*|(?:format|compact|pretty.print) (?:the )?JSON|JSON (?:format|compact)\w*)\b/i.test(part))
          utilityHint('value_convert','Exact conversion: value_convert handles bounded JSON formatting, strict UTF-8 Base64 and URI components without executing code or writing files. Pass only the value to convert; inspect the returned result before saving it.');
      }
      if (process.env.PI_CONTEXT_MEMORY!=='off') {
        if (/\b(handoff|hand.off|working state|agent context|compact context)\b/i.test(part))
          utilityHint('handoff_capsule','Small handoff: handoff_capsule packages the goal, constraints, findings, decisions, files, failures and next action. Preserve critical state explicitly; budget overflow means use more space or full context. Pass the capsule to a fresh subagent.');
        if (/\b(cache|reuse|retrieve)\b/i.test(part) && /\b(evidence|observations?|research|claims?)\b/i.test(part))
          utilityHint('evidence_cache','Reusable evidence: evidence_cache stores short verbatim local-source observations with hashes and branch provenance. Query rechecks source freshness; inferred conclusions still require validation.');
        if (/\b(rank|relevance|salience|prioriti[sz]e)\b/i.test(part) && /\b(memory|context|notes|items)\b/i.test(part))
          utilityHint('context_score','Retention priorities: context_score ranks supplied context items locally. Label goals, constraints and unresolved work explicitly; scores are priorities, not proof or calibrated probabilities.');
      }
      if (process.env.PI_CONTEXT_TOOLS!=='off' && process.env.PI_REASONING_AIDS!=='off') {
        if (/\b(code|functions?|symbols?|imports?|codebase|implementation)\b/i.test(part))
          utilityHint('context_slice','Scoped code context: context_slice ranks functions and imports from explicit workspace source files against the task. Inspect hashes, ranges and omissions; use ordinary reads before edits. A slice is not whole-project coverage.');
        if (/\b(callers?|callees?|references?|dependencies|dependency graph|type definitions?)\b/i.test(part))
          utilityHint('symbol_expand','Dependency context: symbol_expand follows bounded syntax candidates within explicit files and can augment with an already-running LSP. Read resolution and freshness metadata; names alone do not establish bindings.');
        if (/\b(diff|changed functions|patch)\b/i.test(part) || /\bchanges\b/i.test(part) && /\b(code|functions?|symbols?|implementation|source)\b/i.test(part))
          utilityHint('ast_diff','Change context: ast_diff compares supplied before/after source structurally. Keep raw patches for applying or reviewing exact edits, and verify behavior separately.');
      }
      if (/\b(syntax|type errors?|type.check|parse errors?)\b/i.test(part))
        utilityHint('lsp_diagnostics','Fresh code diagnostics: use lsp_diagnostics with explicit changed paths and serverScope:"primary" for a bounded syntax/type check. Missing servers or incomplete results are not evidence of clean code.');
      if (/\b(lint(?:ing)?|clean code|code quality|complexity|security|duplication|duplicate code|dead code)\b/i.test(part))
        utilityHint('lens_diagnostics','Code review evidence: lens_diagnostics({mode:"delta",paths:[...]}) retrieves scoped cached lint, complexity, security and duplication findings. A cold cache is not a clean result. Preserve existing project checks; avoid broad full-project runner refresh unless the task needs it.');
    }
  };
  const engineering = () => practice("engineering", "Engineering", ["evidence-first-engineering"],
    "Locate the existing owner and a concrete success check before changing code. Reuse its state/contracts; avoid parallel implementations and unrelated abstractions. Resolve the uncertainty that changes the next action, then implement and verify; expand investigation only on new evidence or risk. Stop when the requested behavior and relevant checks pass.");
  const precision = () => practice("evidence", "Precision work", ["evidence-first-engineering"],
    "Inspect actual schema, units, nulls and installed API/version contracts. Compute consequential numbers with executable code and validate counts/joins. Separate measured facts, assumptions and unverified claims; a mock proves local behavior, not a live service. Never fabricate records, endpoints, citations or successful checks.");
  const orient = () => add({ key: "workspace", tool: "project_report",
    text: 'Environment-sensitive work: project_report({view:"workspace"}) gives local/Git facts and bounded folder relationships (workspace members, local dependencies, module candidates). Inspect relevant shared contracts/tests before choosing edit scope; related folders are not automatically edit targets. Read relevant existing deployment/database instructions; establish local versus remote targets and protected data. A remote URL is not production identity or authorization.' });
  const uiHints = () => {
    skillHint("UI work", ["product-ui-verification", "frontend-design"], /\b(?:ui|frontend|interface)\b/i, false, 85);
    add({ key: "render", tool: "render_see", priority: 80, text: 'UI verification: call the available render_see directly for browser DOM/layout evidence and captures (output:"text" or "both"); its renderer is already installed, so supported captures need no Playwright discovery or installation. It is isolated and unauthenticated, with no interaction or GPU rendering. Use pixels when judging appearance; DOM bounds alone do not prove visual quality. Respect model vision capability and report unsupported verification.' });
  };
  const snapshot = () => ({ version: 1, cwd, unavailableTools:[...unavailable], shown: [...shown].slice(-LIMIT), read: [...read].slice(-48), requestNumber, topicSeen: [...topicSeen].slice(-64), context: context.slice(-48), extensions: [...extensions].slice(0,12), offers: [...skillOffers].slice(-48) });
  // A targeted pre-edit checkpoint, not a correctness verdict or a security
  // boundary. Only exact file routes qualify; lexical suggestions never gate.
  // Reading remains the native tool's job so delivery cannot masquerade as use.
  const reviewStatus = () => [...reviewTargets.values()].map(({skill, reason}) => ({
    name: skill.name, path: skill.file, reason,
    status: read.has(skill.file) ? 'read' : deferredSkills.has(skill.file) ? 'deferred' : 'needs_review',
    ...(deferredSkills.has(skill.file) ? { justification: deferredSkills.get(skill.file) } : {}),
  }));
  pi.registerTool?.({
    name: 'skill_review', label: 'Skill review',
    description: 'Inspect applicable pre-edit skills. Read their SKILL.md with read, or defer one with a task-specific reason when irrelevant, already covered or inaccessible. Deferral lasts this request and is not a read receipt.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('inspect'), Type.Literal('defer')]),
      skill: Type.Optional(Type.String({maxLength:512})),
      reason: Type.Optional(Type.String({minLength:12,maxLength:240})),
    }),
    async execute(_id: any, input: any) {
      if (input.action === 'defer') {
        const target = [...reviewTargets.values()].find(({skill}) => skill.name === input.skill || skill.file === input.skill);
        if (!target || typeof input.reason !== 'string' || input.reason.trim().length < 12 || input.reason.length > 240)
          return {isError:true, content:[{type:'text',text:'Choose a current skill from inspect and provide a task-specific reason (12–240 characters).'}]};
        deferredSkills.set(target.skill.file, input.reason.trim());
        try { pi.appendEntry?.('skill-review-decision', {requestNumber, skill:target.skill.name, disposition:'deferred', reason:input.reason.trim()}); } catch {}
      }
      const result = {enabled:reviewEnabled(), skills:reviewStatus(), scope:'Exact file routes only; at most four skills per request. Read-only work remains available.'};
      return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
    },
  });
  return {
    beforeToolCall(event: any) {
      if (!reviewEnabled() || !['edit','write'].includes(event.toolName)) return;
      const supplied = event.input?.path;
      if (typeof supplied !== 'string' || !supplied || supplied.length > 4096) return;
      const file = checkpointPath(supplied,cwd);
      if (/SKILL\.md$/i.test(file) || /(?:^|\/)(?:node_modules|vendor|dist|build|generated|backups)(?:\/|$)/i.test(file)) return;
      const applicable = routeSkills('',file).sort((a,b) => b.priority-a.priority)
        .map(route => ({skill:skills.find(s => s.name === route.name), reason:route.check}))
        .filter((entry): entry is {skill:Skill;reason:string} => !!entry.skill).slice(0,2);
      for (const entry of applicable) {
        if (!reviewTargets.has(entry.skill.file) && reviewTargets.size < 4) reviewTargets.set(entry.skill.file,entry);
      }
      const needed = applicable.filter(({skill}) => reviewTargets.has(skill.file) && !read.has(skill.file) && !deferredSkills.has(skill.file));
      if (!needed.length) return;
      return {block:true,reason:`Before editing ${JSON.stringify(supplied)}, review the matching workflow(s): ${needed.map(({skill,reason}) => `${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)}: ${reason}`).join(' ')} Read with the native read tool, then retry the edit. If a workflow does not apply, is already covered, or cannot be read, use skill_review({action:"defer",skill:"name",reason:"task-specific reason"}). Read-only inspection remains available.`};
    },
    userInput() {
      reviewTargets.clear(); deferredSkills.clear();
      const hadTopics = topicSeen.size > 0;
      requestNumber++;
      for (const [key, at] of topicSeen) if (requestNumber - at >= 3) topicSeen.delete(key);
      // A skipped suggestion is not a read receipt, but repeated nagging is noise:
      // re-offer an unread skill at most three times, spaced by two requests.
      for (const key of shown) {
        const file = skillKey(key);
        if (!file && key !== "delegation-contract") continue;
        if (file) {
          const offer = skillOffers.get(key) ?? { n: 0, at: -2 };
          if (offer.n >= 3 || requestNumber - offer.at < 2) continue;
          skillOffers.set(key, { n: offer.n + 1, at: requestNumber });
        }
        shown.delete(key);
      }
      if (hadTopics) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* advisory metadata */ }
    },
    restore(ctx: any) {
      reviewTargets.clear(); deferredSkills.clear();
      requestNumber = topicCount = toolStep = 0; topicSeen.clear();
      matchingPrompt = requestDisabled = false;
      cwd = ctx.cwd ?? ""; shown = new Set(); read = new Set(); pending.clear(); used.clear();
      context = []; extensions = new Set(); skillIndex = null; skillOffers = new Map(); outlines.clear();
      lastFailure = ""; failures = urgentCount = 0;
      skills = []; searches = polls = runCount = 0; polling = "";
      // Entries are local session metadata, not instructions or a new state file.
      const rawEntries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
      // A long-lived session can contain many thousands of tool events. Only
      // recent metadata can affect current receipts; bounding this pass keeps
      // restore latency and memory proportional to the state it can use.
      const entries = Array.isArray(rawEntries) ? rawEntries.slice(-MAX_RESTORE_ENTRIES) : [];
      // Capability failures survive compaction; successful execution is the
      // recovery receipt. Never infer availability from an assistant's claims.
      unavailable = new Set();
      for (const e of entries) {
        if (e?.type === "custom" && e.customType === ENTRY && e.data?.cwd === cwd && Array.isArray(e.data.unavailableTools))
          unavailable = new Set(e.data.unavailableTools.filter((name: unknown) => name === "render_see"));
        if (e?.type === "message" && e.message?.role === "toolResult") observeAvailability(e.message);
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i], d = e?.data;
        // A compaction can remove skill bodies; do not mistake old reads for current context.
        if (e?.type === "compaction") break;
        if (e?.type !== "custom" || e.customType !== ENTRY || d?.version !== 1 || d.cwd !== cwd) continue;
        shown = new Set((Array.isArray(d.shown) ? d.shown : []).filter((x: any) => typeof x === "string").slice(-LIMIT));
        requestNumber = Number.isSafeInteger(d.requestNumber) && d.requestNumber >= 0 ? d.requestNumber : 0;
        topicSeen = new Map((Array.isArray(d.topicSeen) ? d.topicSeen : []).slice(-64).filter((pair: any) =>
          Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && /^topic:[a-z0-9-]{1,100}$/.test(pair[0]) &&
          Number.isSafeInteger(pair[1]) && pair[1] >= 0 && pair[1] <= requestNumber && requestNumber - pair[1] < 3));
        read = new Set((Array.isArray(d.read) ? d.read : []).filter((x: any) => typeof x === "string").slice(-48));
        // Keep restored state in the same representation as live state. A Set
        // here made the next snapshot throw at context.slice(); the advisory
        // catch then hid the failure and silently lost guidance state.
        context = [...new Set((Array.isArray(d.context) ? d.context : [])
          .filter((x: any) => typeof x === "string" && /^[a-z0-9][a-z0-9+#._-]{3,31}$/.test(x))
          .slice(-48))];
        extensions = new Set((Array.isArray(d.extensions) ? d.extensions : []).filter((x: any) => typeof x === "string" && /^[a-z0-9]{1,8}$/.test(x)).slice(0,12));
        skillOffers = new Map((Array.isArray(d.offers) ? d.offers : []).slice(-48).filter((pair: any) =>
          Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && /^(?:skill|skillctx):\S{1,200}$/.test(pair[0]) &&
          Number.isSafeInteger(pair[1]?.n) && pair[1].n >= 0 && pair[1].n <= 3 && Number.isSafeInteger(pair[1]?.at) && pair[1].at >= -2));
        break;
      }
    },
    start(event: any, ctx: any) {
      if ((ctx.cwd ?? "") !== cwd) this.restore(ctx);
      lastFailure = ""; failures = urgentCount = 0;
      pending.clear(); used.clear(); searches = polls = runCount = topicCount = toolStep = 0; polling = "";
      matchingPrompt = false;
      requestDisabled = /\b(no tools|without tools|do not use tools|don't use tools)\b/i.test(skillTaskText(String(event.prompt ?? "")));
      if (!enabled()) return;
      matchingPrompt = true;
      const catalog = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(event.systemPrompt ?? "")?.[1] ?? "";
      skills = [...catalog.matchAll(/<skill>\s*<name>([^]*?)<\/name>\s*<description>([^]*?)<\/description>\s*<location>([^]*?)<\/location>\s*<\/skill>/g)].slice(0, 256)
        .map(m => ({ name: decode(m[1]), description: decode(m[2]), file: decode(m[3]) }))
        .filter(s => path.isAbsolute(s.file) && s.file.length < 512 && s.name.length < 100);
      // Read receipts are advisory metadata from an earlier catalogue
      // snapshot. Drop entries that are no longer available so a renamed or
      // removed skill cannot suppress a current recommendation after restore.
      const availableSkillFiles = new Set(skills.map(skill => skill.file));
      read = new Set([...read].filter(file => availableSkillFiles.has(file)));
      skillIndex = buildSkillIndex(skills);
      const rawPrompt = String(event.prompt ?? "");
      const taskPrompt = skillTaskText(rawPrompt);
      const prompt = skillIntentSegments(taskPrompt).join('\n');
      skillReviewDisabled = /\b(?:no skills|without skills|(?:do not|don't|never) (?:use|load|read) (?:(?:any|the) )?skills)\b/i.test(taskPrompt);
      utilityHints(taskPrompt);
      if (!/\b(no subagents|do not delegate|don't delegate|no delegation|without delegation)\b/i.test(taskPrompt) && /\b(use|ask|launch|delegate|run)\b[\s\S]{0,100}\b(subagents?|reviewers?|swarm|council)\b/i.test(prompt))
        add({key:"delegation-contract",tool:"subagent",priority:70,text:'Delegation: fresh reviewers may not inherit skills or tools. Include the task-relevant skill paths and ask the child to read them; carry the original goal, constraints, evidence inputs and success check. Use listed capabilities and preserve provider extensions. Validate workflow scripts before fan-out. Recover only failed children and retain successful outputs.'});
      if (process.env.PI_REASONING_AIDS !== "off" && !/\b(no tools|without tools|do not use tools|don't use tools)\b/i.test(prompt)) {
        const aides = [
          ['dependency_plan', /\b(plan|order|schedule|untangle|resolve)\b.*\b(dependenc(?:y|ies)|prerequisites|blocked tasks|task graph)\b|\b(dependency cycle|circular dependencies)\b/i, 'Known task dependencies: dependency_plan computes layers and cycle witnesses. Supply only known IDs/edges; preserve the current goal and todo owner. It does not establish resource-safe parallelism.'],
          ['decision_frontier', /\b(compare|choose|select|trade.?offs?|prioritize)\b.*\b(latency|cost|memory|throughput|accuracy|quality metrics)\b/i, 'Numerical tradeoffs: decision_frontier removes dominated options from supplied measurements without arbitrary weights. Gather unknown values first; skip it for a simple choice or subjective preference.'],
          ['coverage_select', /\b(select|choose|minimi[sz]e|reduce|prioritize|plan)\b.*\b(test suite|tests|checks|verification)\b.*\b(coverage|requirements|cost|redundan|overlap)\w*/i, 'Overlapping checks: coverage_select proposes a small set from explicit requirement/check coverage and costs. Preserve mandatory tests; claimed coverage is not evidence that a check passed.'],
        ] as const;
        for (const [tool,pattern,text] of aides) if(pattern.test(prompt)) add({key:`aid:${tool}`,tool,priority:65,text});
      }
      if (/\b(implement|fix|review|inspect|discover|investigate|refactor|trace|audit)\b/i.test(prompt) && /\b(monorepo|multi[- ](?:folder|repo|package)|workspace members|related (?:folders|repositories)|cross[- ](?:package|service)|codebase discovery|target scope)\b/i.test(prompt)) orient();
      if (/\b(commit|merge|rebase|cherry.pick|push|pull request|worktrees?|branches)\b/i.test(prompt) && !/\b(no tools|without tools)\b/i.test(prompt)) {
        add({key:"git-scope",tool:"project_report",priority:65,text:'Git work: project_report({view:"workspace"}) reports HEAD, branch, shared Git directory, local upstream divergence and operation markers. Session checkpoints are not commits. Inspect peer scope with session_coordinate when available; stage only task-owned changes and inspect the staged diff. A file may contain pre-existing changes: sharing its path does not make those changes yours. Preserve unrelated hunks and formatting; never sweep them into a commit. Preserve existing index/branch operations. For GitHub/CI, verify the exact tested/pushed commit and fresh remote evidence; cached tracking refs do not prove current remote state.'});
      }
      topicHints({prompt: prompt.length > 24000 ? prompt.slice(0,12000) + "\n" + prompt.slice(-12000) : prompt});
      routedSkills(prompt);
      const currentIntent = skillIntentSegments(prompt).join(' ');
      // Substantive new requests replace the old lexical topic profile. Short
      // continuation requests retain it; old domains cannot crowd out a pivot.
      if (!/\b(?:continue|resume|same task|next step)\b/i.test(currentIntent)) context = [];
      remember(currentIntent);
      contextSkill();
      codeSeen = /\b(code|function|class|module|repository|codebase|implementation)\b/i.test(prompt);
      // Match narrow task intent against skills actually present in this run's catalog.
      const specialized = [
        ['algorithm-design', /\b(algorithm|data structure|time complexity|amortized|shortest path|dynamic programming)\b/i, 'State input assumptions and complexity; compare a tiny optimized case against an independent baseline.'],
        ['concurrency-memory-models', /\b(atomics?|memory ordering|lock.free|linearizability|deadlock|shared.memory|multithreaded)\b/i, 'Identify synchronization and lifetime ownership; verify relevant schedules and ordering assumptions.'],
        ['memory-resource-ownership', /\b(memory leak|use.after.free|double.free|resource lifetime|ffi|buffer ownership)\b/i, 'Trace acquire, borrow, transfer and release through success, failure and cancellation.'],
        ['type-driven-design', /\b(typestate|algebraic data type|discriminated union|invalid states|type.driven|exhaustive matching)\b/i, 'Encode the actual domain states and validate external inputs; static types do not validate runtime data.'],
        ['formal-model-checking', /\b(model check(?:ing|er)?|formal verification|tla|prove.*(?:safety|liveness))\b/i, 'State assumptions, properties and exploration bounds; verify the model can detect a known defect.'],
        ['compiler-construction', /\b(compiler|parser|interpreter|ast rewrite|ir transformation|dsl)\b/i, 'Specify grammar and semantics; preserve effects and evaluation order through transformations.'],
        ['incremental-computation', /\b(incremental computation|incremental build|dependency graph|cache invalidation|memoization)\b/i, 'Compare incremental results to clean recomputation across edit and configuration sequences.'],
        ['property-based-testing', /\b(property.based|metamorphic|differential testing|fuzz(?:ing|er)?|generative testing)\b/i, 'Use independent properties, meaningful generators and shrinking; confirm a known defect is rejected.'],
        ['behavioral-contracts', /\b(state machine|invariant|idempotenc[ey]|race condition|lifecycle|transition)\b/i, 'Write one failing event sequence and verify the invariant through the real owner.'],
        ['numerical-computing', /\b(numerical|floating.point|linear algebra|matrix|jacobian|gradient check|integration tolerance)\b/i, 'Check shapes, units and an independent small answer; measure residuals and convergence.'],
        ['optimization-modeling', /\b(constrained optimization|convex|linear program|integer program|optimality|objective function)\b/i, 'Write variables, domains and constraints, then independently verify feasibility.'],
        ['statistical-experiments', /\b(a\/b test|causal|confidence interval|hypothesis test|statistical significance)\b/i, 'Identify the independent unit, effect and uncertainty before claiming improvement.'],
        ['data-lineage-validation', /\b(data lineage|reconcile|join cardinality|source records|denominator|audit.*dataset)\b/i, 'Trace the claim to actual records and validate joins and denominators.'],
        ['browser-task-recovery', /\b(browser|web page|website)\b.*\b(click|fill|submit|navigate|upload|automate|control)|\b(click|fill|submit|navigate|upload|automate|control)\b.*\b(browser|web page|website)\b/i, 'Observe current state, act, then verify the postcondition; reconcile uncertain mutations before retrying.'],
        ['accessible-interaction-design', /\b(accessibility|accessible|keyboard navigation|focus management|screen reader|aria)\b/i, 'Verify the actual keyboard task, focus transitions and error recovery.'],
        ['simulation-engineering', /\b(simulation|simulator|agent.based|monte carlo|physics engine)\b/i, 'Separate simulation time from rendering; validate invariants and convergence before visual polish.'],
        ['reinforcement-learning', /\b(reinforcement learning|rl|reward function|policy gradient|rollout buffer|bandit)\b/i, 'Validate the environment and tiny trajectory targets before scaling training.'],
        ['model-evaluation', /\b(llm eval|model eval|hallucination eval|tool.use eval|prompt comparison|evaluate.*(?:llm|grounding))\b/i, 'Score observable task outcomes and grounding; do not substitute fluent claims for evidence.'],
        ['inference-serving', /\b(inference serving|kv.cache|quantization|continuous batching|model serving)\b/i, 'Measure latency, memory and quality on matched cached and uncached workloads.'],
        ['performance-experiments', /\b(profile|profiling|benchmark|bottleneck|performance regression)\b/i, 'Measure completed work under matched conditions and preserve correctness.'],
      ] as const;
      if (/\b(build|make|create|implement|fix|review|write|analy[sz]e|train|evaluate|calculate|audit|debug|compare|inspect|solve|derive|optimize|profile|navigate|automate|control|test|design|prove|verify)\b/i.test(prompt)) {
        for (const [name, pattern, check] of specialized) {
          if (pattern.test(prompt) && skills.some(s => s.name === name))
            practice(name, name.replaceAll('-', ' '), [name], check);
        }
      }
      if (action.test(prompt)) {
        if (ui.test(prompt)) uiHints();
        if (env.test(prompt)) {
          orient();
          skillHint("Environment/data changes", ["evidence-first-engineering"], /deployment|infrastructure/i);
          if (/\b(database|migration|postgres|mysql|sqlite)\b/i.test(prompt)) skillHint("Database work", ["databases"], /\bdatabase/i);
        }
        // Language guidance only when the loaded catalogue actually offers it.
        const language = /\b(php|rust|python|golang)\b/i.exec(prompt)?.[1];
        if (language) skillHint(`${language} work`, [], new RegExp(`^${language}(?:$|[-_ ])`, "i"), true);
      }
      const doing = /\b(build|make|create|implement|fix|refactor|review|write|analy[sz]e|train|evaluate|animate|calculate|audit|debug|compare|inspect)\b/i.test(prompt);
      if (doing && !/\b(no subagents|do not delegate|don't delegate|no delegation|without delegation)\b/i.test(taskPrompt) && /\b(image|screenshot|diagram|visuals?)\b/i.test(prompt) && ctx.model?.input?.includes("image") !== true)
        add({ key: "visual-handoff", tool: "subagent", text: 'Visual evidence needed on a text-only or unknown-capability route: use subagent model discovery (input:image tools:true) and an eligible vision child with fresh context, the artifact and a precise read-only question. Require source-correlated image reads; a child’s claimed inspection alone is not visual evidence. Respect route/spending restrictions; do not delegate recursively. If unavailable, use supported DOM/geometry or file-metadata calculations, state their limits, and do not claim to have seen pixels.' });
      if (doing && /\b(animation|animate|motion graphics?|keyframes?|transitions?)\b/i.test(prompt))
        practice("motion", "Motion work", ["motion"],
          "Define the intended sequence, duration and key moments. Use one timeline owner and inspect start/middle/end plus interruption and reduced motion where relevant. UI interaction timing is not a limit on narrative animation; a still image cannot verify motion.");
      if (doing && /\b(machine learning|model training|train(?:ing)? (?:a |the )?model|classifier|regression model|feature engineering|ml|neural network|fine-tuning)\b/i.test(prompt))
        practice("ml", "ML work", ["ml-engineering"],
          "Define target, prediction time, baseline and held-out metric before tuning. Split by time/entity where needed before fitting preprocessing; exclude future or unavailable features. Record data version and executed evaluation; never invent scores or treat training metrics as generalization.");
      if (doing && /\b(dataset|csv|parquet|statistics|benchmark|apis?|openapi|schema|precision|measurements?)\b/i.test(prompt))
        precision();
      if (codeSeen && /\b(implement|refactor|build|write|review)\b/i.test(prompt)) engineering();
      if (/\b(previous session|earlier session|last session|what we decided|previous decision)\b/i.test(prompt))
        add({ key: "history", tool: "memory_search", text: 'Prior project decisions: memory_search can retrieve saved context. Read source notes and verify they still apply; memory is historical evidence, not current environment truth.' });
      if (/\b(original (?:request|instructions)|earlier instructions|lost context)\b/i.test(prompt))
        add({ key: "intent", tool: "checkpoint_read", text: 'Earlier requirements: checkpoint_read can recover original instructions. Apply later user corrections within their scope; do not reconstruct missing requirements from guesses.' });
      matchingPrompt = false;
    },
    record(event: any) {
      if (!enabled()) return;
      toolStep++;
      const name = event.toolName, input = event.input ?? {};
      if (observeAvailability(event)) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* advisory only */ }
      if (event.isError) {
        if (name === 'edit') {
          const message = (event.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => String(item.text ?? '').slice(0,8000)).slice(0,4).join('\n');
          if (/Edit without read|No verified read-tool coverage|Edit target not found|RE-READ REQUIRED|PARTIAL APPLY|No edits were applied|Could not find edits\[/.test(message))
            signalHint('edit-recovery','coding-practices','The edit was rejected or only partly applied. Read the current target region before rebuilding exact oldText. Follow the actual tool result: if nothing applied, retry the corrected complete batch; if some edits applied, retry only the failed edits. Preserve concurrent changes. Do not repeat stale text or bypass the guard with a whole-file overwrite.');
        }
        if (['read','edit','write','bash'].includes(name)) {
          const identity = String(input.path ?? input.command ?? '').slice(0,24000);
          const key = name + ':' + createHash('sha256').update(identity).digest('hex');
          failures = key === lastFailure ? failures + 1 : 1; lastFailure = key;
          if (failures >= 3) signalHint('repeated-failure','debugging',
            'The same tool operation failed repeatedly. Reinspect its preconditions and the latest error, form a changed hypothesis, and make one discriminating check before repeating it. A failed operation is not verified progress.');
        }
        return;
      }
      lastFailure = ""; failures = 0;
      if (['edit','write'].includes(name)) {
        const changedFile = typeof input.path === 'string' ? checkpointPath(input.path,cwd) : '';
        for (const hint of pending.values()) if (isTopic(hint.key) && hint.sourceFile &&
          (hint.sourceFile !== changedFile || name === 'write')) pending.delete(hint.key);
        const content = name === 'write' ? input.content : input.newText;
        // Native edits carry independent replacements. Never concatenate them:
        // separate regions need not form a valid expression together. Bound the
        // entire authored batch, not just each snippet, before doing review work.
        const snippets: unknown[] = name === 'edit' && Array.isArray(input.edits)
          ? input.edits.length <= 64 ? input.edits.map((edit: any) => edit?.newText) : []
          : [content];
        const validSnippets = snippets.filter((text): text is string => typeof text === 'string');
        const bounded = validSnippets.reduce((size, text) => size + text.length, 0) <= 24000 ? validSnippets : [];
        for (const text of bounded) topicHints({file:changedFile, text});
        if (process.env.PI_SMALL_TOOLS!=='off' && process.env.PI_REASONING_AIDS!=='off' && !/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|generated|backups)(?:\/|$)/i.test(changedFile) && bounded.some(text=>/[\uFFFD\u200B\u202A-\u202E\u2066-\u2069]/.test(text)))
          utilityHint('artifact_check','Unusual Unicode appeared in the authored edit. artifact_check({operation:"text",path:...}) can locate replacement characters, invisible controls and normalization differences. These may be intentional; inspect their role before changing them.');
        const signals = bounded.flatMap(text => [...codeGuidanceSignals(changedFile,text), ...slopGuidanceSignals(changedFile,text), ...qualityReviewSignals(changedFile,text)]);
        // Only a bounded whole-file write can clear cues from earlier snippets.
        // An edit of a different region is not evidence that the old issue disappeared.
        if (name === 'write' && typeof content === 'string' && content.length <= 24000) {
          const remaining = new Set(signals.map(s=>`signal:${s.key}`));
          for (const hint of pending.values()) if (hint.key.startsWith("signal:") && hint.sourceFile === changedFile && !remaining.has(hint.key)) pending.delete(hint.key);
        }
        for (const signal of signals) signalHint(signal.key,signal.skill,signal.check,changedFile);
      }
      // Discovery/status is not execution: listing agents must not suppress
      // subsequent workflow guidance for the actual delegated work.
      if ((name !== "project_report" || input.view === "workspace") && (name !== "subagent" || !input.action)) used.add(name);
      const file = typeof input.path === "string" ? checkpointPath(input.path, cwd) : "";
      // A successful range/truncated read proves access, not that the skill was read.
      const completeRead = (input.offset === undefined || input.offset === 1) && input.limit === undefined
        && event.details?.truncation?.truncated !== true;
      if (name === "read" && completeRead && file && !read.has(file) && skills.some(s => s.file === file)) {
        add({ key: "apply:skill-workflow", text: 'Apply the skill to this task: identify the relevant inputs, next action and observable success check. Use the smallest applicable workflow; skip unrelated sections. Missing evidence stays unknown. Verify the artifact or postcondition before claiming success; reading instructions alone is not completion.' });
        read.add(file); if (read.size > 48) read.delete(read.values().next().value!);
        contextSkill(52);
        try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* advisory state only */ }
      }
      if (["edit", "write"].includes(name) && /\.(?:[cm]?[jt]sx?|php|py|rs|go|java|rb|c|cpp|h|vue|svelte)$/i.test(file)) {
        engineering();
        add({key:'utility:lsp_diagnostics',tool:'lsp_diagnostics',priority:68,sourceFile:file,
          text:`Changed source: lsp_diagnostics with paths:[${JSON.stringify(file)}] and serverScope:"primary" can check current syntax/type diagnostics. Keep project tests; missing servers or incomplete results do not establish a clean check.`});
      }
      if (['edit','write'].includes(name) && sourceCheckSupported(file))
        add({key:'utility:syntax_check',tool:'syntax_check',priority:72,sourceFile:file,
          text:`Changed source/configuration: syntax_check({paths:[${JSON.stringify(file)}]}) runs bounded syntax checks. Batch related changed files in one call; a syntax pass does not replace project types, tests or configuration schema checks.`});
      if (["read", "edit", "write"].includes(name) && file && !/SKILL\.md$/i.test(file)) {
        if (/\.(?:[cm]?[jt]sx?|php|py|rs|go|java|rb|c|cpp|h|vue|svelte)$/i.test(file)) codeSeen = true;
        routedSkills("", file);
        remember(path.basename(file));
        const extension = /\.([a-z0-9]{1,8})$/.exec(file)?.[1]?.toLowerCase() ?? "";
        // A new file type reshapes the session profile; recompute once per type.
        if (extension && !extensions.has(extension) && extensions.size < 12) { extensions.add(extension); contextSkill(52); }
        if (uiFile.test(file)) uiHints();
        if (/\.(?:csv|tsv|parquet|jsonl)$/i.test(file) || /(?:^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(file)) precision();
        const language = /\.(php|py|rs|go)$/i.exec(file)?.[1]?.toLowerCase();
        if (language) {
          const label = ({php:"PHP",py:"Python",rs:"Rust",go:"Golang"} as Record<string,string>)[language];
          skillHint(`${label} work`, [], new RegExp(`^${label}(?:$|[-_ ])`, "i"), true);
        }
        if (envFile.test(file)) { orient(); skillHint("Environment/data changes", ["evidence-first-engineering"], /deployment|infrastructure/i); }
        if (name === 'read' && /\.(?:json|ya?ml)$/i.test(file))
          add({key:'utility:data_query',tool:'data_query',priority:68,sourceFile:file,
            text:`Structured file: data_query can query keys, counts, selected fields or filtered rows from ${JSON.stringify(file)} without a parsing script. Use ordinary reads when exact source text matters.`});
      }
      // Recognise shell text search too: bash-driven grep/rg is the common case,
      // and it is exactly when the structural tools would answer faster.
      const searchLike = ["grep", "find", "ls"].includes(name)
        || (name === "bash" && /(?:^|[|;&(]\s*)(?:rg|grep|find|fd|ag|ack)\b/i.test(String(input.command ?? "").slice(0, 400)));
      if (codeSeen && searchLike && ++searches >= 3)
        add({ key: "navigation", tool: "symbol_search", text: 'For identifier discovery, symbol_search ranks symbols across the workspace and builds its own index. A cold index returns a retry hint; inspect that result before continuing. Use it when repeated text searches are guessing; ordinary search stays appropriate for raw text.' });
      // Existing result owners already expose job/observation IDs. Only remind
      // about polling after repeated status calls, never invent a new handle.
      const status = name === "bg_status" || name === "process" && ["poll", "status", "list"].includes(input.action)
        || name === "subagent" && input.action === "status";
      const id = input.id ?? input.taskId ?? input.runId;
      const key = status && typeof id === "string" && /^[\w-]{1,100}$/.test(id) ? `${name}:${id}` : "";
      polls = key && key === polling ? polls + 1 : key ? 1 : 0; polling = key;
      if (polls >= 3) add({ key: "polling", text: `Repeated ${name} status checks for ${JSON.stringify(id)}: retain this handle. Prefer its supported bounded wait or completion notification; inspect progress when useful and do not relaunch work just to wait.` });
    },
    candidates(): Hint[] {
      if (!enabled()) return [];
      let remaining = Math.max(0, runAllowance() - (runCount - urgentCount));
      let emergency = urgentCount === 0;
      const active = tools();
      const eligible = [...pending.values()].filter(h => !wasShown(h.key) && (h.expiresAt === undefined || toolStep <= h.expiresAt) && (!h.tool || active.has(h.tool) && !used.has(h.tool) && !unavailable.has(h.tool)) && (!h.skill || !read.has(h.skill)))
        .sort((a,b)=>(b.priority ?? 0)-(a.priority ?? 0));
      const selected: Hint[] = [];
      for (const hint of eligible) {
        if (isTopic(hint.key) && topicCount + selected.filter(h=>isTopic(h.key)).length >= 2) continue;
        if (remaining > 0) remaining--;
        else if (hint.key.startsWith("signal:") && emergency) emergency = false;
        else continue;
        selected.push(hint);
        if (selected.length === 2) break;
      }
      return selected;
    },
    commit(hints: Hint[]) {
      for (const h of hints) { if (wasShown(h.key)) continue;
        if (isTopic(h.key)) { topicSeen.set(h.key, requestNumber); topicCount++; if (topicSeen.size > 64) topicSeen.delete(topicSeen.keys().next().value!); }
        else { shown.add(h.key); if (shown.size > LIMIT) shown.delete(shown.values().next().value!); }
        pending.delete(h.key); try { (globalThis as any)[Symbol.for("yunus-pi.health.v1")]?.("guidance.delivered",{decision:h.key.startsWith("signal:")?h.key:"skill-or-tool"}); } catch {}
        if (h.key.startsWith("signal:") && runCount - urgentCount >= runAllowance()) urgentCount++;
        runCount++; }
      if (hints.length) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* avoid blocking work */ }
    },
  };
}
