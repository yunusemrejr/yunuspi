---
id: frontend
part: web
title: Frontend engineering and web performance
summary: Shipping fast, robust web apps: Core Web Vitals, JavaScript cost, rendering strategies, images and fonts, client state versus server cache, race conditions, progressive enhancement and framework idioms.
terms: frontend front-end web react vue svelte angular next nextjs nuxt astro vite webpack bundle bundler javascript typescript hydration ssr ssg csr spa state redux zustand query fetch lcp inp cls core web vitals lighthouse performance lazy load code splitting browser dom component
files: .tsx .jsx .ts .js .vue .svelte .astro vite.config.ts next.config.js package.json
tools: browser_session web_probe render_see design_audit web_asset_check
skills: frontend-js modern-frontend-frameworks web-performance browser-javascript-engineering vanilla-web-libs component-libraries
---

# Frontend engineering and web performance

Frontend code runs on hardware and networks you do not control. The median user has a mid-range phone on a variable connection. Performance and robustness are therefore product features, and they are decided by how much work the page asks the device to do.

## Measure Core Web Vitals on realistic devices {#vitals}
<!-- terms: lcp inp cls core web vitals lighthouse field data throttling mobile slow 3g performance budget -->

**Principle.** Track Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift under throttled mobile conditions, and set budgets for them.

**Why.** Developer machines hide performance problems. LCP measures when the main content appears (hero image, headline), INP how quickly the page responds to input (long JavaScript tasks block it), CLS how much content jumps (images without dimensions, late-loading fonts and ads). Lab tools with CPU and network throttling approximate real users; field data confirms. Budgets turn performance into a regression test.

**Signals.** Performance judged on a fast laptop; images without dimensions; heavy scripts on initial load.

**Ask.** What are LCP, INP and CLS for this page on a throttled mobile profile?

**Traps.** Optimizing a lab score while real-user metrics are driven by third-party scripts.

## Ship less JavaScript {#javascript-cost}
<!-- terms: bundle size javascript cost code splitting tree shaking lazy import dependency heavy library parse execute -->

**Principle.** Every kilobyte of JavaScript costs download, parse and execution on slow devices; split by route, lazy-load non-critical code, and question heavy dependencies.

**Why.** JavaScript is the most expensive byte on the web because it must execute. Large utility libraries imported whole, date libraries with every locale, and client-side rendering of static content all add up. Bundle analysis reveals the biggest contributors; dynamic imports defer what is not needed for the first view; server rendering or static generation avoids shipping code for content that never changes.

**Signals.** Large new dependencies for small features; the whole app in one bundle; static content rendered by client-side JavaScript.

**Ask.** How much JavaScript does the first view need, and what in the bundle could be deferred or removed?

**Traps.** Micro-splitting into many tiny chunks with request overhead.

## Pick the rendering strategy per page {#rendering}
<!-- terms: ssr ssg csr isr hydration server components static rendering streaming islands spa -->

**Principle.** Static generation for content that rarely changes, server rendering for dynamic but crawlable pages, client rendering for highly interactive app surfaces—often mixed within one app.

**Why.** Each strategy trades time-to-content, interactivity cost, server load and SEO. Hydrating a whole server-rendered page doubles the work for mostly static content; islands and server components hydrate only interactive parts. SPAs suit authenticated apps but make first loads slower and need careful routing and SEO handling.

**Signals.** Marketing pages rendered client-side; entire static pages hydrated; dashboards server-rendered on every interaction.

**Ask.** For this page, what needs to be interactive, and could the rest be static or server-rendered?

**Traps.** Framework-driven choices made before understanding the page's needs.

## Server state is a cache, treat it like one {#server-state}
<!-- terms: server state client state cache react query swr stale revalidate fetch loading duplicate request global store -->

**Principle.** Keep data fetched from servers in a cache layer with staleness, deduplication and invalidation—not copied into global client stores by hand.

**Why.** Copying server responses into a global store creates a second source of truth that goes stale, needs manual invalidation and causes duplicate requests. Query libraries handle caching, background revalidation, deduplication, retries and loading states consistently. Global client state should hold genuinely client-side concerns: UI state, drafts, preferences.

**Signals.** Fetched data stored in global stores and manually updated; duplicate requests for the same data; stale lists after mutations.

**Ask.** Where does fetched data live, and how is it invalidated after a mutation?

**Traps.** Adding a query library to a page with one fetch.

## Guard against stale responses and races {#races}
<!-- terms: race condition stale response abort controller cancel search as you type out of order unmounted -->

**Principle.** When requests can overlap, make sure only the latest relevant response updates the UI—abort superseded requests or check a sequence id.

**Why.** Typing into a search box fires several requests; if an earlier one returns last, the results no longer match the query. Navigating away while a request is pending can update unmounted components. AbortController cancellation and "latest request wins" checks eliminate these bugs, which are invisible on fast local networks.

**Signals.** Search or filter UIs firing requests per keystroke without cancellation; state set after unmount; results that occasionally mismatch inputs.

**Ask.** If two of these requests overlap and return out of order, which one wins?

**Traps.** Debouncing as the only protection; aborting requests that must complete (payments).

## Images and fonts are most of the bytes {#assets}
<!-- terms: images responsive srcset sizes lazy loading webp avif dimensions width height fonts preload priority -->

**Principle.** Serve images at the size displayed, in modern formats, with dimensions and lazy loading below the fold; prioritize the LCP image.

**Why.** Images usually dominate page weight. A 4000-pixel photo shown at 400 pixels wastes megabytes; missing dimensions cause layout shift; lazy-loading the hero delays LCP. srcset and sizes let browsers choose the right resolution; fetchpriority boosts the critical image.

**Signals.** Large images served to small slots; images without width and height; the hero image lazy-loaded.

**Ask.** Is every image sized, formatted and prioritized for how it is displayed?

**Traps.** Over-compression making product images look cheap.

## Progressive enhancement makes failures survivable {#progressive-enhancement}
<!-- terms: progressive enhancement javascript disabled fallback no js graceful degradation html forms resilience -->

**Principle.** Start from HTML that works, then enhance with CSS and JavaScript, so partial failures degrade gracefully instead of producing blank pages.

**Why.** JavaScript fails more often than expected: blocked scripts, flaky networks, extensions, old browsers, errors in third-party code. Pages whose core content and forms work without JavaScript survive all of these. Even in rich apps, server-rendered content, real links and native form submission provide a resilient base.

**Signals.** Blank page when a script fails; links implemented as click handlers; forms that only work through JavaScript.

**Ask.** What does a user see if the main script fails to load?

**Traps.** Dogmatic no-JS requirements for inherently interactive applications.
