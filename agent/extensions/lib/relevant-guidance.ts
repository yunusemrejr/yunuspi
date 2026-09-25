import { localLm, skillRelevancePrompt, SKILL_RELEVANCE_EXAMPLES, SKILL_RELEVANCE_THRESHOLD } from "./local-lm.ts";
import { sessionObservability } from './session-observability.ts';
/** Bounded capability hints and task/file skill review owned by reminders.ts.
 * Deterministic routes remain authoritative; optional asynchronous discovery
 * offers bounded catalog-backed advice. Tool-output prose is never authority. */
import { createSkillDiscoveryController } from "./skill-discovery-controller.ts";
import { createContextAnchor } from "./context-anchor.ts";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { sourceCheckSupported } from "./source-check.ts";
import { authoredReviewSnippets, authoredReviewSignals } from "./authored-review.ts";
import { checkpointPath } from "./checkpoint-files.ts";
import { matchGuidanceTopics } from "./guidance-topics.ts";
import { routeSkills, routeSkillsPrecise, skillRoutes, skillTaskText, skillIntentSegments, skillActionSegments } from "./skill-routing.ts";
import { buildSkillIndex, rankSkills, skillCatalogFingerprint, skillTerms, skillEvidenceContext, headingOutline, bestSkillSection, skillReferenceLinks } from "./skill-relevance.ts";
import { CAPABILITY_GROUPS, capabilityGroup, groupOverview, searchCapabilityMetadata } from "./capability-groups.ts";
import { evaluateStuckSignal, isTrivialChangeRequest, shouldSuggestReview } from "./review-coordinator.ts";
import { lastQualityReviewCompletedAt } from "./quality-review-owner.ts";
import { failureCategory } from "./session-diagnostics.ts";
import { multiStageRetrieve } from "./micro-intelligence/retrieval.ts";
import { needleRank } from "./needle-runtime.ts";
import { createInterventionSession } from "./intervention-session.ts";
import { guidanceHintIntent } from "./intervention-intents.ts";
import { registerShadowSource } from "./intervention-registry.ts";

const ENTRY = "relevant-guidance";
const LIMIT = 96; // bounded recent delivery receipts, not a lifetime usage quota
const MAX_PENDING = 32;
const MAX_RUN_HINTS = 20;
const MAX_RESTORE_ENTRIES = 2000; // restore is metadata recovery, not a history scan
// A finite line limit can still return the entire file (for example 40 lines
// requested from a 21-line skill). Verify returned bytes, not the limit flag.
function returnedWholeSkill(file: string, content: any): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024) return false;
    const expected = fs.readFileSync(file, 'utf8');
    return Array.isArray(content) && content.some(part => part?.type === 'text' && part.text === expected);
  } catch { return false; }
}
const REVIEW_CONTEXT = 'skill-review-context';
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k]!));
const action = /\b(add|publish|export|convert|render|build|make|design|create|implement|fix|change|edit|refactor|debug|investigate|inspect|review|audit|improve|deploy|migrate|redesign|update|updating|repair|refine|polish|animate|optimize)\b/i;
/** Narrative and explanatory framing asks for prose about a subject, not work
 * on it: "Tell me a story about a simulation" names a skill while requesting
 * no engineering task, and the older two-term requirement used to filter that
 * by accident. A work-verb allow list cannot do this job — real requests say
 * "propagate", "simulate", "compute" — so the cue is the framing itself.
 * Tool-driven calls re-run the same owner with real execution evidence. */
const narrativeCue = /\b(?:tell|write|read|recite)\b[^\n]{0,40}\b(?:stor(?:y|ies)|tales?|poems?|essays?|novels?|blog posts?|books?)\b|\b(?:explain|describe|summari[sz]e|illustrate|narrate)\b|\b(?:what|who|when|where|why|how)\s+(?:is|are|was|were|does|do|did|would|should|can|could)\b|\btell me about\b/i;
const explicitReadOnlyCue = /\b(?:read[- ]only|just|only)\s+(?:inspect|review|audit|check|explain|summari[sz]e|report)\b|\b(?:do not|don't|never|without)\s+(?:edit|change|modify|write|touch|alter)\b/i;
const ui = /\b(ui|interface|frontend|front-end|layout|styles?|responsive|website|component|page|aesthetics|animations?)\b/i;
const env = /\b(production|deploy(?:ment)?|ci\/cd|server|migration|database|postgres|mysql|sqlite)\b/i;
const uiFile = /\.(?:tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const codeFile = /\.(?:[cm]?[jt]sx?|php|py|rs|go|java|rb|c|cpp|h|vue|svelte)$/i;
const envFile = /(?:^|\/)(?:migrations?|\.github\/workflows|terraform)(?:\/|$)|(?:^|\/)(?:Dockerfile|compose\.ya?ml)|\.(?:sql|tf)$/i;
type Skill = { name: string; file: string; description: string };
type Hint = { key: string; text: string; tool?: string; requiredTool?: string; skill?: string; reason?: string; priority?: number; sourceFile?: string; expiresAt?: number; discovery?: 'capability' | 'workflow' };

/** Words too broad to make a skill relevant on their own (observed as the
 * whole match behind off-topic hints: "deployment, history, self, json"). */
const GENERIC_CONTEXT_TERMS = new Set(["self", "json", "public", "content", "context", "analysis", "history", "based", "adding", "writing", "data", "file", "files", "page", "pages", "site", "system", "simple", "tool", "tools", "app", "code", "text", "help", "make", "list", "update", "check", "work", "project", "general", "using", "user", "users", "new", "build", "create", "support", "time", "info", "type", "types", "service", "services", "local"]);
export function createRelevantGuidance(pi: any) {
  let anchorContext = createContextAnchor();
  let cwd = "", shown = new Set<string>(), read = new Set<string>();
  let skills: Skill[] = [], pending = new Map<string, Hint>(), used = new Set<string>(), unavailable = new Set<string>();
  let context: string[] = [], extensions = new Set<string>(), skillIndex: ReturnType<typeof buildSkillIndex> | null = null, skillFingerprint = '';
  let skillOffers = new Map<string, { n: number; at: number }>();
  // Semantic gate for catalog-wide "session context" skill hints: the local
  // model judges each candidate against the current request once; verdicts
  // are cached per request focus. Measured on live sessions, lexical overlap
  // alone offered an ERP reference and a proxy-research pack for a music blog.
  let taskFocus = "", focusEpoch = 0;
  const skillVerdicts = new Map<string, "yes" | "no" | "pending">();
  // Load the local model descriptor now so the first prompt is already gated.
  try { localLm().ready(); } catch { /* optional */ }
  // Delivery counts for re-offerable utility/topic hints, mirroring skill
  // fatigue: an ignored advisory hint demotes after 2 deliveries and stops
  // after 4, so an off-target nudge cannot refill its slot forever. Using
  // the tool already filters via `used`, so only ignored hints fatigue.
  // Urgent signal: cues and skill hints (own counters) never fatigue here.
  // Discovery invitations share one topic key across tools, so they count
  // per key+tool: ignoring project_report must not silence a later
  // different-tool invitation.
  let topicOffers = new Map<string, number>();
  const fatigueKey = (h: Hint) => isTopic(h.key) && !h.key.startsWith("signal:") && !h.skill
    ? (h.tool ? `${h.key}\0${h.tool}` : h.key) : null;
  const topicIgnored = (h: Hint) => { const key = fatigueKey(h); return key ? topicOffers.get(key) ?? 0 : 0; };
  const outlines = new Map<string, { mtimeMs: number; headings: Array<{ text: string; line: number }>; links: string[] }>();
  let lastFailure = "", failures = 0, urgentCount = 0;
  let recentTools: string[] = [], errorRun = 0, recentErrorKinds: string[] = [], diagnosticCount = 0, trivialPrompt = false;
  let diagSuggestedAt = 0, lastReviewAt: number | undefined;
  let searches = 0, polling = "", polls = 0, runCount = 0, codeSeen = false;
  const sourceReads = new Set<string>();
  let ordinarySteps = 0;
  let requestNumber = 0, topicSeen = new Map<string, number>(), topicCount = 0, toolStep = 0;
  let matchingPrompt = false, requestDisabled = false, readOnlyPrompt = false;
  let skillReviewDisabled = false;
  // A generic advisory sentence is useful once per discovery kind in a user
  // request. This local cooldown keeps different route keys from repeating
  // the same reminder after every tool result; userInput starts a new window.
  const advisoryDiscoveryDelivered = new Set<'capability' | 'workflow'>();
  // Control session: every userInput opens a fresh canonical request
  // cycle; add() consults the per-subsystem envelope per queued hint
  // (consult-then-act, fail-open on control failure).
  const shadowPlane = createInterventionSession();
  try { registerShadowSource("guidance", () => shadowPlane.audit()); } catch { /* diagnostics only */ }
  // Control hygiene: dedup memory follows the pending set. Items removed
  // WITHOUT delivery (expiry, eviction, retraction, task/restore clears)
  // release their key so legitimate re-queue re-admits; commit() delivery
  // never releases (spent stays spent; re-offer stays suppressed).
  const releaseHint = (key: string) => { try { shadowPlane.release(key, "guidance"); } catch { /* hygiene never breaks delivery */ } };
  const releaseAllHints = () => { try { shadowPlane.releaseAll(); } catch { /* hygiene never breaks delivery */ } };
  const reviewTargets = new Map<string, { skill: Skill; reason: string; origin: 'task' | 'file' }>();
  const deferredSkills = new Map<string, string>();
  const bulkFiles = new Map<string, string[]>();
  // Skill routing is advisory by default. The native read gate and its
  // persistent checklist are deliberately opt-in because a relevant hint is
  // useful context, while forcing a read/defer round-trip for every task adds
  // ceremony and can stall ordinary work. Keep `off` as the explicit opt-out
  // for the inspect surface too; `required` is the only strict mode.
  const reviewMode = (): 'required' | 'off' | 'advisory' => {
    if (process.env.PI_SKILL_REVIEW === 'required') return 'required';
    if (process.env.PI_SKILL_REVIEW === 'off') return 'off';
    return 'advisory';
  };
  const reviewAvailable = () => enabled() && !skillReviewDisabled && reviewMode() !== 'off'
    && tools().has('read') && tools().has('skill_review');
  const reviewEnabled = () => reviewAvailable() && reviewMode() === 'required';
  const trackReview = (skill: Skill, reason: string, origin: 'task' | 'file') => {
    if (skillReviewDisabled) return;
    if (!reviewTargets.has(skill.file) && reviewTargets.size >= 32) {
      const resolved = [...reviewTargets.keys()].find(file => read.has(file) || deferredSkills.has(file));
      reviewTargets.delete(resolved ?? reviewTargets.keys().next().value!);
    }
    reviewTargets.set(skill.file, {skill, reason, origin:reviewTargets.get(skill.file)?.origin === 'task' ? 'task' : origin});
  };
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
  // The default route offers one concrete optional match in each category.
  // Keep the selected identity and reason: replacing those with generic browse
  // instructions throws away the work of both deterministic and async routing.
  // Strict review mode retains its separate read checkpoint and safety contract.
  // Advisory discovery is available by default. Its controller owns the
  // observation threshold, explicit opt-out, request budget and cancellation.
  const advisoryInvitation = (hint: Hint): Hint | undefined => {
    const operationalGuidance = new Set(['visual-handoff', 'render', 'workspace', 'delegation-contract']);
    if (reviewMode() !== 'advisory' || skillReviewDisabled || hint.key.startsWith('signal:') || operationalGuidance.has(hint.key)) return hint;
    const kind = hint.skill ? 'workflow' : hint.tool ? 'capability' : undefined;
    if (!kind) return hint;
    // Rank-derived and async-discovery skill hints keep their concrete
    // identity: rewriting them into the shared one-shot discovery topic
    // silently dropped every computed rank (600 ranks → 0 delivered). The
    // discovery marker is preserved so delivery accounting still applies.
    if (hint.key.startsWith('skillctx:')) return {...hint, discovery: kind};
    if (advisoryDiscoveryDelivered.has(kind)) return undefined;
    const tool = kind === 'workflow' ? 'skill_review' : 'tool_search';
    // A limited child/session may not expose the discovery surface. Preserve
    // its existing direct hint rather than dropping useful safety guidance.
    const active = tools();
    if (!active.has(tool)) return hint;
    if (kind === 'capability' && !active.has(hint.tool!)) {
      // Registration can justify a metadata preview, never a promise that
      // discovery owns permission to activate an inactive or restricted tool.
      try {
        const catalog = pi.getAllTools?.();
        if (!Array.isArray(catalog) || !catalog.some(item => item?.name === hint.tool)) return undefined;
      } catch { return undefined; }
    }
    const skill = kind === 'workflow' ? skills.find(skill => skill.file === hint.skill) : undefined;
    const summary = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
    const tracked = skill && reviewTargets.has(skill.file);
    const text = skill
      ? `Optional workflow: ${JSON.stringify(skill.name)} — ${JSON.stringify(summary(hint.reason ?? skill.description, 180))}. Read ${JSON.stringify(skill.file)} if useful; ${tracked ? 'skill_review({action:"inspect"}) lists its tracked checks.' : 'no review step is required.'}`
      : kind === 'workflow'
        ? 'Optional workflow discovery: skill_review can search installed workflows if useful for the current step.'
        : `Optional capability (${JSON.stringify(hint.tool)}): ${summary(hint.text, 420)} ${active.has(hint.tool!) ? 'Use only if useful; no extra call is required.' : `If useful, preview tool_search({query:${JSON.stringify(hint.tool)}}) to check this session's availability.`}`;
    return {
      ...hint,
      // A fresh shared topic key avoids stale receipts for the old concrete
      // tool/skill key on resume. topicSeen supplies the existing three
      // request cooldown and persists only this bounded invitation metadata.
      key: `topic:discovery-${kind}`,
      tool: kind === 'capability' && active.has(hint.tool!) ? hint.tool : tool,
      skill: skill?.file,
      discovery: kind,
      text,
    };
  };
  const renderEnvironmentFailure = (event: any) => {
    if (event.toolName !== "render_see" || event.isError !== true) return false;
    const text = (event.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? '').slice(0,8192)).slice(0,3).join('\n');
    // A target's transport denial is not a broken Chromium installation.
    let report = event.details;
    if (!report) try { report = JSON.parse(text); } catch { /* legacy error text */ }
    if (report?.status === "failed" && report.failure?.stage === "navigation") return false;
    return /browser startup failure|browserType\.launch|EROFS|EACCES|EPERM|read.only file system|No usable sandbox|Chromium sandboxing failed|SUID sandbox helper|Executable doesn.t exist|Unsupported chromium channel|Cannot find (?:module|package).*playwright/i.test(
      text.split(/; diagnostics:|\nBrowser logs:/)[0]);
  };
  const observeAvailability = (event: any) => {
    if (event.toolName !== "render_see") return false;
    const before = unavailable.has("render_see");
    if (!event.isError) unavailable.delete("render_see");
    else if (renderEnvironmentFailure(event)) unavailable.add("render_see");
    return before !== unavailable.has("render_see");
  };
  const add = (hint: Hint) => {
    const invited = advisoryInvitation(hint);
    if (!invited) return;
    hint = invited;
    // Explicitly read-only turns may still use concrete read tools, but they
    // should not accumulate workflow, skill or generic practice invitations.
    // Signal hints remain available because they report actual failures or
    // safety state rather than asking the user to start extra work.
    const passive = Boolean(hint.skill || hint.discovery || hint.key.startsWith("practice:") || hint.key.startsWith("topic:") || hint.key.startsWith("aid:") || hint.key.startsWith("harness:"));
    if (readOnlyPrompt && passive && !hint.key.startsWith("signal:")) return;
    // Task-level suggestions remain relevant until the next prompt. File/edit
    // cues still expire quickly so stale local observations cannot linger.
    if (!matchingPrompt && !hint.key.startsWith("signal:") && hint.expiresAt === undefined) hint = {...hint, expiresAt:toolStep+4};
    if (!enabled() || wasShown(hint.key)) return;
    if (hint.tool && (!tools().has(hint.tool) || used.has(hint.tool) || unavailable.has(hint.tool))) return;
    if (hint.skill && (skillReviewDisabled || read.has(hint.skill))) return;
    // Review obligations never pass through here, so compliance is unaffected;
    // reading the skill clears it through the receipt above.
    if (hint.skill && suppressed(hint.skill)) return;
    for (const [key, value] of pending) if (value.expiresAt !== undefined && toolStep > value.expiresAt) { pending.delete(key); releaseHint(key); }
    const previous = pending.get(hint.key);
    if (previous && (previous.priority ?? 0) >= (hint.priority ?? 0)) {
      if (hint.sourceFile && (isTopic(hint.key) || previous.sourceFile) && (previous.priority ?? 0) === (hint.priority ?? 0)) pending.set(hint.key, hint);
      return;
    }
    // Generic advisory invitations are deliberately coalesced. Keeping one
    // capability and one workflow offer pending makes a long session useful
    // without spending the normal hint quota on identical text.
    if (hint.discovery) {
      const existing = [...pending.values()].find(value => value.discovery === hint.discovery);
      if (existing) {
        if ((existing.priority ?? 0) >= (hint.priority ?? 0)) return;
        pending.delete(existing.key); releaseHint(existing.key);
      }
    }
    if (!previous && pending.size >= MAX_PENDING) {
      const weakest = [...pending.values()].sort((a,b)=>(a.priority ?? 0)-(b.priority ?? 0))[0];
      if ((weakest.priority ?? 0) >= (hint.priority ?? 0)) return;
      pending.delete(weakest.key); releaseHint(weakest.key);
    }
    // Go-live (step 17): binding per-request automation budget. A refused
    // hint is dropped with its receipt in the journal. Control failure
    // fails OPEN (deliver) — enforcement must never break delivery itself.
    let admitted = true;
    try {
      admitted = shadowPlane.enforce(guidanceHintIntent(hint)).outcome === "admitted";
    } catch { admitted = true; }
    if (!admitted) return;
    pending.set(hint.key, hint);
  };
  const discovery = createSkillDiscoveryController({
    catalog: () => skills,
    covered: file => skillCovered(file) || reviewTargets.has(file) || deferredSkills.has(file),
    enabled: () => enabled() && !skillReviewDisabled && tools().has('read') && tools().has('subagent'),
    offer: (skill, reason) => add({key:`skillctx:${skill.file}`,skill:skill.file,reason,priority:64,
      text:`Async skill discovery (advisory): ${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)} — ${JSON.stringify(reason)} Read if useful; this suggestion is not a read receipt or a new requirement.`}),
  });
  for (const event of ['agent_end','session_shutdown','session_before_switch','session_before_fork','session_before_tree','model_select'])
    pi.on?.(event, () => discovery.cancel());
  const skillHint = (topic: string, preferred: string[], terms: RegExp, nameOnly = false, priority = 0) => {
    // Exact known skills first; otherwise use a matching *loaded* description.
    // No fabricated paths and no catalogue/skill-body injection.
    const skill = preferred.map(n => skills.find(s => s.name === n)).find(Boolean)
      ?? skills.find(s => terms.test(s.name))
      ?? (!nameOnly ? skills.find(s => terms.test(s.description)) : undefined);
    if (skill) add({ key: `skill:${skill.file}`, skill: skill.file, priority,
      text: `${topic}: read the relevant workflow in ${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)} before applying it.${sectionPointer(skill.file, [...skillTerms(topic, 8), ...context.slice(-16)])} User instructions and project conventions take precedence.` });
  };
  const practice = (key: string, topic: string, preferred: string[], text: string, priority?: number) => {
    const skill = preferred.map(n => skills.find(s => s.name === n)).find(Boolean);
    if (skill) {
      // A short operational check still helps models that overlook skill discovery.
      if (!read.has(skill.file)) add({ key: `skill:${skill.file}`, skill: skill.file, priority,
        text: `${topic}: ${text} Read ${JSON.stringify(skill.file)} for the relevant workflow.${sectionPointer(skill.file, [...skillTerms(topic, 8), ...context.slice(-16)])} User intent and project conventions win.` });
    } else add({ key: `practice:${key}`, priority, text: `${topic}: ${text}` });
  };
  // Subjective/uncertain phrasing that signals unclear requirements rather
  // than a specified task. Kept tight: every marker must read as vagueness
  // in ordinary task prompts, since this is the only gate that spends a
  // guidance slot on zero-route prompts.
  const VAGUE_TASK_MARKERS = /\b(?:not sure|unsure|something|somehow|whatever|this and that|you know|sort of|kind of|weird|unique|better|nicer|prettier)\b/i;
  const routedSkills = (prompt = "", file = "", precomputed?: ReturnType<typeof routeSkills>) => {
    const previous = JSON.stringify([...reviewTargets.values()]);
    const routes = precomputed ?? routeSkills(prompt, file);
    for (const route of routes) {
      const skill = skills.find(s => s.name === route.name);
      if (skill && file && route.priority >= 60) trackReview(skill, route.check, 'file');
      if (skill) add({key:`skill:${skill.file}`, skill:skill.file, priority:route.priority,
        text:`${route.check} Read ${JSON.stringify(skill.file)} for the applicable workflow and examples.${sectionPointer(skill.file, skillTerms(`${prompt} ${file}`, 24))} User intent and project conventions take precedence.`});
    }
    // Vague-but-actionable and unmatched: subjective/uncertain language with
    // action verbs but no skill route and no other evidence. Positive
    // vagueness markers (not mere absence of a route) keep this precise:
    // document prose, management prompts and negated requests stay silent.
    if (prompt && !routes.length && skillActionSegments(prompt).length && VAGUE_TASK_MARKERS.test(prompt)) engineering(70);
    if (!matchingPrompt && previous !== JSON.stringify([...reviewTargets.values()]))
      try { pi.appendEntry?.(ENTRY,snapshot()); } catch { /* retain file workflows across compaction */ }
  };
  const skillKey = (key: string) => key.startsWith("skillctx:") ? key.slice(9) : key.startsWith("skill:") ? key.slice(6) : "";
  const skillCovered = (file: string) => read.has(file) || [...pending.values()].some(h => h.skill === file) || shown.has(`skill:${file}`) || shown.has(`skillctx:${file}`);
  // Offer counts were already persisted per skill but never consumed, so a
  // repeatedly ignored workflow kept its full priority forever. Established
  // fatigue drops the advisory hint to the floor: a fresh candidate then wins
  // the scarce delivery slot decisively (a tie in priority would only preserve
  // insertion order and change nothing). Reading the skill clears it, and a
  // single earlier mention never demotes anything.
  const offeredBefore = (file: string) => Math.max(skillOffers.get(`skill:${file}`)?.n ?? 0, skillOffers.get(`skillctx:${file}`)?.n ?? 0);
  const fatigue = (file: string) => offeredBefore(file) >= 2 ? 40 : 0;
  // Advisory skill hints suppress after three ignored re-offers (fourth
  // delivery). Fatigue demotes at two, but demotion alone re-filled the slot
  // forever — one workflow was recommended ten times in a single session.
  const suppressed = (file: string) => offeredBefore(file) >= 4;
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
        const body = fs.readFileSync(file, "utf8");
        entry = { mtimeMs: stat.mtimeMs, headings: headingOutline(body), links: skillReferenceLinks(body) };
        if (outlines.size >= 24) outlines.delete(outlines.keys().next().value!);
        outlines.set(file, entry);
      }
      const section = bestSkillSection(entry.headings, terms);
      return section ? ` Start at ${JSON.stringify(section.text)} (line ${section.line}); skip unrelated sections.` : "";
    } catch { return ""; }
  };
  // Follow-on detail: a skill whose body links references/ paths names them
  // when read, so the agent follows the matching ones instead of stopping at
  // the entry (a network session read the entry and never opened its two
  // discovery/evidence references).
  const referencePointer = (file: string): string => {
    if (!file) return "";
    try {
      const stat = fs.statSync(file);
      let entry = outlines.get(file);
      if (!entry || entry.mtimeMs !== stat.mtimeMs) {
        if (stat.size > 96 * 1024) return "";
        const body = fs.readFileSync(file, "utf8");
        entry = { mtimeMs: stat.mtimeMs, headings: headingOutline(body), links: skillReferenceLinks(body) };
        if (outlines.size >= 24) outlines.delete(outlines.keys().next().value!);
        outlines.set(file, entry);
      }
      return entry.links.length ? ` Follow-on detail: ${entry.links.map(link => JSON.stringify(link)).join(", ")} — read the ones matching this task.` : "";
    } catch { return ""; }
  };
  const gateNote = (skill: string, decision: string, score?: number) => { try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("skill.gate", { skill, decision, ...(score !== undefined ? { score } : {}) }); } catch { /* telemetry */ } };
  /** Deliver a session-context skill hint only when its match is substantive:
   * at least one non-generic term, and (when the local model is installed) a
   * calibrated relevance judgement for the current request. */
  const gatedContextHint = (skill: Skill, matched: string[], hint: Hint) => {
    const meaningful = matched.map(term => term.split("~").at(-1)!).filter(term => !GENERIC_CONTEXT_TERMS.has(term));
    if (!meaningful.length) { gateNote(skill.name, "generic-terms"); return; }
    // Until the local model is known to be ready the lexical hint keeps its
    // previous immediate behavior; readiness is loaded in the background.
    if (!taskFocus || process.env.PI_SKILL_GATE === "off" || !localLm().ready()) { add(hint); return; }
    const key = `${skill.file}\0${focusEpoch}`;
    const verdict = skillVerdicts.get(key);
    if (verdict === "yes") { add(hint); return; }
    if (verdict) return;
    skillVerdicts.set(key, "pending");
    if (skillVerdicts.size > 256) skillVerdicts.delete(skillVerdicts.keys().next().value!);
    const epoch = focusEpoch;
    void localLm().judge(skillRelevancePrompt(taskFocus, skill), "skill-relevance", { prefix: SKILL_RELEVANCE_EXAMPLES }).then(result => {
      if (epoch !== focusEpoch) return;
      // Without a usable model the lexical hint keeps its previous behavior.
      if (!result.ok) { skillVerdicts.delete(key); add(hint); return; }
      const keep = result.p >= SKILL_RELEVANCE_THRESHOLD;
      skillVerdicts.set(key, keep ? "yes" : "no");
      gateNote(skill.name, keep ? "kept" : "filtered", Math.round(result.p * 100) / 100);
      if (keep) add(hint);
    }, () => { if (epoch === focusEpoch) { skillVerdicts.delete(key); add(hint); } });
  };
  /** Catalog-wide relevance against the ongoing session profile. Weak or generic
   * overlap yields nothing; explicit routes and signals keep their priority. */
  const contextSkill = (priority = 55) => {
    if (!skillIndex || !context.length) return;
    let offered = 0;
    const coveredTerms = new Set<string>();
    for (const ranked of rankSkills(skillIndex, context.join(" "), 6)) {
      // A skill already carrying a review target (route or file evidence) is
      // covered: suggesting it again as a context candidate double-counts the
      // same workflow instead of offering a fresh one.
      if (skillCovered(ranked.skill.file) || reviewTargets.has(ranked.skill.file)) continue;
      // Suppressed workflows consume no offer slot and no covered terms: the
      // scarce slot passes fully to a fresh candidate instead of demoting in
      // place. Central add() suppression still guards every other producer.
      if (suppressed(ranked.skill.file)) continue;
      const terms = ranked.matched.map(term => term.split('~').at(-1)!);
      // One naming token is decisive only while no other workflow's explicit
      // route already owns that token. "python" routes to the language
      // workflow, so a specialized pack such as wasm-python must not claim
      // generic Python work through the one-term shortcut; a real two-term
      // match still qualifies it.
      if (ranked.matched.length === 1 && !ranked.matched[0].includes('~')
        && skillRoutes.some(route => route.name !== ranked.skill.name && route.intent.test(terms[0])))
        continue;
      // A lone term that names an already-read or under-review skill is
      // claimed signal, not a second workflow: "network" matching
      // network-traffic-analysis after local-network-analysis was read is the
      // same domain, not a new one. Multi-term matches still surface.
      if (ranked.matched.length === 1 && !ranked.matched[0].includes('~')
        && skillIndex.docs.some(doc => doc.skill.file !== ranked.skill.file && doc.name.has(terms[0]) && (read.has(doc.skill.file) || reviewTargets.has(doc.skill.file))))
        continue;
      // Require one genuinely fresh term instead of rejecting a workflow whose
      // whole match is shared vocabulary. Rejecting on any overlap let a single
      // high-scoring skill hide a distinct second workflow that shared a term,
      // so the same suggestion re-filled the slot every request.
      if (!terms.some(term => !coveredTerms.has(term))) continue;
      // Advisory context hints yield one bounded step to a fresh candidate once
      // the same workflow has already been offered and ignored; explicit task
      // and file routes keep their full priority and their review obligation.
      // Calibration telemetry: score joins read receipts in ranking audits.
      try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("skill.rank", {skill: ranked.skill.name, score: ranked.score, matched: ranked.matched.length}); } catch {}
      gatedContextHint(ranked.skill, ranked.matched, { key: `skillctx:${ranked.skill.file}`, skill: ranked.skill.file,
        priority: Math.max(1, priority - fatigue(ranked.skill.file)),
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
  // A bounded source-read checkpoint keeps agents from repeatedly dumping
  // large files when an existing structural owner can narrow the next read.
  // Only path metadata and returned length guide admission; source bodies
  // are never copied into the hint.
  const sourceNavigation = (file: string, broadRead: boolean) => {
    if (!broadRead) return;
    if (!codeFile.test(file)) return;
    if (sourceReads.size < 12) sourceReads.add(file);
    if (sourceReads.size < 2) return;
    const contextSupported = /\.(?:[cm]?[jt]sx?|py)$/i.test(file);
    const owners = contextSupported
      ? ['module_report', 'context_slice', 'context_code', 'symbol_search']
      : ['module_report', 'symbol_search'];
    const owner = owners.find(name => tools().has(name));
    if (!owner) return;
    const text = owner === 'module_report'
      ? `Repeated source reads: use module_report on an explicit path such as ${JSON.stringify(file)} for a compact outline; ${tools().has('read_symbol') ? 'then use read_symbol for one exact body.' : 'then read only the needed region.'} Prefer targeted reads over another whole-file dump.`
      : owner === 'context_slice'
        ? `Repeated source reads: context_slice can rank relevant functions and imports for the current task when given explicit paths including ${JSON.stringify(file)}. Inspect hashes and omissions, then read only the needed regions.`
        : owner === 'context_code'
          ? `Repeated source reads: context_code can find relevant code in an explicit path such as ${JSON.stringify(file)}. Use a short identifier and inspect the returned ranges before reading or editing.`
          : `Repeated source reads: use symbol_search with a short identifier to rank candidate files before another broad text search. Inspect the returned path and line evidence, then read the exact region.`;
    add({key:'source-context-navigation',tool:owner,priority:67,sourceFile:file,text});
  };
  const utilityHints = (prompt: string) => {
    const parts=prompt.replace(/```[^]*?(?:```|$)/g,' ').replace(/^\s*>.*$/gm,' ').split(/\n|[.!?](?:\s|$)|;/);
    for (const part of parts) {
      if (!/\b(test|reproduce|try|check|inspect|calculate|compute|measure|analy[sz]e|evaluate|audit|verify|fix|lint|convert|encode|decode|format|compact|compare|review|rank|retrieve|cache|reuse|prepare|prioriti[sz]e|read|query|extract|count|replace|rename|run|start|launch|wait|track|plan|fill|submit|navigate|delegate|use|fuse|merge|consolidate|search|find|connect|build|create|implement|optimize|configure|deploy|flash)\b/i.test(part) || /\b(explain|what is|how does|do not|don't|never|without tools|no tools)\b/i.test(part)) continue;
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
      if (/\b(agentmail|agent.?mail)\b/i.test(part) || (/\b(emails?|mail|mailbox(?:es)?|inbox(?:es)?)\b/i.test(part) && /\b(send|search|find|connect|read|list|triage|outreach|reply|forward)\b/i.test(part) && !/\b(thunderbird|imap|smtp|mbox|maildir)\b/i.test(part)))
        utilityHint('agentmail_send','Email via AgentMail (explicitly named capability): use agentmail_status to confirm the configured inbox, agentmail_search to find mail by topic, agentmail_messages to list compact inbox rows, agentmail_message for one full read, and agentmail_send for a bounded send with a required subject. Bypass generic repeated discovery: one tool_search({kind:"capabilities",id:"agentmail-email",enable:true}) stages the complete email bundle. For Thunderbird, local mailbox files, or other IMAP servers, read the email skill first. Keep the API key in the environment; never persist, log, or echo it.');
      if (/\b(lead|leads|prospect|prospects|company|companies|contact|contacts)\b/i.test(part) && /\b(research|find|discover|lookup|enrich|qualify|outreach|list)\b/i.test(part))
        utilityHint('research_toolkit','Lead/company/contact research (composable, provenance-aware): research_toolkit plans query angles, records lead/company candidates with source URLs and retrieved-at evidence, and gathers source notes with hashes. Compose it with web_search/fetch_content/web_research for retrieval, then verify primary sources before outreach. One tool_search({kind:"capabilities",id:"research-toolkit",enable:true}) stages the bundle.');
      if (/\b(sandbox(?:es)?|isolated? (?:experiment|test|reproduction)s?|disposable|scratch environment|without (?:affecting|changing|touching) (?:the )?(?:project|workspace))\b/i.test(part))
        utilityHint('sandbox_run','Disposable experiments: sandbox_run runs a bounded script in a fresh environment with explicit copied files or fixtures, no project/home mounts or network, and automatic cleanup. Combine related steps in one call. If isolation cannot start, report it; never silently run the experiment on the host.');
      if (/\b(http|api endpoint|response headers?|status code)\b/i.test(part))
        utilityHint('http_request','HTTP inspection: http_request returns status, headers and a capped body for a bounded request. Reuse it for endpoint diagnostics; preserve authorization and do not repeat an uncertain mutation.');
      if (/\b(listening ports?|systemd|service status|processes|cpu usage|memory usage)\b/i.test(part))
        utilityHint('sys_probe','System facts: sys_probe inspects processes, listening ports and systemd state without assembling shell pipelines. Use the narrowest supported operation and the returned current facts.');
      if (/\b(linux|laptop|host machine|host environment|wifi|wi-fi|network interface|firewall|reboot|poweroff|stress test|raspberry\s*pi|esp32|esp8266|esp-idf|arduino|microcontroller|firmware|gpio|serial port|i2c|spi)\b/i.test(part))
        utilityHint('sys_probe','Host/device preflight: sys_probe({action:"host"}) reports resources and session dependencies; action:"devices" lists candidate nodes without opening them. Preserve connectivity, parent processes and mounted data. Inspect test/build entrypoints before execution; use bounded sandbox_run for experiments. Board identity, voltage, pins and a recovery route must be verified before device writes.');
      if (/\b(sqlite|sqlite3|database tables?)\b/i.test(part))
        utilityHint('sqlite_probe','SQLite evidence: sqlite_probe inspects an explicit workspace database using tables/schema/describe/query/explain. Use its bounded read-only results instead of Python or sqlite3 shell snippets.');
      if (/\b(installed (?:package|version|dependency)|package exports|peer dependencies|lockfile|node_modules)\b/i.test(part))
        utilityHint('package_probe','Dependency evidence: package_probe returns the physically installed Node package and lock resolution. Check this version and exports before reasoning from remembered APIs.');
      if (/\b(openapi|swagger|request shape|response shape)\b/i.test(part))
        utilityHint('openapi_probe','API specification: openapi_probe selects endpoints, operations, schemas, request/response shapes and auth from an explicit spec without loading the whole document.');
      if (/\b(coverage|lcov|cobertura|uncovered lines?)\b/i.test(part))
        utilityHint('coverage_probe','Coverage evidence: coverage_probe reads existing artifacts for explicit files and can intersect changed Git lines. It never runs tests and does not assume artifacts are fresh.');
      if (/\b(contract diff|schema changes?|payload changes?)\b/i.test(part))
        utilityHint('contract_diff','Structural changes: contract_diff compares two explicit JSON/YAML files or payloads. Use mode schema for required/optional schema contracts; sample payloads only establish observed shapes.');
      if (/\b(environment variables?|env audit|\.env\.example|missing configuration)\b/i.test(part))
        utilityHint('env_audit','Environment contract: env_audit compares explicit source/config paths and reports variable names only. It never reads live environment values or follows external env files.');
      if (/\b(dns|tcp connectivity|tls certificate|certificate expir|connection refused)\b/i.test(part) || /\bconnect(?:ing|ion)? to\b/i.test(part) || /\b(unreachable|refused|timed?\s?out)\b/i.test(part))
        utilityHint('net_probe','Connection diagnostics: net_probe checks DNS, one TCP host:port or TLS certificate validation. Use one explicit endpoint; no network scanning.');
      if (/\b(archive contents?|zip contents?|tar contents?|inspect (?:an? )?archive)\b/i.test(part))
        utilityHint('archive_probe','Archive inspection: archive_probe lists, finds and stats members or reads one bounded text member without extraction.');
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
        if (/\b(svg|viewbox|vector artwork)\b/i.test(part))
          utilityHint('artifact_check','SVG preflight: artifact_check({operation:"svg",path:...}) inspects bounded structure, IDs/references and resource cues without rendering or fetching assets. Fix demonstrated findings, then inspect rendered sizes, clipping, typography and contrast with render_see; source checks do not prove appearance or sanitize active content.');
        if (/\b(frame time|frame budget|frame pacing|gpu memory|render budget|webgpu|webgl|three\.?js)\b/i.test(part))
          utilityHint('math_check','Graphics budgets: math_check operation:"frame_budget" summarizes observed frame milliseconds against target_fps; operation:"render_budget" estimates attachment bytes from width/height/pixel_ratio/bytes_per_pixel/samples/buffers. Measure representative hardware and compare visual detail before lowering quality; estimates exclude textures, geometry and driver overhead.');
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
  const engineering = (priority?: number) => practice("engineering", "Engineering", ["evidence-first-engineering"],
    "Locate the existing owner and a concrete success check before changing code. Reuse its state/contracts; avoid parallel implementations and unrelated abstractions. Resolve the uncertainty that changes the next action, then implement and verify; expand investigation only on new evidence or risk. Stop when the requested behavior and relevant checks pass.", priority);
  const precision = () => practice("evidence", "Precision work", ["evidence-first-engineering"],
    "Inspect actual schema, units, nulls and installed API/version contracts. Compute consequential numbers with executable code and validate counts/joins. Separate measured facts, assumptions and unverified claims; a mock proves local behavior, not a live service. Never fabricate records, endpoints, citations or successful checks.");
  const orient = () => add({ key: "workspace", tool: "project_report",
    text: 'Environment-sensitive work: project_report({view:"workspace"}) gives local/Git facts and bounded folder relationships (workspace members, local dependencies, module candidates). Inspect relevant shared contracts/tests before choosing edit scope; related folders are not automatically edit targets. Read relevant existing deployment/database instructions; establish local versus remote targets and protected data. A remote URL is not production identity or authorization.' });
  const uiHints = () => {
    skillHint("UI work", ["product-ui-verification", "frontend-design"], /\b(?:ui|frontend|interface)\b/i, false, 85);
    add({ key: "render", tool: "render_see", priority: 80, text: 'UI verification: call the available render_see directly for browser DOM/layout evidence and captures (output:"text" or "both"); its renderer is already installed, so supported captures need no Playwright discovery or installation. It is isolated and unauthenticated, with no interaction or GPU rendering. Use pixels when judging appearance; DOM bounds alone do not prove visual quality. Respect model vision capability and report unsupported verification.' });
    utilityHint('artifact_check','UI source review: artifact_check({operation:"ui",path:...}) locates status-pill, typography, color and interaction cues in a complete component. Reuse project tokens and components; inspect rendered states before accepting a design. The check is advisory and does not replace browser verification.');
  };
  const snapshot = () => ({ version: 1, cwd, unavailableTools:[...unavailable], shown: [...shown].slice(-LIMIT), read: [...read].slice(-48), requestNumber, topicSeen: [...topicSeen].slice(-64), topicOffers: [...topicOffers].slice(-64), context: context.slice(-48), extensions: [...extensions].slice(0,12), offers: [...skillOffers].slice(-48), reviews:[...reviewTargets.values()], deferrals:[...deferredSkills], diag:[diagnosticCount,diagSuggestedAt] });
  // A workflow checkpoint, not a correctness verdict or a security boundary.
  // Deterministic task/file routes qualify; weak lexical suggestions never gate.
  // Reading remains the native tool's job so delivery cannot masquerade as use.
  const reviewStatus = () => [...reviewTargets.values()].map(({skill, reason}) => ({
    name: skill.name, path: skill.file, reason,
    status: read.has(skill.file) ? 'read' : deferredSkills.has(skill.file) ? 'deferred' : 'needs_review',
    ...(deferredSkills.has(skill.file) ? { justification: deferredSkills.get(skill.file) } : {}),
  }));
  const FILLER = new Set(['use','using','please','find','get','show','list','skill','skills','workflow','workflows','relevant','appropriate','best','good','right','proper','some','any','help','helpful','needed','need','needs','for','with','about','related']);
  const normalizeSkillQuery = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s+#._-]+/g,' ').split(/\s+/).filter(term => term && !FILLER.has(term)).join(' ').slice(0,256);
  const MARKETING_FAMILY = new Set(['resourceful-market-strategy','community-promotion','organic-growth-engineering','copywriting','natural-editorial-writing']);
  const searchSkills = async (query: unknown, requestedLimit: unknown, requestedOffset: unknown, requestedGroup: unknown) => {
    const text = typeof query === 'string' ? query.trim().slice(0, 256) : '';
    // Explicit family requests such as "use marketing skills" reliably
    // resolve: filler verbs and the generic skills/workflows token carry no
    // signal, while the domain term must survive. Without this, "skills"
    // dilutes the ranking and the marketing family loses to incidental prose.
    const group = typeof requestedGroup === 'string' ? requestedGroup.trim().slice(0, 64) : '';
    const limit = Number.isInteger(requestedLimit) ? Math.min(8, Math.max(1, Number(requestedLimit))) : 3;
    const offset = Number.isSafeInteger(requestedOffset) ? Math.max(0, Number(requestedOffset)) : 0;
    if (!skills.length) return {results:[], offset, limit, remaining:0};
    const candidates = skills.filter(skill => !group || capabilityGroup(skill.name, skill.description) === group);
    const sortSkills = (left: Skill, right: Skill) => left.name.localeCompare(right.name) || left.file.localeCompare(right.file);
    let ordered: Skill[];
    if (!text) {
      ordered = [...candidates].sort(sortSkills);
    } else {
      const effective = normalizeSkillQuery(text) || text;
      const ranked = skillIndex
        ? rankSkills(skillIndex, effective, Math.min(256, Math.max(8, skills.length))).map(item => item.skill)
          .filter(skill => !group || capabilityGroup(skill.name, skill.description) === group)
        : [];
      // Explicit discovery must honor direct short domain/name matches before
      // passive suggestions, whose deliberately stricter tokenizer drops PHP,
      // API and CSS. Keep fuzzy recovery and the full catalog behind those hits.
      // Search both the raw and the filler-stripped query so "use marketing
      // skills" matches the marketing family instead of generic skill prose.
      const lexical = [...searchCapabilityMetadata(candidates, text), ...searchCapabilityMetadata(candidates, effective)];
      ordered = [...lexical, ...ranked];
      // Explicit family request: when the stripped query names a known family
      // domain, surface that family first while preserving advisory ranking
      // behind it. "marketing" maps to the installed market/community/growth
      // workflows; full bodies stay on demand via read.
      if (/\bmarketing\b/i.test(effective)) {
        const family = candidates.filter(skill => MARKETING_FAMILY.has(skill.name));
        if (family.length) ordered = [...family.sort(sortSkills), ...ordered.filter(skill => !MARKETING_FAMILY.has(skill.name))];
      }
    }
    const seen = new Set<string>();
    let unique = ordered.filter(skill => {
      if (seen.has(skill.file)) return false;
      seen.add(skill.file);
      return true;
    });
    // Local Needle3 ranking fused with the lexical head (see retrieval.ts):
    // measured top-5 skill hits 10/18 lexical vs 13/18 fused. Worker caches
    // keep pagination stable; unavailable Needle keeps the lexical order.
    if (text && unique.length > 1) {
      const head = unique.slice(0, 12).map(skill => ({ id: skill.file, text: `${skill.name}: ${skill.description}`, skill }));
      const outcome = await multiStageRetrieve({ kind: 'skill', site: 'rank', query: text, lexical: head,
        local: (task, candidates, purpose, options) => localLm().choose(task, candidates, purpose, options),
        needle: (needleQuery, candidates, topK) => needleRank({ query: needleQuery, candidates, topK }) }).catch(() => undefined);
      if (outcome && outcome.applied !== 'lexical') unique = [...outcome.ordered.map(entry => entry.skill), ...unique.slice(12)];
    }
    const selected = unique.slice(offset, offset + limit);
    return {
      results: selected.map((skill) => ({
        name: skill.name,
        path: skill.file,
        description: skill.description.slice(0, 240),
      })),
      offset,
      limit,
      remaining: Math.max(0, unique.length - offset - selected.length),
    };
  };
  const reviewPage = (requestedLimit: unknown, requestedOffset: unknown) => {
    const limit = Number.isInteger(requestedLimit) ? Math.min(8, Math.max(1, Number(requestedLimit))) : 3;
    const offset = Number.isInteger(requestedOffset) ? Math.min(1000, Math.max(0, Number(requestedOffset))) : 0;
    const all = reviewStatus();
    const skills = all.slice(offset, offset + limit);
    return {skills, offset, limit, remaining: Math.max(0, all.length - offset - skills.length)};
  };
  // Keep unresolved reads and applicable checks on the wire. A delivered hint
  // must not disappear forever, and this must not enqueue extra model turns.
  pi.on?.('context', (event: any, ctx: any) => {
    const messages = event.messages.filter((m: any) => m.customType !== REVIEW_CONTEXT);
    if (!reviewEnabled() || ctx && ctx.cwd !== cwd)
      return messages.length !== event.messages.length ? {messages} : undefined;
    const status = reviewStatus().filter(s => s.status !== 'deferred');
    const selected = [...status.filter(s => s.status === 'needs_review').slice(0,3), ...status.filter(s => s.status === 'read').slice(-2)];
    if (!selected.length) return messages.length !== event.messages.length ? {messages} : undefined;
    const text = ['[Applicable skills]', 'Read relevant SKILL.md files before using their workflow; apply the listed checks and retain result evidence. A suggestion is not a read, and a read is not proof of application.',
      ...selected.map(s => `${s.status === 'read' ? 'Apply (read)' : 'Read required'}: ${JSON.stringify(s.path)} — ${s.reason}`),
      tools().has('skill_review') ? 'Use skill_review inspect for all targets; defer only with a task-specific reason. User instructions take precedence.' : 'If a skill does not apply or cannot be read, state the task-specific reason. User instructions take precedence.',
    ].join('\n');
    // Keep unchanged guidance at its first boundary; changed read status goes
    // after the new evidence, without invalidating the earlier request prefix.
    const guidance = {role:'custom',customType:REVIEW_CONTEXT,content:text.slice(0,2800),display:false,timestamp:0};
    return {messages:anchorContext(messages,guidance,requestNumber)};
  });
  pi.registerTool?.({
    name: 'skill_review', label: 'Skill review',
    description: 'Browse compact groups or search the bounded installed skill catalogue, and inspect applicable task/file skill status. Read a selected SKILL.md with read, or defer one with a task-specific reason when irrelevant, already covered or inaccessible. Browse/search are advisory and never create a review obligation.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('browse'), Type.Literal('inspect'), Type.Literal('defer'), Type.Literal('search')]),
      skill: Type.Optional(Type.String({maxLength:512})),
      reason: Type.Optional(Type.String({minLength:12,maxLength:240,description:"Concise task-specific rationale, 12–240 characters; do not paste a review report."})),
      group: Type.Optional(Type.String({maxLength:64,description:'Group id from browse; optional search filter.'})),
      query: Type.Optional(Type.String({maxLength:256,description:'Case-insensitive catalogue name/description query; bounded and advisory.'})),
      limit: Type.Optional(Type.Integer({minimum:1,maximum:8,default:3,description:'Maximum matching skills to return (default 3).'})),
      offset: Type.Optional(Type.Integer({minimum:0,description:'Page through metadata matches; each response remains bounded.'})),
    }),
    async execute(_id: any, input: any) {
      if (input.action === 'browse' || input.action === 'search') {
        const group = typeof input.group === 'string' ? input.group.trim().slice(0,64) : '';
        if (group && !CAPABILITY_GROUPS.some(candidate => candidate.id === group))
          return {isError:true, content:[{type:'text',text:'Unknown skill group. Use skill_review({action:"browse"}) for the available group ids.'}]};
        if (input.action === 'browse' && !group && typeof input.query !== 'string') {
          const groups = groupOverview(skills.map(skill => ({name:skill.name,description:skill.description})));
          const result = {groups, note:'Browse is metadata-only. Supply group or query for a short paginated preview; search and browse never create a review obligation.'};
          return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
        }
        const query = typeof input.query === 'string' ? input.query.trim().slice(0,256) : '';
        const page = await searchSkills(query,input.limit,input.offset,group);
        const result = {query, ...(group ? {group} : {}), ...page,
          nextOffset:page.remaining ? page.offset+page.results.length : null,
          next:'Read a chosen result.path with the read tool when useful. To explore tools or local ML/SLM helpers, use tool_search({}).',
          scope:'Installed catalogue metadata only; no skill bodies are read or returned, and search never creates a review obligation.'};
        // Search stays side-effect-free by contract (see the scope note
        // above): no per-search ledger rows. Selected/rejected arrive as
        // read/defer receipts; a considered-set ledger needs a reader and a
        // bound before it earns per-search writes.
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      }
      if (input.action === 'defer') {
        const target = [...reviewTargets.values()].find(({skill}) => skill.name === input.skill || skill.file === input.skill);
        if (!target || typeof input.reason !== 'string' || input.reason.trim().length < 12 || input.reason.length > 240)
          return {isError:true, content:[{type:'text',text:'Choose a current skill from inspect and provide a task-specific reason (12–240 characters).'}]};
        deferredSkills.set(target.skill.file, input.reason.trim());
        try { pi.appendEntry?.('skill-review-decision', {requestNumber, skill:target.skill.name, disposition:'deferred', reason:input.reason.trim()}); } catch {}
        try { pi.appendEntry?.(ENTRY,snapshot()); } catch {}
      }
      const result = {enabled:reviewEnabled(), available:reviewAvailable(), mode:reviewMode(), ...reviewPage(input.limit,input.offset), scope:'Deterministic task and file routes; at most two reads requested per operation. Discovery and skill reads remain available. Reads do not prove application.'};
      return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
    },
  });
  return {
    beforeToolCall(event: any) {
      if (!reviewEnabled()) return;
      const supplied = event.input?.path ?? event.input?.file_path;
      const mutation = ['edit','write'].includes(event.toolName) || event.toolName === 'bulk_edit' && event.input?.action === 'apply';
      const file = typeof supplied === 'string' && supplied.length <= 4096 ? checkpointPath(supplied,cwd) : '';
      const excluded = (value: string) => /SKILL\.md$/i.test(value) || /(?:^|\/)(?:node_modules|vendor|dist|build|generated|backups)(?:\/|$)/i.test(value);
      if (file && excluded(file)) return;
      const suppliedFiles = event.toolName === 'bulk_edit' ? bulkFiles.get(event.input?.token) ?? event.input?.files : event.input?.paths;
      const files = [file, ...(Array.isArray(suppliedFiles) ? suppliedFiles.slice(0,200).filter((p: any) => typeof p === 'string').map((p: string) => checkpointPath(p,cwd)) : [])].filter(p => p && !excluded(p));
      const applicable = mutation ? files.flatMap(file => routeSkillsPrecise('',file).slice(0,2))
        .map(route => ({skill:skills.find(s => s.name === route.name), reason:route.check}))
        .filter((entry): entry is {skill:Skill;reason:string} => !!entry.skill) : [];
      for (const entry of applicable) trackReview(entry.skill,entry.reason,'file');
      // Source reads and discovery stay open. The task checkpoint also covers
      // research, browser/media work and shell/delegated execution, not just edits.
      const execution = mutation || ['bash','sandbox_run','web_search','web_research','browser_session','render_see','media_edit','music_compose','data_query'].includes(event.toolName)
        || event.toolName === 'subagent' && !event.input?.action;
      if (!execution) return;
      const currentFiles = new Set(applicable.map(entry => entry.skill.file));
      const needed = [...reviewTargets.values()].filter(({skill,origin}) =>
        (origin === 'task' && (!mutation || !currentFiles.size || !skillRoutes.find(route => route.name === skill.name)?.file) || currentFiles.has(skill.file)) && !read.has(skill.file) && !deferredSkills.has(skill.file)).slice(0,2);
      if (!needed.length) return;
      return {block:true,reason:`Before ${event.toolName}${file ? ` on ${JSON.stringify(supplied)}` : ''}, read the matching workflow(s): ${needed.map(({skill,reason}) => `${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)}: ${reason}`).join(' ')} Read with the native read tool, apply the relevant checks, then retry. If a workflow does not apply, is already covered, or cannot be read, use skill_review({action:"defer",skill:"name",reason:"task-specific reason"}). Source reads and discovery remain available.`};
    },
    userInput() {
      discovery.cancel();
      const hadDeferrals = deferredSkills.size > 0;
      deferredSkills.clear();
      const hadTopics = topicSeen.size > 0;
      requestNumber++;
      try { shadowPlane.beginRequest(`request-${requestNumber}`); } catch { /* shadow only */ }
      advisoryDiscoveryDelivered.clear();
      for (const [key, at] of topicSeen) if (requestNumber - at >= 3) topicSeen.delete(key);
      // Space renewed offers across requests; never treat ignored suggestions
      // as read receipts or permanently retire an unread workflow.
      for (const key of shown) {
        const file = skillKey(key);
        if (!file && key !== "delegation-contract") continue;
        if (file) {
          const offer = skillOffers.get(key) ?? { n: 0, at: -2 };
          if (requestNumber - offer.at < 2) continue;
          // The count must survive past the suppression threshold; snapshots
          // stay bounded through the sliced offers list, not this number.
          skillOffers.set(key, { n: Math.min(99,offer.n + 1), at: requestNumber });
        }
        shown.delete(key);
      }
      if (hadTopics || hadDeferrals) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* advisory metadata */ }
    },
    shadowAudit() {
      try { return shadowPlane.audit(); } catch { return null; }
    },
    shadowJournal() {
      try { return shadowPlane.journal(); } catch { return []; }
    },
    restore(ctx: any) {
      discovery.cancel(true);
      anchorContext = createContextAnchor();
      reviewTargets.clear(); deferredSkills.clear();
      bulkFiles.clear();
      requestNumber = topicCount = toolStep = 0; topicSeen.clear();
      matchingPrompt = requestDisabled = false;
      readOnlyPrompt = false;
      advisoryDiscoveryDelivered.clear();
      cwd = ctx.cwd ?? ""; shown = new Set(); read = new Set(); pending.clear(); releaseAllHints(); used.clear();
      context = []; extensions = new Set(); skillIndex = null; skillFingerprint = ''; skillOffers = new Map(); topicOffers = new Map(); outlines.clear();
      lastFailure = ""; failures = urgentCount = 0;
      skills = []; searches = polls = runCount = 0; polling = ""; sourceReads.clear(); ordinarySteps = 0;
      recentTools = []; errorRun = 0; recentErrorKinds = []; diagnosticCount = 0; trivialPrompt = false; diagSuggestedAt = 0; lastReviewAt = undefined;
      // Entries are local session metadata, not instructions or a new state file.
      const rawEntries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
      // A long-lived session can contain many thousands of tool events. Only
      // recent metadata can affect current receipts; bounding this pass keeps
      // restore latency and memory proportional to the state it can use.
      const entries = Array.isArray(rawEntries) ? rawEntries.slice(-MAX_RESTORE_ENTRIES) : [];
      // A compaction invalidates reads, not the still-active task's workflows.
      const prior = [...entries].reverse().find(e => e?.type === 'custom' && e.customType === ENTRY && e.data?.cwd === cwd);
      for (const entry of (Array.isArray(prior?.data?.reviews) ? prior.data.reviews : []).slice(-32)) {
        if (!entry?.skill || typeof entry.skill.file !== 'string' || !path.isAbsolute(entry.skill.file) || entry.skill.file.length >= 512
          || typeof entry.skill.name !== 'string' || entry.skill.name.length >= 100 || typeof entry.reason !== 'string' || entry.reason.length > 1000
          || !['task','file'].includes(entry.origin)) continue;
        reviewTargets.set(entry.skill.file,entry);
      }
      skills = [...reviewTargets.values()].map(entry => entry.skill);
      for (const entry of (Array.isArray(prior?.data?.deferrals) ? prior.data.deferrals : []).slice(-32)) {
        if (Array.isArray(entry) && entry.length === 2 && reviewTargets.has(entry[0]) && typeof entry[1] === 'string' && entry[1].length >= 12 && entry[1].length <= 240)
          deferredSkills.set(entry[0],entry[1]);
      }
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
          Number.isSafeInteger(pair[1]?.n) && pair[1].n >= 0 && pair[1].n <= 99 && Number.isSafeInteger(pair[1]?.at) && pair[1].at >= -2));
        topicOffers = new Map((Array.isArray(d.topicOffers) ? d.topicOffers : []).slice(-64).filter((pair: any) =>
          Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && /^topic:\S{1,200}(?:\0[a-z0-9_-]{1,64})?$/.test(pair[0]) &&
          Number.isSafeInteger(pair[1]) && pair[1] >= 0 && pair[1] <= 99).map((pair: any) => [pair[0], pair[1]] as [string, number]));
        if (Array.isArray(d.diag) && Number.isSafeInteger(d.diag[0]) && d.diag[0] >= 0 && d.diag[0] <= 99 && Number.isSafeInteger(d.diag[1]) && d.diag[1] >= 0) {
          diagnosticCount = d.diag[0]; diagSuggestedAt = d.diag[1];
        }
        break;
      }
    },
    start(event: any, ctx: any) {
      if ((ctx.cwd ?? "") !== cwd) this.restore(ctx);
      const previousReviews = JSON.stringify([...reviewTargets.values()]);
      lastFailure = ""; failures = urgentCount = 0;
      pending.clear(); releaseAllHints(); used.clear(); searches = polls = runCount = topicCount = toolStep = 0; polling = ""; sourceReads.clear(); ordinarySteps = 0;
      recentTools = []; errorRun = 0; recentErrorKinds = [];
      trivialPrompt = isTrivialChangeRequest(String(event.prompt ?? ""));
      try { lastReviewAt = lastQualityReviewCompletedAt(ctx); } catch { lastReviewAt = undefined; }
      matchingPrompt = false;
      advisoryDiscoveryDelivered.clear();
      requestDisabled = /\b(no tools|without tools|do not use tools|don't use tools)\b/i.test(skillTaskText(String(event.prompt ?? "")));
      // Discovery owns the complete installed metadata catalogue, independently
      // of whether ambient suggestions are enabled. Only responses/ranking are
      // bounded; later skills must not disappear from search or pagination.
      const configured = event.systemPromptOptions?.skills;
      const catalog = Array.isArray(configured) ? '' : [...String(event.systemPrompt ?? '').matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)].map(match => match[1]).join('\n');
      const metadata = Array.isArray(configured)
        ? configured.filter(s => !s.disableModelInvocation).map(s => ({name:s.name, description:s.description ?? '', file:s.filePath}))
        : [...catalog.matchAll(/<skill>\s*<name>([^]*?)<\/name>\s*<description>([^]*?)<\/description>\s*<location>([^]*?)<\/location>\s*<\/skill>/g)]
          .map(m => ({name:decode(m[1]),description:decode(m[2]),file:decode(m[3])}));
      const seenFiles = new Set<string>();
      skills = metadata.filter(s => {
        if (typeof s.name !== 'string' || !s.name || typeof s.description !== 'string'
          || typeof s.file !== 'string' || !path.isAbsolute(s.file) || seenFiles.has(s.file)) return false;
        seenFiles.add(s.file);
        return true;
      });
      // Read receipts are advisory metadata from an earlier catalogue
      // snapshot. Drop entries that are no longer available so a renamed or
      // removed skill cannot suppress a current recommendation after restore.
      const availableSkillFiles = new Set(skills.map(skill => skill.file));
      read = new Set([...read].filter(file => availableSkillFiles.has(file)));
      // The installed catalog rarely changes between turns: rebuild the TF-IDF
      // index only when its content fingerprint changed.
      const catalogFingerprint = skillCatalogFingerprint(skills);
      if (!skillIndex || skillFingerprint !== catalogFingerprint) { skillIndex = buildSkillIndex(skills); skillFingerprint = catalogFingerprint; }
      if (!enabled()) return;
      matchingPrompt = true;
      const rawPrompt = String(event.prompt ?? "");
      const taskPrompt = skillTaskText(rawPrompt);
      const prompt = skillIntentSegments(taskPrompt).join('\n');
      readOnlyPrompt = narrativeCue.test(prompt) || explicitReadOnlyCue.test(taskPrompt);
      skillReviewDisabled = /\b(?:no skills|without skills|(?:do not|don't|never) (?:use|load|read) (?:(?:any|the) )?skills)\b/i.test(taskPrompt);
      discovery.start(event, ctx);
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
      // One routing evaluation per pass: routeSkills is pure for (prompt,
      // file), and re-evaluating also triple-emits skill.route telemetry.
      const promptRoutes = routeSkills(prompt);
      routedSkills(prompt, "", promptRoutes);
      const currentIntent = skillIntentSegments(prompt).join(' ');
      // Substantive new requests replace the old lexical topic profile. Short
      // continuation requests retain it; old domains cannot crowd out a pivot.
      const continuation = currentIntent.length < 100 && /\b(?:continue|resume|same task|next step|keep going)\b/i.test(currentIntent) && !promptRoutes.some(route => route.priority >= 60);
      if (!continuation) { context = []; reviewTargets.clear(); taskFocus = taskPrompt.replace(/\s+/g, " ").trim().slice(0, 700); focusEpoch++; }
      for (const [file] of reviewTargets) if (!availableSkillFiles.has(file)) reviewTargets.delete(file);
      // Precision order (action intent + file/domain evidence) picks the
      // surfaced three; .sort() by raw priority would undo it. Advisory:
      // routedSkills() above still sees every candidate.
      const preciseRoutes = routeSkillsPrecise(prompt).filter(route => route.priority >= 60 && skills.some(skill => skill.name === route.name)).slice(0,3);
      for (const route of preciseRoutes) {
        const skill = skills.find(s => s.name === route.name);
        if (skill) trackReview(skill,route.check,'task');
      }
      remember(currentIntent);
      if (!narrativeCue.test(prompt)) contextSkill();
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
      if (previousReviews !== JSON.stringify([...reviewTargets.values()]))
        try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* receipts are advisory metadata */ }
    },
    record(event: any) {
      if (!enabled()) return;
      toolStep++;
      const name = event.toolName, input = event.input ?? {};
      recentTools.push(name); if (recentTools.length > 8) recentTools.shift();
      if (observeAvailability(event)) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* advisory only */ }
      if (event.isError) {
        if (name === 'edit') {
          const message = (event.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => String(item.text ?? '').slice(0,8000)).slice(0,4).join('\n');
          if (/Edit without read|No verified read-tool coverage|Edit target not found|RE-READ REQUIRED|PARTIAL APPLY|No edits were applied|Could not find edits\[|edits\[\d+\].*\boverlap\b/i.test(message))
            signalHint('edit-recovery','coding-practices','The edit was rejected or only partly applied. Read the current target region before rebuilding exact oldText. Follow the actual tool result: if nothing applied, retry the corrected complete batch; if some edits applied, retry only the failed edits. Preserve concurrent changes. Do not repeat stale text or bypass the guard with a whole-file overwrite.');
        }
        if (['read','edit','write','bash'].includes(name)) {
          const identity = String(input.path ?? input.command ?? '').slice(0,24000);
          const key = name + ':' + createHash('sha256').update(identity).digest('hex');
          failures = key === lastFailure ? failures + 1 : 1; lastFailure = key;
          if (failures >= 3) signalHint('repeated-failure','debugging',
            'The same tool operation failed repeatedly. Reinspect its preconditions and the latest error, form a changed hypothesis, and make one discriminating check before repeating it. A failed operation is not verified progress.');
        }
        // Stuck-pattern escalation (suggestion only, never a launch): several
        // consecutive errors with multi-cause or loop evidence earn one
        // bounded error-review suggestion. Transients and trivial work stay quiet.
        errorRun++;
        try {
          const excerpt = (event.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "").slice(0, 2000)).slice(0, 2).join("\n");
          recentErrorKinds.push(failureCategory(excerpt).category);
          if (recentErrorKinds.length > 4) recentErrorKinds.shift();
        } catch { /* classification is advisory */ }
        if (errorRun >= 4 && !trivialPrompt && (codeSeen || ordinarySteps >= 4)) {
          const verdict = evaluateStuckSignal({ consecutiveErrors: errorRun, sameFixRepeats: failures, errorKinds: recentErrorKinds, meaningfulWork: true });
          if (verdict.kind === "error" && shouldSuggestReview("error", { suggestionsThisSession: diagnosticCount, lastSuggestedAt: diagSuggestedAt || undefined, lastReviewAt })) {
            diagnosticCount++; diagSuggestedAt = Date.now();
            add({ key: "topic:diagnostic-error-review", priority: 74, text: "Stuck pattern: repeated errors without progress. Consider one bounded error review (subagent worker: root cause plus a discriminating check) before repeating the fix." });
          }
        }
        return;
      }
      lastFailure = ""; failures = 0;
      errorRun = 0; recentErrorKinds = [];
      // A single cheap fallback after sustained basic-tool work. Specific
      // evidence-backed hints take priority; this never starts an inference,
      // loads a catalog, or becomes a repeating manual reminder.
      if (["bash", "read", "edit", "write", "grep", "find", "ls"].includes(name)) ordinarySteps++;
      if (ordinarySteps >= 8) {
        const available = tools();
        const helpers = ["project_report", "module_report", "symbol_search", "context_slice"]
          .filter(tool => available.has(tool) && !used.has(tool) && !unavailable.has(tool)).slice(0,2);
        if (helpers.length) add({key:"harness:existing-capabilities", tool:helpers[0], priority:20,
          text:`Before adding another inspection script, consider the available ${helpers.join(" or ")} tool if it answers the current question more directly.${skills.length && !skillReviewDisabled && read.size === 0 ? " Use a relevant skill workflow when it saves work; skip unrelated sections." : ""} Keep using ordinary tools when they fit; no extra call is required.`});
      }
      // Shell-heavy stretch with no native inspection tool in the window: one
      // tiny posture nudge, once per session, through the normal hint budget.
      if (name === "bash" && recentTools.filter(t => t === "bash").length >= 6
        && !recentTools.some(t => ["read", "grep", "find", "ls", "data_query", "git_info", "http_request", "sys_probe"].includes(t))) {
        add({ key: "native:bash-heavy", priority: 30, text: "Shell-heavy stretch: which existing tool already does this reliably? One tool_search can name the native owner; keep Bash where it fits." });
      }
      discovery.observe(event);
      if (name === 'bulk_edit' && input.action === 'preview') {
        // The native preview owns the concrete file set behind its apply token.
        // Route those paths, never infer files from a glob or arbitrary prose.
        try {
          const text = event.content?.find((part: any) => part.type === 'text')?.text;
          const result = typeof text === 'string' && text.length < 128000 ? JSON.parse(text) : undefined;
          if (typeof result?.token === 'string' && Array.isArray(result.files)) {
            const files = result.files.slice(0,200).map((entry: any) => entry.path).filter((file: any) => typeof file === 'string' && file.length <= 4096);
            if (bulkFiles.size >= 8) bulkFiles.delete(bulkFiles.keys().next().value!);
            bulkFiles.set(result.token,files);
            for (const file of files) routedSkills('',checkpointPath(file,cwd));
          }
        } catch { /* non-preview or truncated output is not a file receipt */ }
      }
      if (['edit','write'].includes(name)) {
        const changedFile = typeof input.path === 'string' ? checkpointPath(input.path,cwd) : '';
        for (const hint of pending.values()) if (isTopic(hint.key) && hint.sourceFile &&
          (hint.sourceFile !== changedFile || name === 'write')) { pending.delete(hint.key); releaseHint(hint.key); }
        const content = name === 'write' ? input.content : input.newText;
        // Native edits carry independent replacements. Never concatenate them:
        // separate regions need not form a valid expression together. Bound the
        // entire authored batch, not just each snippet, before doing review work.
        const bounded = authoredReviewSnippets(name,input);
        for (const text of bounded) topicHints({file:changedFile, text});
        if (process.env.PI_SMALL_TOOLS!=='off' && process.env.PI_REASONING_AIDS!=='off' && !/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|generated|backups)(?:\/|$)/i.test(changedFile) && bounded.some(text=>/[\uFFFD\u200B\u202A-\u202E\u2066-\u2069]/.test(text)))
          utilityHint('artifact_check','Unusual Unicode appeared in the authored edit. artifact_check({operation:"text",path:...}) can locate replacement characters, invisible controls and normalization differences. These may be intentional; inspect their role before changing them.');
        const signals = authoredReviewSignals(changedFile,bounded);
        // Only a bounded whole-file write can clear cues from earlier snippets.
        // An edit of a different region is not evidence that the old issue disappeared.
        if (name === 'write' && typeof content === 'string' && content.length <= 24000) {
          const remaining = new Set(signals.map(s=>`signal:${s.key}`));
          for (const hint of pending.values()) if (hint.key.startsWith("signal:") && hint.sourceFile === changedFile && !remaining.has(hint.key)) { pending.delete(hint.key); releaseHint(hint.key); }
        }
        for (const signal of signals) signalHint(signal.key,signal.skill,signal.check,changedFile);
        if (/\.svg$/i.test(changedFile) && !/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|generated|backups)(?:\/|$)/i.test(changedFile) && process.env.PI_SMALL_TOOLS!=='off' && process.env.PI_REASONING_AIDS!=='off' && tools().has('artifact_check'))
          add({key:'signal:svg-source-evidence',requiredTool:'artifact_check',priority:80,sourceFile:changedFile,text:'SVG changed: review any automatic source findings and verify actual rendering. Use artifact_check({operation:"svg",path:...}) if a full report is needed or the automatic check was unavailable. A partial snippet is not a complete SVG document.'});
      }
      if (name === 'artifact_check' && input.operation === 'svg' && typeof input.path === 'string' && pending.get('signal:svg-source-evidence')?.sourceFile === checkpointPath(input.path,cwd)) {
        pending.delete('signal:svg-source-evidence'); releaseHint('signal:svg-source-evidence');
      }
      // Discovery/status is not execution: listing agents must not suppress
      // subsequent workflow guidance for the actual delegated work.
      if ((name !== "project_report" || input.view === "workspace") && (name !== "subagent" || !input.action)) used.add(name);
      const file = typeof input.path === "string" ? checkpointPath(input.path, cwd) : "";
      const knownSkillRead = name === "read" && file && skills.some(s => s.file === file);
      const completeRead = (input.offset === undefined || input.offset === 1)
        && event.details?.truncation?.truncated !== true && event.details?.deduplicated !== true
        && (input.limit === undefined || knownSkillRead && returnedWholeSkill(file, event.content));
      if (knownSkillRead && completeRead && !read.has(file)) {
        add({ key: "apply:skill-workflow", text: 'Apply the skill to this task: identify the relevant inputs, next action and observable success check. Use the smallest applicable workflow; skip unrelated sections. Missing evidence stays unknown. Verify the artifact or postcondition before claiming success; reading instructions alone is not completion.' + referencePointer(file) });
        read.add(file); if (read.size > 48) read.delete(read.values().next().value!);
        contextSkill(52);
        // Selected ledger: the snapshot below records the read list plus the
        // reviewTargets reasons, so selected/reason needs no extra entry and
        // repeated reads keep the existing no-duplicate-metadata contract.
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
        if (codeFile.test(file)) codeSeen = true;
        routedSkills("", file);
        remember(skillEvidenceContext({files:[file],tools:[name]}));
        remember(path.basename(file).replace(/[-_.]/g, " "));
        const extension = /\.([a-z0-9]{1,8})$/.exec(file)?.[1]?.toLowerCase() ?? "";
        // New file names can reveal a domain even when the type is unchanged.
        if (extension && !extensions.has(extension) && extensions.size < 12) extensions.add(extension);
        if (name === 'read') {
          const limit = typeof input.limit === 'number' ? input.limit : undefined;
          const returnedChars = typeof event.content === 'string' ? event.content.length : Array.isArray(event.content) ? event.content.reduce((sum: number, part: any) => sum + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0) : 0;
          const broadRead = returnedChars >= 8000 && (limit === undefined || limit >= 4000 || event.details?.truncation?.truncated === true);
          sourceNavigation(file, broadRead);
        }
        contextSkill(52);
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
        add({ key: "navigation", tool: "symbol_search", priority:68, text: 'For identifier discovery, symbol_search ranks symbols across the workspace and builds its own index. A cold index returns a retry hint; inspect that result before continuing. Use it when repeated text searches are guessing; ordinary search stays appropriate for raw text.' });
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
      const effective = (h: Hint) => (h.priority ?? 0) - (topicIgnored(h) >= 2 ? 40 : 0);
      const eligible = [...pending.values()].filter(h => !wasShown(h.key) && (h.expiresAt === undefined || toolStep <= h.expiresAt) && (!h.requiredTool || active.has(h.requiredTool) && !unavailable.has(h.requiredTool)) && (!h.tool || active.has(h.tool) && !used.has(h.tool) && !unavailable.has(h.tool)) && (!h.skill || !read.has(h.skill)) && topicIgnored(h) < 4)
        .sort((a,b)=>effective(b)-effective(a));
      const selected: Hint[] = [];
      for (const hint of eligible) {
        if (isTopic(hint.key) && topicCount + selected.filter(h=>isTopic(h.key)).length >= 2) continue;
        if (remaining > 0) remaining--;
        else if (hint.key.startsWith("signal:") && emergency) emergency = false;
        else continue;
        // Demotion is visible on the delivered hint, like skill fatigue: an
        // ignored advisory topic yields one bounded priority step.
        selected.push(topicIgnored(hint) >= 2 ? { ...hint, priority: effective(hint) } : hint);
        if (selected.length === 2) break;
      }
      return selected;
    },
    commit(hints: Hint[]) {
      for (const h of hints) { if (wasShown(h.key)) continue;
        if (isTopic(h.key)) { topicSeen.set(h.key, requestNumber); topicCount++; if (topicSeen.size > 64) topicSeen.delete(topicSeen.keys().next().value!); }
        const fatigue = fatigueKey(h);
        if (fatigue) {
          topicOffers.set(fatigue, Math.min(99, (topicOffers.get(fatigue) ?? 0) + 1));
          if (topicOffers.size > 64) topicOffers.delete(topicOffers.keys().next().value!);
        }
        else { shown.add(h.key); if (shown.size > LIMIT) shown.delete(shown.values().next().value!); }
        pending.delete(h.key); try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("guidance.delivered",{decision:h.key.startsWith("signal:")?h.key:"skill-or-tool"}); } catch {}
        if (h.discovery) advisoryDiscoveryDelivered.add(h.discovery);
        if (h.key.startsWith("signal:") && runCount - urgentCount >= runAllowance()) urgentCount++;
        runCount++; }
      if (hints.length) try { pi.appendEntry?.(ENTRY, snapshot()); } catch { /* avoid blocking work */ }
    },
  };
}
