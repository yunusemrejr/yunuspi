---
name: growth-finance
description: "Build and check financial models (unit economics, runway, DCF), analyze filings and reconciliations, measure portfolio risk and backtests, run marketing experiments, improve SEO and search discoverability, and govern authorized community posting; use for CAC, LTV, valuation, 10-K, VaR, drawdown, SEO, sitemaps and forum promotion."
---

## Financial models
- Keep inputs in one place with unit, period, source and date; calculations reference inputs only; outputs are formulas.
- CAC uses the same period and channel. LTV states its margin basis and horizon; a 1/churn lifetime holds only for steady churn.
- Runway is recomputed month by month with the forecast, not cash divided by one burn figure.
- Balance sheets balance every period; a nonzero check row is a bug.
- DCF: terminal growth below WACC and long-run nominal GDP growth; show the terminal share of value; equity = enterprise value minus net debt.
- Give base, downside and upside cases plus a two-input sensitivity table; check monthly vs annual rates and percent vs points.

## Filings and statements
- Identify the legal entity, reporting basis, fiscal year end, currency, scale and restatement status; keep accession IDs and dates.
- Match start and end dates, not fiscal-year labels. Derive a stand-alone quarter only by subtracting compatible cumulative figures; never subtract a balance-sheet instant from a flow.
- Never replace missing values with zero or silently mix original and amended filings.
- Reconcile the balance sheet and the cash bridge; investigate nonzero residuals.
- Show reported and adjusted figures side by side with every adjustment; state the free-cash-flow and net-debt definitions.
- Growth on a near-zero denominator: show the absolute change. A margin move during expansion does not prove cause.

## Portfolio risk
- Fix the valuation date, currencies, return convention (simple or log), benchmark and horizon; date prices and FX rates.
- Check covariance matrices for symmetry and positive semidefiniteness; pairwise deletion can break them.
- VaR is a loss quantile, not the worst loss; state the sign convention and estimator.
- Pair statistics with scenarios (rates, FX, spreads, equities, liquidity) and drawdown from the running peak.
- Backtests: test out of sample, never tune on test data, count repeated strategy searches.
- Bond quotes are per 100 par; state clean vs dirty and contract multipliers.
- Analysis only: never place orders, rebalance or fetch private account data.

## Marketing experiments
- Name a concrete audience, need, alternative and buying context; separate observed evidence from guesses about motive.
- Run one affordable experiment with its stop rule and success metric set in advance; judge on qualified actions, not clicks.
- Platform-reported conversions over-count; check against first-party data and use holdouts for large budgets.
- No fake scarcity, invented reviews, fabricated numbers or dark patterns.

## Search discoverability
- One page, one purpose, one answer. Mine real questions from support tickets, search console and sales calls; judge by valuable actions, not impressions.
- Titles, descriptions, headings and JSON-LD match visible facts; never invent ratings, authors or freshness.
- Private routes stay behind authentication and out of sitemaps, feeds and Markdown copies; robots.txt is not access control.
- Sitemaps list canonical URLs with truthful lastmod. Never ping retired sitemap endpoints; the Google Indexing API is limited to job postings and livestreams.
- Verify representative and changed pages with `web_probe` seo:true. Neither indexing requests nor llms.txt guarantee crawling, ranking or citation.

## Community promotion
- Post only under explicit publishing authorization; a discovery or site-build request does not grant it. Keep that authorization across resumptions.
- Before any post, read the venue's current rules, the thread and existing answers. An available API or logged-in browser is not permission.
- Stop at logins, MFA, CAPTCHA or moderation blocks; never bypass them or create replacement identities.
- Disclose affiliation; invent no experience, endorsements or identities; no bulk, fake grassroots or undisclosed incentives. Answer the real question; a link is optional.
