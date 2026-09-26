/**
 * Expert domain inference — deterministic reading of which excellence
 * domain(s) a request belongs to. Pure module: no I/O, no inference.
 *
 * WHY: "technically correct" is not "excellent", and excellence criteria
 * differ by domain. The Expert Director needs to know whether a vague
 * prompt is web design, backend work, an algorithm, prose, or research
 * before it can load the right doctrine, critics and stop conditions.
 * This reading reuses the harness's existing lexical substrate
 * (prompt focus, skill terms, file evidence, guidance topics) instead of
 * adding another classifier. Model prompt-analysis flags can confirm a
 * domain but never invent one the deterministic signals do not support.
 */
import { promptRequestFocus } from "./prompt-interpretation.ts";
import { matchGuidanceTopics } from "./guidance-topics.ts";
import { skillTerms, skillEvidenceContext } from "./skill-relevance.ts";

export type ExpertDomainId =
  | "web-design" | "visual-art" | "svg-iconography" | "motion-design"
  | "video" | "audio" | "frontend" | "backend" | "api-design" | "database"
  | "algorithms" | "distributed-systems" | "security" | "ml" | "writing" | "research";

export const EXPERT_DOMAIN_IDS: readonly ExpertDomainId[] = [
  "web-design", "visual-art", "svg-iconography", "motion-design",
  "video", "audio", "frontend", "backend", "api-design", "database",
  "algorithms", "distributed-systems", "security", "ml", "writing", "research",
];

export const EXPERT_DOMAIN_LABELS: Record<ExpertDomainId, string> = {
  "web-design": "Web/UI design", "visual-art": "Visual art", "svg-iconography": "SVG/iconography",
  "motion-design": "Motion design", video: "Video", audio: "Audio", frontend: "Frontend engineering",
  backend: "Backend engineering", "api-design": "API design", database: "Database design",
  algorithms: "Algorithms", "distributed-systems": "Distributed systems", security: "Security",
  ml: "ML/AI", writing: "Technical writing", research: "Research",
};

export type ExpertTaskType = "create" | "transform" | "fix" | "review" | "research" | "operate";

/** Discriminating lexical cues per domain. Terms match skillTerms() output
 * (lowercased, stop-filtered); phrases match raw focus text. File cues match
 * caller-supplied evidence paths. Keep cues naming-level: a cue that fires
 * on ordinary prose in every domain is worse than no cue. */
interface DomainCues {
  id: ExpertDomainId;
  terms: readonly string[];
  phrases: RegExp;
  files: RegExp;
  /** Guidance-topic domains that corroborate this expert domain. */
  topics: readonly string[];
}

const DOMAIN_CUES: readonly DomainCues[] = [
  { id: "web-design", topics: ["css", "accessibility"],
    terms: ["typography", "typeface", "palette", "layout", "hero", "landing", "mockup", "wireframe", "figma", "branding", "rebrand", "aesthetic", "webdesign"],
    phrases: /\b(?:landing page|web design|design system|color palette|font pairing|hero section|user interface|responsive design|redesign|restyle|look and feel)\b/i,
    files: /\.(?:html?|css|scss|sass|less|vue|svelte|tsx|jsx)$/i },
  { id: "visual-art", topics: ["graphics", "visualization"],
    terms: ["illustration", "artwork", "poster", "wallpaper", "pixelart", "pixel-art", "conceptart", "render", "painting", "drawing", "artwork", "mural"],
    phrases: /\b(?:concept art|pixel art|digital painting|illustration|cover art|wallpaper|poster design|brand mark|visual identity)\b/i,
    files: /\.(?:png|jpe?g|webp|avif|gif|psd|kra|aseprite)$/i },
  { id: "svg-iconography", topics: ["graphics"],
    terms: ["viewbox", "view-box", "viewBox", "icon", "icons", "iconography", "glyph", "pictogram", "stroke", "path", "bezier"],
    phrases: /\b(?:svg|icon set|iconography|vector icon|stroke icon|logo mark)\b/i,
    files: /\.svg$/i },
  { id: "motion-design", topics: ["animation"],
    terms: ["easing", "keyframe", "keyframes", "tween", "spring", "stagger", "choreography", "microinteraction", "micro-interaction", "lottie", "rivescript"],
    phrases: /\b(?:motion design|page transition|micro-interaction|scroll animation|spring physics|animation curve|entrance animation)\b/i,
    files: /\.(?:json|lottie|riv)$/i },
  { id: "video", topics: ["animation"],
    terms: ["timeline", "caption", "captions", "subtitle", "subtitles", "narration", "voiceover", "b-roll", "transition", "colorgrade", "storyboard", "render"],
    phrases: /\b(?:video|timeline edit|caption timing|voice-over|storyboard|color grade|frame rate|aspect ratio 16:9|reel|trailer)\b/i,
    files: /\.(?:mp4|mov|webm|mkv|m4v|srt|vtt|ass|fcpxml|prproj|blend)$/i },
  { id: "audio", topics: [],
    terms: ["waveform", "spectrogram", "mixing", "mastering", "reverb", "compressor", "equalizer", "sample", "sampler", "synthesizer", "podcast", "jingle"],
    phrases: /\b(?:audio mix|sound design|podcast edit|background music|voice recording|noise reduction|audio level|stereo image)\b/i,
    files: /\.(?:wav|mp3|flac|ogg|opus|m4a|aiff|mid|midi|als|flp|logicx)$/i },
  { id: "frontend", topics: ["browser"],
    terms: ["component", "components", "hydration", "router", "routing", "state", "hooks", "props", "bundle", "vite", "webpack", "react", "svelte", "vuejs", "angular", "solidjs", "hono"],
    phrases: /\b(?:front-?end|react component|state management|client-side routing|bundle size|hydration|form validation|data fetching)\b/i,
    files: /\.(?:tsx|jsx|vue|svelte|astro)$/i },
  { id: "backend", topics: ["systems"],
    terms: ["endpoint", "middleware", "orm", "migration", "transaction", "queue", "worker", "cron", "webhook", "session", "server", "serving", "throughput"],
    phrases: /\b(?:back-?end|rest endpoint|database transaction|background job|message queue|rate limit|connection pool|request handler|server-side)\b/i,
    files: /(?:^|\/)(?:server|api|backend|handlers?|controllers?|middleware|migrations?|workers?|jobs?)\/[^/]+$/i },
  { id: "api-design", topics: ["tooling"],
    terms: ["openapi", "swagger", "graphql", "webhook", "versioning", "pagination", "idempotency", "rest", "endpoint", "sdk", "contract"],
    phrases: /\b(?:openapi|api contract|api design|rest api|graphql schema|api versioning|endpoint design|webhook contract|sdk design)\b/i,
    files: /(?:^|\/)(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$|\.graphql$/i },
  { id: "database", topics: ["data"],
    terms: ["postgres", "mysql", "sqlite", "index", "indexes", "schema", "normalization", "denormalization", "sharding", "replication", "vacuum", "query", "orm"],
    phrases: /\b(?:database schema|query plan|sql query|table design|index design|data model|foreign key|normalization|query performance)\b/i,
    files: /\.(?:sql|prisma)$|(?:^|\/)migrations?\/[^/]+$/i },
  { id: "algorithms", topics: ["numerical", "physics"],
    terms: ["complexity", "big-o", "recurrence", "invariant", "correctness", "adversarial", "sort", "graph", "shortest", "dynamic", "greedy", "memoization", "benchmark", "profiling"],
    phrases: /\b(?:time complexity|space complexity|correctness proof|algorithm design|data structure|big-o|edge case|worst case|numerical stability)\b/i,
    files: /(?:^|\/)(?:algo|ds|lib|core)\/[^/]*\.(?:py|[cm]?[jt]s|rs|go|cpp|c|java)$/i },
  { id: "distributed-systems", topics: ["systems"],
    terms: ["consensus", "raft", "paxos", "replication", "partition", "sharding", "leader", "follower", "quorum", "gossip", "backpressure", "failover", "zookeeper", "kafka"],
    phrases: /\b(?:distributed|consistency model|eventual consistency|leader election|split-brain|message ordering|exactly-once|at-least-once|circuit breaker|service mesh)\b/i,
    files: /(?:^|\/)(?:proto|services?|cluster|consensus|replication)\/[^/]+$|\.proto$/i },
  { id: "security", topics: ["systems"],
    terms: ["vulnerability", "xss", "csrf", "injection", "owasp", "threat", "hardening", "encryption", "authentication", "authorization", "oauth", "jwt", "secrets", "audit"],
    phrases: /\b(?:security audit|threat model|penetration test|sql injection|xss|cross-site|auth flow|permission model|secret handling|security review)\b/i,
    files: /(?:^|\/)(?:auth|security|policy|policies)\/[^/]+$/i },
  { id: "ml", topics: ["ml", "statistics", "numerical"],
    terms: ["dataset", "training", "inference", "embedding", "embeddings", "transformer", "diffusion", "finetune", "checkpoint", "tokenizer", "pytorch", "tensorflow", "jax", "sklearn", "huggingface", "llm", "rag", "split", "splits", "leakage", "calibration", "ranking", "baseline", "overfitting", "metric", "metrics"],
    phrases: /\b(?:machine learning|neural network|training loop|evaluation metric|train model|fine-tun|inference latency|model serving|data pipeline|feature engineering|held-out|test set|data leakage)\b/i,
    files: /\.(?:ipynb|pt|pth|ckpt|safetensors|onnx)$|(?:^|\/)(?:models?|training|datasets?|notebooks?)\/[^/]+$/i },
  { id: "writing", topics: ["documentation", "content"],
    terms: ["prose", "draft", "manuscript", "copywriting", "blogpost", "readme", "changelog", "documentation", "narrative", "essay", "article", "paragraph", "headline"],
    phrases: /\b(?:blog post|write up|documentation|user guide|readme|migration guide|release notes|editorial|copy deck|tone of voice)\b/i,
    files: /\.(?:md|mdx|rst|txt|adoc)$/i },
  { id: "research", topics: ["statistics", "data", "visualization"],
    terms: ["literature", "citation", "citations", "hypothesis", "methodology", "survey", "benchmark", "baseline", "ablation", "peer", "arxiv", "paper", "study", "experiment"],
    phrases: /\b(?:literature review|research paper|prior work|state of the art|experimental design|survey the|compare approaches|evidence for)\b/i,
    files: /\.(?:pdf|bib|tex)$|(?:^|\/)(?:papers?|research|studies|experiments?)\/[^/]+$/i },
];

export interface ExpertDomainSignal {
  domain: ExpertDomainId;
  /** 0..1 calibrated by signal count and kind, not by prose volume. */
  confidence: number;
  /** Short human-readable signal receipts, e.g. 'phrase:"icon set"'. */
  signals: string[];
}

const FOCUS_LIMIT = 32_000;
const MAX_DOMAINS = 3;

/** Task-type cues. Precedence is fix > review > research > operate >
 * create > transform; ambiguous work defaults to transform (improve what
 * exists) unless new-work cues say otherwise. */
const TASK_CUES: ReadonlyArray<{ type: ExpertTaskType; test: RegExp }> = [
  { type: "fix", test: /\b(?:fix|debug|repair|broken|crash|regression|bug|failing|failure|not working|doesn'?t work|error|stack trace)\b/i },
  { type: "review", test: /\b(?:review|audit|assess|inspect|critique|evaluate|look over|second opinion|code review|quality check)\b/i },
  { type: "research", test: /\b(?:research|investigate|survey|compare|explore options|spike|feasibility|literature|benchmark|state of the art)\b/i },
  { type: "operate", test: /\b(?:deploy|release|publish|ship|roll ?out|migrate to prod|monitor|on-call|incident|postmortem|backup|restore)\b/i },
  { type: "create", test: /\b(?:create|build|make|design|redesign|generate|craft|produce|develop|implement|scaffold|from scratch|new|launch|write|compose|author|cut|record|shoot|film|prove|derive|solve|compute)\b/i },
  { type: "transform", test: /\b(?:refactor|restyle|polish|improve|refresh|tweak|adjust|clean ?up|tidy|rework|revamp|overhaul|migrate|upgrade|modernize|rewrite)\b/i },
];

/** Design nouns that must not read as failure reports: "error responses"
 * in an API brief and "failure paths" in a test plan are work products. */
const DESIGN_NOUNS = /\b(?:error|failure) (?:responses?|models?|handling|messages?|codes?|contracts?|bodies|body|semantics|paths?|modes?)\b/gi;

export function detectTaskType(prompt: string): ExpertTaskType {
  const text = promptRequestFocus(String(prompt ?? "")).slice(0, FOCUS_LIMIT).replace(DESIGN_NOUNS, " ");
  // Earliest cue wins, so "prove X correct, then benchmark it" reads as the
  // construction it leads with rather than its trailing analysis. Ties keep
  // list order: fix > review > research > operate > create > transform.
  let best: { type: ExpertTaskType; at: number; order: number } | undefined;
  TASK_CUES.forEach((cue, order) => {
    cue.test.lastIndex = 0;
    const match = cue.test.exec(text);
    if (!match) return;
    if (!best || match.index < best.at) best = { type: cue.type, at: match.index, order };
  });
  return best?.type ?? "transform";
}

export interface ExpertDetectionInput {
  prompt: string;
  /** Caller-supplied evidence paths (touched files, listed scope). Never read here. */
  files?: readonly string[];
  /** Established tool/file evidence text, e.g. skillEvidenceContext(). */
  evidenceText?: string;
  /** Advisory model flags that may confirm, never invent, a domain. */
  analysis?: {
    source?: string; openEnded?: boolean; visualDesign?: boolean;
    expectedSkills?: readonly string[]; suggestedCapabilities?: readonly string[];
  };
}

export interface ExpertDetection {
  domains: ExpertDomainSignal[];
  taskType: ExpertTaskType;
  openEnded: boolean;
}

/** Single source for the "is this request open-ended" judgment, shared by
 * the brief injector and the tool path so both agree on exploration. */
const DECIDED_DIRECTION = /#[0-9a-f]{3,8}\b|\b(?:figma|wireframe|mockup attached|design file|brand guide(?:lines)?|spec(?:ification)? attached|follow this spec)\b|\b(?:use|keep|follow|match)\s+(?:our|the existing|the current)\s+(?:design|brand|style|theme|tokens|spec|architecture)/i;

export function detectOpenEnded(prompt: string, analysis?: ExpertDetectionInput["analysis"]): boolean {
  if (analysis?.source === "model" && analysis.openEnded !== undefined) return analysis.openEnded;
  const text = promptRequestFocus(String(prompt ?? "")).slice(0, FOCUS_LIMIT);
  if (DECIDED_DIRECTION.test(text)) return false;
  return /\b(?:create|build|make|design|redesign|brainstorm|propose|suggest|explore|best|better|improve|revamp|overhaul|rethink|world-class|stunning|premium|elegant|beautiful|impressive|cut|write|compose|survey|compare)\b/i.test(text)
    && !/\b(?:exactly|precisely|specifically|step-by-step|as specified|per spec)\b/i.test(text);
}

export function detectExpertDomains(input: ExpertDetectionInput): ExpertDetection {
  const prompt = String(input?.prompt ?? "");
  const focus = promptRequestFocus(prompt).slice(0, FOCUS_LIMIT);
  const terms = new Set(skillTerms(focus, 128));
  const evidence = skillEvidenceContext({ files: (input.files ?? []).filter((f) => typeof f === "string").slice(-32) });
  const evidenceTerms = new Set(skillTerms(`${evidence} ${input.evidenceText ?? ""}`, 64));
  const files = (input.files ?? []).filter((f) => typeof f === "string").join("\n").slice(0, 8000);
  const topicDomains = new Set(matchGuidanceTopics({ prompt: focus }).map((t) => t.domain));
  const modelSkills = new Set([...(input.analysis?.expectedSkills ?? []), ...(input.analysis?.suggestedCapabilities ?? [])]
    .flatMap((s) => String(s).toLowerCase().split(/[^a-z0-9+#]+/)).filter(Boolean));
  const modelConfirms = input.analysis?.source === "model";

  const scored: ExpertDomainSignal[] = [];
  for (const cues of DOMAIN_CUES) {
    const signals: string[] = [];
    let score = 0;
    const termHits = cues.terms.filter((t) => terms.has(t.toLowerCase()) || evidenceTerms.has(t.toLowerCase()));
    for (const hit of termHits.slice(0, 4)) signals.push(`term:${hit}`);
    score += Math.min(4, termHits.length);
    const phrase = cues.phrases.exec(focus);
    if (phrase) { signals.push(`phrase:${JSON.stringify(phrase[0].slice(0, 40))}`); score += 3; }
    if (files && cues.files.test(files)) { signals.push("files"); score += 2; }
    const topicHit = cues.topics.find((d) => topicDomains.has(d));
    if (topicHit) { signals.push(`topic:${topicHit}`); score += 1; }
    if (modelConfirms && cues.terms.some((t) => modelSkills.has(t.toLowerCase()))) { signals.push("analysis"); score += 1; }
    if (input.analysis?.visualDesign === true && (cues.id === "web-design" || cues.id === "visual-art")) {
      signals.push("analysis:visual"); score += 1;
    }
    // A domain needs either a phrase, two distinct term signals, or a
    // term plus corroborating file/topic/analysis evidence. Single weak
    // terms never qualify on their own.
    const qualifies = phrase != null || termHits.length >= 2 || (termHits.length >= 1 && signals.length >= 2);
    if (!qualifies || !signals.length) continue;
    scored.push({ domain: cues.id, confidence: Math.min(1, Math.round((score / 7) * 100) / 100), signals: signals.slice(0, 6) });
  }
  scored.sort((a, b) => b.confidence - a.confidence || a.domain.localeCompare(b.domain));
  return { domains: scored.slice(0, MAX_DOMAINS), taskType: detectTaskType(prompt), openEnded: detectOpenEnded(prompt, input.analysis) };
}

/** Group caller-supplied paths into representative project families so a
 * brief can point at whole-project scope instead of one opened file.
 * Pure path-shape grouping: directory role first, extension family second. */
export function representativeFamilies(files: readonly string[], limit = 8): Array<{ family: string; count: number; sample: string[] }> {
  const groups = new Map<string, string[]>();
  for (const raw of files) {
    if (typeof raw !== "string" || !raw || raw.length > 512) continue;
    const file = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (file.includes("..") || /(?:^|\/)(?:node_modules|dist|build|coverage|vendor|\.git)(?:\/|$)/.test(file)) continue;
    const segments = file.split("/").filter(Boolean);
    const role = segments.length > 1 ? roleOf(segments[0].toLowerCase()) : undefined;
    const ext = /\.([a-z0-9]{1,8})$/.exec(segments[segments.length - 1])?.[1] ?? "other";
    const key = role ?? extFamily(ext);
    const list = groups.get(key) ?? [];
    if (list.length < 3 && !list.includes(file)) list.push(file);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([family, sample]) => ({ family, count: sample.length, sample }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
    .slice(0, Math.max(1, limit));
}

function roleOf(top: string): string | undefined {
  if (/^(pages?|app|routes?|views?|screens?)$/.test(top)) return "pages/routes";
  if (/^(components?|ui|widgets?)$/.test(top)) return "components";
  if (/^(api|server|backend|handlers?|controllers?|routes?)$/.test(top)) return "api/server";
  if (/^(lib|core|utils?|helpers?|shared|common)$/.test(top)) return "core libraries";
  if (/^(styles?|css|assets?|public|static|images?|fonts?)$/.test(top)) return "assets/styles";
  if (/^(tests?|test|spec|e2e|fixtures?)$/.test(top)) return "tests";
  if (/^(docs?|documentation|content|blog|posts?)$/.test(top)) return "docs/content";
  if (/^(migrations?|migrate|db|database|sql|prisma|schema)$/.test(top)) return "database";
  if (/^(scripts?|tools?|bin|ops|infra|deploy|docker|k8s|\.github)$/.test(top)) return "scripts/ops";
  if (/^(models?|training|datasets?|notebooks?|experiments?|ml)$/.test(top)) return "ml/data";
  if (/^(media|video|audio|renders?)$/.test(top)) return "media";
  return undefined;
}

function extFamily(ext: string): string {
  if (/^(html?|css|scss|sass|less|vue|svelte|tsx|jsx|astro)$/.test(ext)) return "frontend sources";
  if (/^([cm]?[jt]s|mts|cts)$/.test(ext)) return "scripts/sources";
  if (/^(py|rb|php|go|rs|java|kt|cs|c|cc|cpp|h|hpp|swift)$/.test(ext)) return "program sources";
  if (/^(json|ya?ml|toml|ini|env)$/.test(ext)) return "config/data";
  if (/^(md|mdx|rst|txt|adoc|pdf)$/.test(ext)) return "docs/content";
  if (/^(png|jpe?g|gif|webp|avif|svg|ico|psd|mp4|mov|wav|mp3|flac)$/.test(ext)) return "media";
  if (/^(sql|prisma|graphql|proto)$/.test(ext)) return "schemas";
  return "other files";
}
