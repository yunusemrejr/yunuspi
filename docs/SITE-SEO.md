# Public-site SEO workflow

YunusPi stages `seo_toolkit` and the existing search/read tools when work creates or changes websites, landing/product pages, blogs or documentation. Reading or editing route/layout/content/discovery files can add the workflow after the task starts. SEO does not need to appear in the request. Explicit exclusions and private/internal/local-only apps suppress public SEO routing; mixed applications apply the workflow to their public pages. File evidence with unknown scope first establishes public/private intent. Tool activation always respects the host's allowed tools.

The workflow operates through tools and revision-bound evidence. Skills remain optional guides. Page-derived prose is untrusted source material and never drives tool activation. The model still makes editorial and domain decisions from evidence; a heuristic cannot certify usefulness, real authorship or actual search demand.

## Tool actions

| Action | Input and result |
| --- | --- |
| `plan` | Task, scope, canonical origin and optional page inventory. Returns page-policy exclusions, overlapping intents, content planning and fourteen evidence areas. Private scope returns access/index-exclusion guidance and performs no network work or generation. |
| `inspect` | Intended URL plus exactly one workspace built `.html` path or HTML string; optional actual status/headers/page policy. Checks raw HTML and returns its SHA-256, findings and explicit coverage. Templates are not rendered evidence. Paths use the existing guarded source reader. |
| `audit` | Served public entry URL, optional canonical origin and reviewed page inventory. Fetches raw HTML, robots, XML sitemap/index and llms pointers; checks a bounded same-origin link graph and representative pages. |
| `discovery` | Canonical origin and reviewed canonical public pages. Generates exact sitemap/index, llms.txt, optional RSS and an entity-graph source representation from the same inventory. The native write/project owner publishes these files. Custom robots/access rules are preserved. |
| `report` | `resultId`, offset and view. Pages one of the last four snapshots in the same session without refetching or claiming new revision evidence. New inspect/audit calls collect fresh evidence. |

Audit defaults to twelve pages and accepts one through forty. The entire audit has a 45-second deadline, at most 100 requests including redirect hops, five sitemap files, 2,000 sampled sitemap entries, 1 MiB per HTML/XML file and 256 KiB per robots/llms file. HTML links, schema traversal and findings have limits. Unavailable, truncated and deadline-limited coverage stays visible. The whole site's coverage is never declared complete from this sample.

Fetches reuse the web extension's SSRF, DNS, proxy and domain policies at every redirect. Credentials are not sent. Private/auth/admin/staging/search/query-trap paths and inventory exclusions are not crawled; external links are recorded without fetching. A first public entry can establish an HTTPS/www variant on the same host. Other origin moves require a declared canonical origin. Unknown robots prevents link expansion. Explicit local fixture seams are unavailable in the registered network tool; local builds use inspect or the existing permitted serving workflow.

Compact reports show findings and page summaries in pages; full structured details retain the sample. Generated files are paginated as whole strings rather than cut XML/JSON. Report snapshots are session-bound and bounded; they are cleared at lifecycle boundaries.

## Inventory and truthful generation

Page records contain `url`, optional `purpose`, `intent`, `canonical`, `index`, `title`, `description`, `locale`, actual `published` and substantive-change `lastmod`. Resolve relative paths against the canonical origin. Review actual route/auth/content behavior before setting index policy. Private, duplicate, thin, search/filter/staging purposes, alternate canonicals/origins, query URLs and duplicate URLs are excluded from generated public surfaces.

```json
{
  "action": "discovery",
  "canonicalOrigin": "https://example.com",
  "siteName": "Sensor reference",
  "pages": [
    {"url": "/", "purpose": "public home", "title": "Sensor reference"},
    {"url": "/guides/calibration", "intent": "two-point sensor calibration", "title": "Calibrate a temperature sensor", "description": "Measured references, a worked example and limitations.", "published": "2026-09-01", "lastmod": "2026-10-01"},
    {"url": "/account", "purpose": "private", "index": false}
  ]
}
```

Dates above illustrate supplied source dates. The generator never inserts the execution/build/deployment date. Missing lastmod is omitted; invalid/future dates and modification before publication are rejected. Uniform timestamps still require source-history review. RSS items require actual publication date, title and description. Entity IDs remain tied to canonical URLs; no organization, person, author, rating, price or credential is invented. Embed only the relevant graph facts that match visible page content.

The tool accepts at most 500 inventory records per call. It can split a reviewed batch into sitemap shards and an index with `sitemapBatchSize` (up to 50,000). Large projects must use their actual full route/content source to extend this bounded recipe; a 500-record call does not generate a complete large-site sitemap. Protocol limits are 50,000 entries or 50 MiB uncompressed per sitemap. Index only deliberate canonical, indexable, valid URLs and verify them after publishing. Do not create a small-site index without a useful sharding reason.

## Coverage of the requested work

| Area | Automated evidence and remaining judgment |
| --- | --- |
| Crawl/index/HTTP/identity | Status/noindex, canonical and social/schema URL agreement, robots verdict, redirect chains/temporary redirects/homepage moves, sitemap policy. Inspect route configurations and test deliberate HTTPS/host/slash/case/query variants and removed URLs. Canonical hints and robots are not access control. |
| Sitemap/links/topic graph | XML shape/namespace, canonical URLs, dates, sitemap membership, sampled broken/alternate links, reachability/depth and duplicate titles/descriptions/main text. Orphans outside the route inventory/sample remain unknown; review archives, facets/calendars and intent cannibalization before consolidation. |
| Titles/headings/semantics | Raw title/description, H1/outline/lang/viewport, main/anchors/form labels/table/media/image cues and social metadata. Review stable descriptive URLs, useful text and actual rendered semantics. Title/snippet character heuristics are not ranking rules. |
| Content architecture | Evidence-led questions, FAQ, evergreen guides, glossary, how-to, comparisons, use cases, troubleshooting, documentation, integrations, references and pillar/topic pages. Add a blog/resources area when the domain has meaningful informational demand. Review clear near-top answers, self-contained definitions, examples/steps/tables/citations, originality and useful links. Avoid filler, thin programmatic/doorway pages and unnecessary duplicate intent. |
| Structured data/identity | JSON-LD parse/shape/types, stable IDs, page URL/date/entity cues. Confirm Schema.org semantics and type-specific eligibility, relationships and visible facts. Use WebSite/WebPage and real Organization/Person/Article/Breadcrumb/Product/Software/Dataset/Video/HowTo only when applicable. Review genuine About/contact/authors/official links and accurate source citations. |
| Machine-readable discovery | Generate/check canonical public llms/sitemap/feed/graph representations from one source. Keep private URLs out. llms-full and machine-readable documentation/data endpoints require substantial useful content; they are not created as empty ornaments. |
| Original value/retrieval | Domain-relevant calculators, converters, tools, datasets, measurements, benchmarks, diagrams, downloads/code examples, decision trees/troubleshooting flows; pair tools and explanations. Review extraction-friendly explicit subject/fact/entity/date/source passages without keyword-frequency hacks. |
| Images/media/accessibility | Empty decorative alt remains valid; absent alt/dimensions/responsive source and lazy high-priority image cues, media text and form/table semantics. Review accurate alt/captions, transcripts, hero loading, modern formats, keyboard/focus and responsive mobile behavior in a browser. |
| Performance | Response timing and cache/compression headers are observations. Measure LCP/CLS/INP on real mobile/field workloads; inspect JS, font, asset, server/cache and render-blocking costs before claiming performance. |
| Locales/freshness | Hreflang syntax and sampled reciprocity/canonical/noindex; valid publication/modification and sitemap dates, supplied source parity. Review genuine translations, per-language identities and justified x-default; prove substantive changes from source history. |
| Security | Excluded sitemap/llms URLs, rogue canonical/origin/redirect cues, hidden spam-word links and encoded eval cues. Source cues are review prompts. Inspect unknown scripts, server/.htaccess/nginx/middleware/routing rules and hacked ghost URLs; do not remove legitimate content automatically. |
| Delivery | Current raw audit evidence is distinct from content assessment, browser/mobile interaction, performance and production verification. Later mutations retire old evidence. Post-deployment checks use the actual public serving path and CDN/cache behavior. |

The `seo-raw` workflow stage consumes native inspect/audit receipts from the current revision. Errors fail the stage; missing/truncated/failed evidence blocks it. An audit's declared representative sample may support that bounded raw check. A plan, generated files, report pagination or stale result cannot certify it. `seo-content` remains a separate concrete editorial/factual assessment; pixels, real interaction and performance remain separate evidence. Public-site Git/SSH deployment adds `seo-live` after the actual remote promotion. Native live credit requires a fresh audit on the explicitly declared non-loopback canonical origin after that promotion; choose the actual authorized production origin. Other deployment commands receive the same production-audit reminder through the existing deploy hook.

Never stuff keywords, hide SEO text, cloak, spam links/schema, manufacture reviews/FAQs/authors/credentials/citations/location value or fake freshness. Do not optimize private software for public search. Submission, discovery, crawling, indexing, rankings and AI citations are separate states, and none is guaranteed by passing this tool.

## Primary references

- [Google sitemap construction and meaningful lastmod](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Sitemaps protocol and limits](https://www.sitemaps.org/protocol.html)
- [Robots.txt purpose and limits](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- [Structured-data quality and visible content](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Google generative search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)

The requested llms.txt surface is available for consumers that use it. Google does not require or use it as a special ranking/AI-feature signal. Check current type-specific structured-data documentation before claiming rich-result support.
