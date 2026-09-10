// Structured source checking and machine-readable research artifacts.
import { createHash } from "node:crypto";
import { generateId, getResult, storeResult } from "./storage.ts";
import type { SearchResult } from "./perplexity.ts";
import type { ExtractedContent } from "./extract.ts";

export type SourceQuality = "official_docs" | "vendor_docs" | "repo_issue" | "blog" | "forum" | "news" | "unknown";
export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";
export type RecencyFilter = "day" | "week" | "month" | "year";

export interface ResearchSource {
	rank: number;
	url: string;
	title: string;
	snippet?: string;
	fetch_timestamp?: number;
	content_hash?: string;
	quality: SourceQuality;
	fetched?: boolean;
	fetch_error?: string;
}

export interface ResearchPassage {
	passage_id: string;
	source_url: string;
	source_rank: number;
	text: string;
	extraction_span?: { start: number; end: number };
	content_hash?: string;
}

export interface ClaimAssessment {
	claim: string;
	status: ClaimStatus;
	supporting_passages: string[];
	contradicting_passages: string[];
	candidate_passages?: string[];
	rationale: string;
	confidence: number;
}

export interface ResearchArtifact {
	id: string;
	type: "research";
	timestamp: number;
	query: string;
	sources: ResearchSource[];
	passages: ResearchPassage[];
	claims?: ClaimAssessment[];
	provider?: string;
	summary?: string;
	content_hash?: string;
	filters?: { recency?: RecencyFilter; domain_include?: string[]; domain_exclude?: string[] };
	errors?: Array<{ query: string; error: string }>;
	limitations?: string[];
}

export const SOURCE_CHECK_LIMITS = Object.freeze({ sources: 20, query: 8192, title: 240, url: 2048, snippet: 800, summary: 8192, pageScan: 200_000 });

export interface ResearchSearchRequest {
	query: string;
	numResults: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
}
export interface ResearchSearchResult { url: string; title: string; snippet: string; rank: number }
export interface ResearchSearchResponse { provider: string; results: ResearchSearchResult[]; summary?: string }
export interface ResearchProvider { name: string; search(req: ResearchSearchRequest): Promise<ResearchSearchResponse> }

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blogs?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(\/|$)/i;

export function classifySource(url: string): SourceQuality {
	let host = "";
	let path = "";
	try {
		const parsed = new URL(url);
		host = parsed.hostname;
		path = parsed.pathname;
	} catch {
		return "unknown";
	}
	if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
	if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
	if (VENDOR_DOCS_PATHS.test(path)) return "vendor_docs";
	if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return "news";
	if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return "forum";
	if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return "blog";
	return "unknown";
}

export function hashContent(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Span { text: string; start: number; end: number }

function tokenize(value: string): string[] {
	return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))];
}

function extractRelevantSpans(content: string, hint: string): Span[] {
	const sentences: Span[] = [];
	const sample = content.slice(0, SOURCE_CHECK_LIMITS.pageScan);
	const sentencePattern = /[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g;
	for (const match of sample.matchAll(sentencePattern)) {
		// The final sampled sentence may have lost a qualification. Omit it
		// whole instead of returning a clipped quotation as exact evidence.
		if (sample.length < content.length && (match.index ?? 0) + match[0].length === sample.length) continue;
		const raw = match[0];
		const text = raw.trim();
		if (text.length > 0 && text.length <= 400) {
			const start = (match.index ?? 0) + raw.indexOf(text);
			sentences.push({ text, start, end: start + text.length });
		}
	}
	const terms = tokenize(hint);
	if (terms.length === 0) return [];
	return sentences
		.map((sentence, index) => ({ sentence, index, score: terms.filter((term) => sentence.text.toLowerCase().includes(term)).length }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 3)
		.map(({ sentence }) => sentence);
}

function passageId(sourceRank: number, index: number): string {
	return `p-${sourceRank}-${index}`;
}

export function buildPassages(sources: ResearchSource[], fetched: ExtractedContent[] = [], hint = ""): ResearchPassage[] {
	const passages: ResearchPassage[] = [];
	const fetchedByUrl = new Map(fetched.map((item) => [item.url, item]));
	for (const source of sources.slice(0, SOURCE_CHECK_LIMITS.sources)) {
		if (source.snippet && source.snippet.length <= SOURCE_CHECK_LIMITS.snippet) {
			passages.push({
				passage_id: passageId(source.rank, 0),
				source_url: source.url,
				source_rank: source.rank,
				text: source.snippet,
				content_hash: hashContent(source.snippet),
			});
		}
		const page = fetchedByUrl.get(source.url);
		if (page && !page.error && page.content) {
			const passageHint = hint.trim() || source.snippet?.trim() || "";
			for (const [index, span] of extractRelevantSpans(page.content, passageHint).entries()) {
				passages.push({
					passage_id: passageId(source.rank, index + 1),
					source_url: source.url,
					source_rank: source.rank,
					text: span.text,
					extraction_span: { start: span.start, end: span.end },
					content_hash: hashContent(span.text),
				});
			}
		}
	}
	return passages;
}

function containsPhrase(value: string, phrase: string): boolean {
	const escaped = phrase.trim().toLowerCase().split(/\s+/).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(value);
}

export function assessClaim(claim: string, passages: ResearchPassage[]): ClaimAssessment {
	const terms = tokenize(claim);
	const candidates: string[] = [];
	for (const passage of passages) {
		const lower = passage.text.toLowerCase();
		const overlap = terms.filter((term) => containsPhrase(lower, term)).length;
		if (terms.length && overlap >= Math.min(terms.length, Math.max(2, Math.ceil(terms.length / 4)))) candidates.push(passage.passage_id);
	}
	// Generic words such as "correct" in another clause cannot verify a claim,
	// its negation, quantities or qualifiers. This deterministic owner retrieves
	// evidence; the caller must interpret the exact passages.
	return { claim, status: candidates.length ? "unclear" : "missing-evidence", supporting_passages: [], contradicting_passages: [], candidate_passages: candidates,
		rationale: candidates.length ? "Candidate passages share claim terms. Lexical matching does not establish support or contradiction; inspect the passages and their qualifications." : "No passages matched the claim's searchable terms; evidence may exist outside the retrieved sample.", confidence: 0 };
}

interface RankedSearchResult extends SearchResult {
	rank?: number;
}

export interface BuildArtifactInput {
	query: string;
	provider?: string;
	summary?: string;
	results: RankedSearchResult[];
	fetched?: ExtractedContent[];
	recency?: RecencyFilter;
	domainFilter?: string[];
}

export function buildResearchArtifact(input: BuildArtifactInput): ResearchArtifact {
	if (input.query.length > SOURCE_CHECK_LIMITS.query) throw new Error(`Source-check claim/query exceeds ${SOURCE_CHECK_LIMITS.query} characters; check a smaller complete assertion.`);
	const filters = (input.domainFilter ?? []).slice(0, 100).filter(domain => domain.length <= 253);
	const fetchedByUrl = new Map((input.fetched ?? []).map((page) => [page.url, page]));
	const sources: ResearchSource[] = [];
	const seen = new Set<string>();
	const limitations: string[] = [];
	if (input.results.length > SOURCE_CHECK_LIMITS.sources) limitations.push(`Only the first ${SOURCE_CHECK_LIMITS.sources} sources were considered.`);
	let omittedSnippets = 0, omittedUrls = 0, sampledPages = 0;
	for (const [index, result] of input.results.slice(0, SOURCE_CHECK_LIMITS.sources).entries()) {
		if (seen.has(result.url)) continue;
		if (result.url.length > SOURCE_CHECK_LIMITS.url) { omittedUrls++; continue; }
		seen.add(result.url);
		const page = fetchedByUrl.get(result.url);
		const fetched = Boolean(page && !page.error);
		if (page?.content && page.content.length > SOURCE_CHECK_LIMITS.pageScan) sampledPages++;
		const snippet = result.snippet && result.snippet.length <= SOURCE_CHECK_LIMITS.snippet ? result.snippet : undefined;
		if (result.snippet && !snippet) omittedSnippets++;
		sources.push({
			rank: result.rank ?? index + 1,
			url: result.url,
			title: result.title.slice(0, SOURCE_CHECK_LIMITS.title),
			...(snippet ? { snippet } : {}),
			quality: classifySource(result.url),
			fetched,
			...(page ? { fetch_timestamp: Date.now() } : {}),
			...(page && !page.error ? { content_hash: hashContent(page.content) } : {}),
			...(page?.error ? { fetch_error: page.error.slice(0, 1000) } : {}),
		});
	}
	const passages = buildPassages(sources, input.fetched, input.query);
	if (omittedSnippets) limitations.push(`${omittedSnippets} oversized snippets omitted whole to preserve qualifications.`);
	if (omittedUrls) limitations.push(`${omittedUrls} oversized source URLs omitted.`);
	if (sampledPages) limitations.push(`${sampledPages} pages sampled through their first ${SOURCE_CHECK_LIMITS.pageScan} characters; incomplete boundary sentences omitted.`);
	if (input.summary && input.summary.length > SOURCE_CHECK_LIMITS.summary) limitations.push("Oversized generated search summary omitted; inspect exact source passages.");
	const domainInclude = filters.filter((domain) => !domain.startsWith("-"));
	const domainExclude = filters.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1));
	return {
		id: generateId(),
		type: "research",
		timestamp: Date.now(),
		query: input.query,
		sources,
		passages,
		...(input.provider !== undefined ? { provider: input.provider } : {}),
		...(input.summary !== undefined && input.summary.length <= SOURCE_CHECK_LIMITS.summary ? { summary: input.summary } : {}),
		...(limitations.length ? { limitations } : {}),
		...(passages.length > 0 ? { content_hash: hashContent(passages.map((passage) => passage.text).join("\n")) } : {}),
		filters: {
			...(input.recency !== undefined ? { recency: input.recency } : {}),
			domain_include: domainInclude,
			domain_exclude: domainExclude,
		},
	};
}

export function withClaimAssessment(artifact: ResearchArtifact, claims: string[]): ResearchArtifact {
	return { ...artifact, claims: claims.map((claim) => assessClaim(claim, artifact.passages)) };
}

export function storeResearchArtifact(artifact: ResearchArtifact): void {
	if (!artifact.id) throw new Error("Research artifact id must not be empty");
	storeResult(artifact.id, { id: artifact.id, type: "research", timestamp: artifact.timestamp, artifact });
}

export function getResearchArtifact(id: string): ResearchArtifact | null {
	const data = getResult(id);
	if (!data || data.type !== "research" || !data.artifact || typeof data.artifact !== "object") return null;
	return data.artifact as ResearchArtifact;
}
