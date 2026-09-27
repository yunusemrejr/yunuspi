---
name: search-discoverability
description: "Implement technical SEO, crawlability and evidence-based visibility in search and AI answers."
---

# Search Discoverability Engineering

Use for indexable websites, metadata audits and content discovery. Ranking and chatbot citations are outcomes to measure, never guarantees. This skill complements page design; it does not prescribe a marketing campaign.

## Working method

- Establish canonical host, locales, public/private routes and the intended audience.
- Inspect HTTP status, rendered content, crawl controls and links before tweaking keywords. `web_probe` with `seo:true` measures a public URL in one call: title and description length, canonical, robots meta and X-Robots-Tag, hreflang, Open Graph, JSON-LD validity and types, h1 and heading outline, image alt, and the robots.txt verdict with sitemaps. Its findings are checks to fix, not ranking predictions. For a local build, read the built HTML and robots.txt directly.
- Make titles, headings, descriptions and structured data describe the actual page.
- Validate representative pages and measure indexed coverage and useful visits over time.

Read [patterns and examples](references/patterns.md) for the relevant implementation mode; do not load unrelated modes. Inspect the actual runtime, project conventions and constraints before choosing syntax, dependencies or deployment steps. User instructions take precedence; this skill adds no authority to change external systems.

## Evidence and completion

Use a small representative case and the relevant failure case to check the result. Report what was executed, what remains unverified, and any material compatibility assumption. Do not invent measured outcomes or treat reading this guide as verification.
