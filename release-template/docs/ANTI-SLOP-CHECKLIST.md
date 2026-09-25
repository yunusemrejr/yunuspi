# Anti-slop checklist for AI website agents

Standing design and implementation rules. The Observer Book's `anti-slop`
chapter distills this list into reviewable passages; the `anti-ai-slop`
skill's website necessity catalog names the harness mechanism behind each
failure mode. When they disagree about a specific page, this checklist wins
for websites: it is the most specific rule set.

Standing UI constraints also reject generic lightbulb branding, muddy orange/brass/brown default palettes, decorative colored dots before labels, and boxed icon badges. Necessary state and explicitly requested branding are contextual exceptions with evidence. A generated source comment asserting brand ownership is insufficient. Visual/3D/motion upgrades require baseline-versus-final inspection of the relevant states, not merely a new asset or passing tests.

## Core principle

Every visible element must justify its existence through one or more of these:

- improves comprehension
- improves navigation
- communicates hierarchy
- communicates state
- supports an action
- reinforces a specific brand identity
- adds genuine aesthetic value without harming clarity

If an element exists only because it "looks modern", "adds depth", "feels
premium", "makes the page more dynamic", or resembles common SaaS templates,
remove it.

## 1. No generic AI/SaaS visual clichés

Avoid by default: glowing halos; blurry gradient blobs; purple/orange/pink
gradient backgrounds; cyan/purple cyber gradients; random neon accents;
ambient light glows behind cards; radial glow backgrounds; "aurora" effects;
glassmorphism everywhere; excessive backdrop blur; translucent cards without
functional reason; floating gradient orbs; abstract glowing spheres; fake
particle fields; star fields; glowing grids; dotted-tech backgrounds;
circuit-board motifs; fake scanning lines; animated gradient borders; rainbow
borders; glowing outlines; "futuristic" decorative noise; generic abstract
mesh gradients; unnecessary animated background shaders.

Do not use these merely because the page concerns software, AI, technology,
engineering, music, finance, or science.

## 2. No glow abuse

A glow should be rare and intentional. Avoid: glow on every CTA; glow around
cards; glowing text; glowing icons; glowing borders; pulsing glow; hover glow
on every interactive element; multiple differently colored glows; fake light
sources behind sections; large soft circles placed behind content.

If removing the glow does not reduce usability or brand meaning, remove it.

## 3. No fake "live" indicators

Never add blinking green dots, pulsing red dots, "LIVE" pills, "ONLINE"
badges, "ACTIVE" labels or animated status indicators unless the status is
actually derived from real live state. A static page is not "live" because
it is deployed.

## 4. No badge spam

Avoid unnecessary labels such as NEW, LIVE, BETA, AI, FAST, SECURE, PRIVATE,
MODERN, SMART, PRO, FEATURED, VERIFIED, TRENDING, POPULAR. A badge should
represent meaningful state or taxonomy, not decoration.

## 5. No pill-everything UI

Do not automatically make everything rounded pills: navigation pills,
category pills everywhere, CTA pills, metadata pills, filter pills without
need, tiny pill labels above every heading, pill containers around ordinary
text. Use pills only where the shape communicates selection, state,
tag/category or compact action.

## 6. No excessive rounded corners

Do not default to 16–32 px radius cards, giant rounded panels, rounded every
container, rounded images, rounded icon backgrounds, rounded tables, rounded
code blocks or rounded section wrappers. Use radius intentionally and
consistently. Some interfaces should use sharp corners, slight radius or no
containers at all.

## 7. No "icon inside colored rounded square" boilerplate

Avoid the standard pattern — rounded pastel square → generic Lucide icon →
heading → sentence — especially repeated 3–6 times. This pattern is one of
the strongest signals of AI-generated SaaS design. If an icon adds no new
information, remove it.

## 8. No icon-for-everything syndrome

Do not attach an icon to every heading, bullet, feature, navigation item,
metric, paragraph or button. Icons are not punctuation. Use them where
recognition is faster than text.

## 9. No emoji slop

Avoid emojis in professional UI unless the brand explicitly supports them,
especially 🚀 Launch, ✨ Discover, 💡 Insights, 🔥 Trending, 🎯 Goals,
⚡ Fast, 🧠 AI, 🔒 Secure. Do not replace actual visual design with emoji.

## 10. No decorative left-border callout spam

Avoid repetitive `│ Important / Some text here...` boxes with blue, purple
or yellow warning borders, rounded backgrounds, icons and shadows. Use
callouts only for content that genuinely needs elevated semantic importance.

## 11. No callout-box addiction

Do not turn ordinary prose into tip boxes, note boxes, quote boxes, warning
boxes, insight boxes, "key takeaway" boxes or highlighted cards. Normal text
is allowed to remain normal text.

## 12. No cardification of ordinary content

Do not place content in cards merely to make the page look designed: plain
paragraphs, navigation that works better as links, simple metadata, article
lists that work better as rows, one-sentence facts, arbitrary groups. A card
should represent an actual object or meaningful unit.

## 13. No bento-grid reflex

Do not convert every landing page into a bento grid: random unequal tiles,
giant central card plus small decorative tiles, feature grids with no
semantic hierarchy, fake dashboard layout for editorial content. Use grids
because information benefits from comparison or grouping, not because bento
layouts are fashionable.

## 14. No meaningless dashboards

Do not turn ordinary websites into control panels: fake KPI counters, fake
activity widgets, fake charts, fake status dashboards, synthetic uptime
indicators, fake recent activity, decorative gauges, meaningless
percentages. A blog does not need to look like Grafana.

## 15. No metric theater

Never invent metrics for visual impact: "10x faster", "99.9% reliable",
"50k+ users", "24/7", "100% private", "3x productivity", arbitrary
percentages — unless real and supportable.

## 16. No fake social proof

Do not invent testimonials, customers, company logos, review counts, star
ratings, "trusted by", user counts, press mentions or awards. Placeholder
social proof should never reach production.

## 17. No "trusted by" logo strip by default

Do not add a corporate-logo row just because landing pages often contain
one. Only show organizations with a real relationship and appropriate
permission/context.

## 18. No startup-template hero by default

Avoid automatically creating the eyebrow badge, giant centered headline,
gradient word, two CTAs, row of avatars, "trusted by", glowing screenshot
and stats row underneath. Design the hero around the actual site.

## 19. No gradient-text headlines

Avoid rainbow or gradient-colored words inside headings unless part of a
deliberate brand system — especially `Build **better software** faster`
with a purple-to-blue gradient on "better software".

## 20. No gratuitous oversized typography

Large type must correspond to hierarchy. Avoid 90–140 px headlines for
ordinary pages, enormous one-word titles, headings occupying half the
viewport, giant serif typography solely to imply luxury. Do not confuse
scale with sophistication.

## 21. No pseudo-luxury template

Avoid blindly combining cream background, dark brown text, huge serif
headings, salmon/orange CTA, thin goldish borders, italic quotes and
enormous whitespace. This can work, but it is now another recognizable
template. The visual language must fit the subject.

## 22. No generic cyberpunk template

Avoid automatically combining black background, cyan, violet, glowing
borders, monospace, grid background, animated terminal text and fake
command output. Technical subject matter does not require cyberpunk
styling.

## 23. No random monospace

Do not use monospace merely to imply engineering, authenticity, terminal
culture or technical sophistication. Monospace should represent code,
machine-readable information or a deliberate typographic identity.

## 24. No fake terminal UI

Avoid decorative `> initializing... / > connected / > system ready`
unless the terminal itself is meaningful to the product. No fake console
output as decoration.

## 25. No pseudo-technical decoration

Avoid hexadecimal IDs, coordinates, fake timestamps, API-looking labels,
JSON fragments, node diagrams, version numbers, hashes, fake telemetry,
"SYS_001" or "[STATUS: ACTIVE]" unless they communicate real information.

## 26. No architecture cosplay

Do not expose implementation merely to make the site feel technically
serious. Avoid user-facing mention of Git, CI/CD, framework choice, hosting
provider, database type, repository structure, build pipeline, deployment
process, linting, agents, internal modules or infrastructure unless context
specifically requires it.

## 27. No AI provenance clutter

Do not add "Built with AI", "AI-assisted", "Generated with AI", "Powered
by agents", "AI-curated" or "AI-enhanced" unless this matters to the user
or is legally/ethically necessary.

## 28. No process narration

Do not explain internal work such as how articles are drafted, how agents
generate copy, how content passes through validators, how pages deploy, how
prompts are structured or how internal review happens — unless the page
specifically documents that process.

## 29. No internal terminology leakage

Do not expose internal agent names, database table names, service names,
internal project codenames, pipelines, component names, environment names
or internal statuses. User-facing language should match user concepts.

## 30. No README text inside the product

Ask: would this sentence make more sense in README.md than on the website?
If yes, it probably does not belong in the interface.

## 31. No self-description of good design

Do not write "carefully crafted", "thoughtfully designed", "beautifully
simple", "intentionally minimal", "elegantly engineered" or "meticulously
curated". Demonstrate the quality instead.

## 32. No mission-statement fabrication

Do not invent grand philosophical statements for ordinary projects. Avoid
"We believe the future of knowledge belongs to..." when the site is simply
a useful collection of articles/tools.

## 33. No corporate grandiosity

Do not call a small project an ecosystem, platform, revolution,
next-generation solution, transformative experience, innovation hub or
comprehensive suite unless those descriptions are objectively justified.

## 34. No meaningless marketing adjectives

Remove seamless, powerful, intuitive, innovative, cutting-edge,
next-generation, effortless, intelligent, robust, dynamic, immersive and
premium unless the sentence gives concrete evidence.

## 35. No "unlock" language

Avoid "unlock your potential/insights/productivity/possibilities",
"supercharge your workflow" and "elevate your experience". Say exactly what
the feature does.

## 36. No vague section headings

Prefer concrete headings over Discover, Explore, Insights, Experience,
Solutions, Possibilities, Innovation and Resources unless these genuinely
describe the section.

## 37. No duplicate sections

Do not create several sections expressing the same idea: Why us, Benefits,
Advantages, Why it matters, What makes us different, Our approach. Merge
overlapping concepts.

## 38. No filler sections

A page does not need 8 sections, 12 sections, a footer manifesto, FAQs,
testimonials, stats, CTA banner, newsletter, pricing or roadmap just to
feel complete. Short pages are allowed.

## 39. No FAQ unless questions actually exist

Do not manufacture questions purely for SEO or layout ("What makes our
platform different?", "Is the platform easy to use?", "Who is this for?").
Use FAQs for actual recurring ambiguity.

## 40. No footer bloat

Avoid huge footers containing redundant navigation, fake product
categories, fake company sections, dozens of links, duplicated CTA, mission
statement, newsletter form or social icons with no accounts. Small sites
can have small footers.

## 41. No unnecessary newsletter box

Do not add "Stay in the loop / Get insights delivered to your inbox"
unless there is an actual newsletter.

## 42. No unnecessary account UI

Do not introduce Sign in, Create account, Profile, Saved items or
Preferences unless there is a genuine account system and use case.

## 43. No artificial personalization

Avoid adding "For you", personalized feeds, recommendation sections,
recent items or saved preferences without meaningful personalization data.

## 44. No meaningless search

Do not add search to a site with six pages unless it genuinely helps.
Likewise avoid advanced filters, sorting, faceted search and category
drilldowns before the content volume warrants them.

## 45. No taxonomy inflation

Do not create excessive tags, topics, categories, collections, series,
levels, themes or formats for small content sets. Hierarchy should emerge
from actual scale.

## 46. No fake complexity

Do not make a simple product appear complex to imply value. Prefer "Upload
file" over "Intelligent document ingestion pipeline" if that is what
actually happens.

## 47. No unnecessary sidebars

A sidebar should support navigation or context. Do not add one merely to
fill empty width with related links, table of contents, tags, random
metadata, ads, "on this page" or similar when the page is short.

## 48. No automatic "On this page"

Only add a table of contents when the page is long enough, sections are
meaningful and navigation benefits. A five-section short article does not
automatically need one.

## 49. No breadcrumb theater

Breadcrumbs should express real hierarchy. Do not show
`HOME / ARTICLE / CATEGORY / PAGE` just because it looks editorial.

## 50. No metadata clutter

Do not automatically display reading time, update timestamp, author,
category, tags, version, word count, difficulty or status. Only show
metadata relevant to the content.

## 51. No fake editorial sophistication

Avoid unnecessary "Vol. 01", issue numbers, edition labels, publication
codes and pseudo-journal terminology unless the publication genuinely uses
them.

## 52. No unnecessary "last updated"

Do not highlight update dates unless freshness matters. A timeless music
theory explanation does not need "UPDATED 25 SEPTEMBER 2026" prominently
displayed.

## 53. No meaningless animations

Animation must serve orientation, state transition, continuity, feedback
or spatial understanding. Avoid elements floating forever, text
continuously moving, pulsing cards, glowing hover animations, bouncing
arrows, blinking indicators and rotating decorative shapes.

## 54. No scroll-animation spam

Avoid every section fading in, sliding upward, scaling, blurring into
focus or staggering child elements. Subtle entrance motion can work, but
the page should not constantly announce itself.

## 55. No overengineered hover states

Do not make cards lift, rotate, glow, enlarge, change gradient, animate
icons and cast stronger shadows all at once. Hover should clarify
interactivity, not perform.

## 56. No magnetic-button gimmicks

Do not add cursor-following or magnetic CTAs unless there is a strong
experiential reason.

## 57. No custom-cursor gimmicks

Avoid replacing the system cursor with circles, blobs, crosshairs or
trailing particles unless central to the experience.

## 58. No scroll-jacking

Do not hijack standard scrolling for presentation effects. Users should
remain in control.

## 59. No horizontal-scroll gimmick

Do not turn normal vertical content into horizontal scrolling solely for
novelty.

## 60. No unnecessary parallax

Avoid background/foreground movement that adds no information.

## 61. No motion without reduced-motion support

Any meaningful animation must respect `prefers-reduced-motion`.

## 62. No visual hierarchy through decoration alone

Use typography, spacing, alignment, composition, scale and contrast before
glow, cards, colored backgrounds, borders, shadows and animation.

## 63. No excessive section backgrounds

Avoid alternating every section white, gray, purple tint, dark, gradient,
beige. Spacing is often enough to separate sections.

## 64. No random color blocks

Color should have a system. Do not randomly assign different feature cards
blue, orange, purple, green and pink unless colors encode categories.

## 65. No excessive accent colors

Use a restrained palette. Every semantic role does not need a unique
accent.

## 66. No generic AI palette

Explicitly avoid defaulting to purple + cyan, purple + pink, purple +
orange, blue + violet, dark navy + electric blue or cream + brown + coral.
Select color from brand/context, not AI design priors.

## 67. No low-contrast aestheticism

Do not sacrifice readability for muted elegance. Watch gray-on-gray,
beige-on-cream, transparent text, text over gradients, thin serif body
text and opacity below reasonable contrast.

## 68. No excessive border use

Do not outline every card, section, input, navigation group, icon, image
and statistic. Whitespace can define boundaries.

## 69. No border-within-border UI

Avoid nested bordered boxes unless structure genuinely requires it.

## 70. No shadow as default depth mechanism

Start with flat composition. Introduce shadows only where depth
communicates layering or interactivity.

## 71. No giant shadows

Avoid huge diffused shadows beneath every card or modal.

## 72. No decorative noise without purpose

Textures should support a deliberate visual identity. Do not add grain
because "flat looks boring".

## 73. No fake paper texture by default

Serif typography does not require grain, cream paper, scratches or print
artifacts.

## 74. No unnecessary decorative SVGs

Avoid generic squiggles, arrows, stars, sparkles, circles, hand-drawn
underlines and abstract geometry unless part of the identity.

## 75. No sparkle icon abuse

Especially avoid sparkle icons as the universal symbol for AI.

## 76. No fake hand-drawn authenticity

Do not add imperfect arrows, circles, marker highlights or scribbles
merely to make the interface feel human.

## 77. No stock illustration reflex

Do not automatically introduce 3D characters, abstract isometric shapes,
generic people illustrations or floating device mockups. Use actual
relevant assets when possible.

## 78. No generic 3D slop

Avoid shiny 3D cubes, spheres, glass objects, metallic ribbons, inflated
icons and blobs unless they are part of a coherent art direction.

## 79. No fake product screenshot

Never create a fictional dashboard/screenshot to make a product appear
more complete. Show the real interface.

## 80. No browser-frame abuse

Do not wrap every screenshot in a fake browser frame with three colored
circles.

## 81. No device-mockup abuse

Do not put a web screenshot inside an oversized floating laptop/phone
unless device context matters.

## 82. No stock-photo irrelevance

Do not use generic office/team photos where they communicate nothing
specific.

## 83. No image just because a section feels empty

Whitespace is not a defect.

## 84. No forced symmetry

Not every section needs "text left / image right" followed by "image left
/ text right". This alternating SaaS pattern is highly recognizable.

## 85. No arbitrary three-column layout

Three columns are not inherently correct. Choose column count based on
content relationships.

## 86. No component repetition without rhythm

If every section uses exactly eyebrow, heading, paragraph, three cards,
the page will look generated. Vary composition only where content
justifies it.

## 87. No arbitrary decorative asymmetry either

Do not offset items randomly merely to make the page look "editorial".
Alignment should be intentional.

## 88. No giant empty hero with tiny content

Whitespace must create hierarchy, not simply inflate the page.

## 89. No viewport-height sections by default

Do not force every section to `min-height: 100vh`. Content should
determine height.

## 90. No arbitrary sticky elements

Do not make nav, sidebars, CTAs, table of contents or share controls
sticky unless continuous access provides value.

## 91. No floating CTA widgets

Avoid persistent bottom-right "Get started", "Chat", "Book a demo" or
"Ask AI" unless truly necessary.

## 92. No chatbot by default

Do not add an AI assistant because the project uses AI. A chatbot needs an
actual use case.

## 93. No unnecessary "Ask AI" buttons

Avoid placing AI buttons beside search, articles, tables or text selection
unless they materially improve the task.

## 94. No AI feature insertion without request

Agents must not spontaneously add summarization, recommendations,
generation, chat, semantic search or autonomous actions because they seem
sophisticated.

## 95. No overbuilt navigation

Avoid mega menus for small sites. Keep information architecture
proportional to content.

## 96. No generic nav labels where specifics exist

Prefer "Music Theory" instead of "Explore" when that is where the link
actually goes.

## 97. No unnecessary hamburger menu on desktop

Use available horizontal space appropriately.

## 98. No floating navigation island by default

Avoid giant rounded navigation bars hovering over the page merely because
modern SaaS templates use them.

## 99. No nav translucency unless justified

Navigation does not automatically need blur, transparency or glass.

## 100. No excessive CTA duplication

Do not repeat the same action in navbar, hero, middle section, sticky
widget, footer and modal unless conversion requirements justify it.

## 101. No modal interruption without strong reason

Avoid automatic newsletter modals, ebook modals, cookie-like promos,
onboarding popups and discount popups. Respect the reading/task flow.

## 102. No toast notifications for ordinary actions

Do not show "Success! Navigation completed." Use notifications only where
confirmation matters.

## 103. No fake progress indicators

Avoid loading/progress UI if the action is effectively instantaneous.

## 104. No skeleton screens for trivial content

Skeleton loaders should address actual latency, not simulate application
sophistication.

## 105. No unnecessary accordions

Do not hide ordinary content in accordions just to reduce visible page
length.

## 106. No tabs for tiny amounts of content

Tabs add interaction cost. Use them only when switching between equivalent
views is useful.

## 107. No carousel for content that fits normally

Avoid carousels for testimonials, articles, features and logos when a
normal layout is clearer.

## 108. No autoplay carousel

Never make the user chase moving content.

## 109. No horizontal card slider for everything

A row of cards does not become better by making it swipeable.

## 110. No truncation without reason

Do not hide readable text behind "Read more", collapsed cards or hover
reveal unless information density demands it.

## 111. No hover-only critical information

Important content must work on touch devices and keyboards.

## 112. No desktop-only visual assumptions

Check narrow mobile widths, large desktop widths, touch, keyboard, zoom
and reduced motion.

## 113. No mobile card explosion

Responsive design should not simply stack 25 cards into one endless
column. Reconsider the information structure.

## 114. No absurd mobile padding

AI-generated layouts often retain giant desktop spacing on mobile. Reduce
spacing proportionately.

## 115. No text line lengths that are too wide

For normal prose, optimize readability rather than filling screen width.

## 116. No tiny body typography for "elegance"

Readable body text beats aesthetic fragility.

## 117. No excessive uppercase labels

Avoid making every metadata element `SMALL TRACKED UPPERCASE TEXT`. This
is another common faux-editorial pattern.

## 118. No letter-spacing abuse

Wide tracking should not substitute for hierarchy.

## 119. No excessive serif/sans mixing

Use typography with a coherent role system. Do not mix fonts solely to
create an editorial impression.

## 120. No decorative italics everywhere

Reserve italics for meaningful emphasis or typographic voice.

## 121. No excessively thin font weights

Thin typography frequently looks elegant in mockups and weak in real
interfaces.

## 122. No fake magazine layout

Do not force oversized drop caps, issue numbers, side notes, editorial
grids and tiny uppercase metadata unless the site actually benefits from
editorial conventions.

## 123. No meaningless author persona

Do not invent author names, editorial desks or "staff" identities.

## 124. No boilerplate blog intro

Avoid "In today's rapidly evolving world...", "In an era where...",
"Whether you're a beginner or an expert...". Start with substance.

## 125. No conclusion that merely repeats the article

Do not mechanically generate "In conclusion..." unless the summary
actually adds utility.

## 126. No artificial rhetorical questions

Avoid filler such as "But what does this mean for you?" or "So where do we
go from here?" unless they genuinely structure the argument.

## 127. No "not just X, but Y" overuse

AI copy frequently leans on "It's not just a tool — it's a...". Use
literal prose instead.

## 128. No em-dash addiction

Do not use em dashes as the default sentence structure. Variation matters.

## 129. No triad addiction

Avoid endlessly writing "fast, flexible, and powerful". AI tends to
produce rhetorical groups of three excessively.

## 130. No unnecessary bolding

Do not bold random keywords in every paragraph. Use bold for scanability
or actual emphasis.

## 131. No fragmented sentence styling for drama

Avoid "Simple. Fast. Powerful." unless the voice genuinely calls for it.

## 132. No fake confidence

Do not make unsupported claims sound definitive. If evidence is absent,
remove or qualify the claim.

## 133. No invented specificity

Never invent dates, statistics, customer counts, performance claims,
awards, partnerships or features just to fill a component.

## 134. No placeholder copy surviving production

Search for lorem ipsum, "John Doe", "Acme", fake addresses, fake phone
numbers, fake testimonials and demo statistics before completion.

## 135. No unnecessary legal-looking prose

Do not produce pseudo-legal language for ordinary explanatory sections.

## 136. No privacy theater

If the site does not track users, say that concisely if relevant. Do not
produce a manifesto around "privacy by construction" unless there is real
substance worth explaining.

## 137. No security theater

Do not advertise baseline practices as extraordinary features: HTTPS,
hashed passwords, encrypted connections, secure hosting — unless security
is directly material.

## 138. No accessibility theater

Do not add marketing copy claiming accessibility. Implement accessible
behavior instead.

## 139. No SEO prose visible to humans

Do not degrade copy to satisfy keyword density. Avoid repeated phrases and
unnatural geographic/product keywords.

## 140. No hidden text tricks

Never insert invisible or nearly invisible SEO content.

## 141. No keyword-stuffed headings

Headings must read naturally.

## 142. No auto-generated category pages with no value

Do not create thin pages for every tag/category purely for indexing.

## 143. No duplicate meta descriptions

Generate specific metadata based on page content.

## 144. No generic title templates everywhere

Avoid every page looking like "X — Your Ultimate Guide | Brand". Write
natural titles.

## 145. No schema markup unsupported by actual content

Do not mark something as FAQ, Review, Product, Organization or Event
unless it genuinely is one.

## 146. No accessibility regressions for aesthetics

Never remove focus indicators, labels, sufficient contrast or semantic
heading structure to make the page look cleaner.

## 147. No placeholder alt text

Avoid "image", "decorative image", "hero image". Write useful alt text
where needed; use empty alt for genuinely decorative images.

## 148. No heading-level chaos

Do not choose H1–H6 based on font size. Maintain semantic hierarchy.

## 149. No clickable `div` soup

Use proper elements: `button`, `a`, `input`, `nav`, `main`, `article`,
`section`. Semantics first.

## 150. No unnecessary JavaScript

Do not use JavaScript for what HTML/CSS can do reliably.

## 151. No dependency inflation

Do not install a library just to implement one icon, one animation, one
tooltip or one utility function. Assess cost first.

## 152. No framework cargo cult

Do not introduce React/Next/Vue/etc. when static HTML or the existing
stack already solves the problem.

## 153. No dependency-driven redesign

Do not redesign the product around whatever component library happens to
be installed.

## 154. No design-system cargo cult

A small site does not need an enterprise-scale token/component
architecture unless complexity justifies it.

## 155. No component abstraction for one use

Do not abstract every five lines of markup into a reusable component.
Reuse should be real.

## 156. No arbitrary abstraction

Do not create generic wrappers, render factories, visual configuration
schemas or component generators unless they solve an actual maintenance
problem.

## 157. No animation library by default

Do not pull in Framer Motion/GSAP/etc. simply because the page needs one
fade transition.

## 158. No icon-library sprawl

Use one coherent icon system when possible. Do not mix Lucide, Heroicons,
Font Awesome, custom SVGs and emojis without reason.

## 159. No font explosion

Limit font families and weights. Do not download five fonts to construct
"brand personality".

## 160. No massive image payloads for decoration

Optimize assets and question whether decorative imagery is needed at all.

## 161. No autoplay media

Audio and video should require explicit user intent unless the context
strongly warrants otherwise.

## 162. No performance sacrifice for superficial polish

Do not trade load time, responsiveness, accessibility, battery or mobile
performance for ornamental effects.

## 163. No unnecessary analytics/tracking

Do not add tracking merely because most websites do.

## 164. No third-party scripts without purpose

Each external script adds privacy cost, security surface, performance cost
and maintenance cost. Justify it.

## 165. No cookie banner if there are no relevant cookies

Do not manufacture compliance UI unnecessarily.

## 166. No fake cookie customization

Do not display elaborate category toggles when the underlying system does
not meaningfully honor them.

## 167. No consent dark patterns

Avoid giant "Accept", hidden "Reject", confusing wording and pre-selected
optional consent.

## 168. No manipulative urgency

Avoid fake countdown timers, low-stock notices, "12 people viewing" and
expiring offers.

## 169. No visual hierarchy based on conversion manipulation

The interface should help users decide, not pressure them.

## 170. No unnecessary sticky purchase banners

Especially on content-focused sites.

## 171. No fake scarcity

Never fabricate scarcity.

## 172. No dark-pattern unsubscribe or cancellation flows

Make reversal as understandable as activation.

## 173. No agent scope creep

The agent must not add new pages, features, sections, copy, dependencies,
tracking, animations or design systems outside the requested scope without
strong justification.

## 174. No "improvement" through quantity

More sections, code, components, animation, prose and decoration does not
imply better.

## 175. No rewriting working copy unnecessarily

If existing copy is specific and correct, preserve it. Do not replace
human-written text with smoother generic AI copy.

## 176. No changing brand voice casually

Respect the site's established seriousness, humor, technical level,
vocabulary, density and tone.

## 177. No homogenization

Do not make every project resemble Linear, Stripe, Vercel, Notion, Apple
or typical YC SaaS landing pages. Reference quality without cloning
identity.

## 178. No "modernization" that erases character

Old-fashioned, plain, dense, technical, or editorial design may be
deliberate. Modern does not mean rounded, animated, pastel, or
gradient-heavy.

## 179. No redesign without understanding the subject

Before visual changes, identify audience, purpose, content type, brand
character, information hierarchy, likely user task and existing visual
language. Then design.

## 180. No aesthetics detached from content

Music theory, industrial automation, personal portfolio, finance, and
developer tooling should not all receive the same visual treatment.

## 181. No decorative element without a reason

For every ornament, ask: what becomes worse if I remove this? If the
answer is "nothing except the page looks less flashy", strongly consider
removing it.

## 182. No automatic visual centering

Not every page should use centered headings, body copy, CTA and content
blocks. Editorial and technical content often reads better left-aligned.

## 183. No "everything needs a container" thinking

Content can exist directly on the page. You do not need a rounded
rectangle around every concept.

## 184. No arbitrary max-width reuse

Different content types need different widths: prose, tables, tools,
diagrams, galleries. Do not force everything through the same `max-width`.

## 185. No gratuitous sticky TOC

Only use when page length warrants it.

## 186. No visible scrollbar styling unless brand-critical

Browser-native UI is often preferable.

## 187. No weird custom selection colors without purpose

Do not style every native browser affordance just because CSS permits it.

## 188. No decorative loading screen

Do not delay content to display logos, progress bars or animated intros
unless something genuinely needs to load.

## 189. No splash-screen theater

Websites are not mobile apps by default.

## 190. No intro animation before access

Never make users wait for a branding sequence.

## 191. No gratuitous page transitions

Normal navigation should remain fast and predictable.

## 192. No forced smooth scrolling everywhere

Respect native browser behavior unless smooth scrolling clearly improves
orientation.

## 193. No "scroll to explore" prompt

People already know how websites work.

## 194. No bouncing down-arrow

Especially not continuously animated.

## 195. No decorative scroll progress bar unless useful

For long-form reading it can help. For short pages it is noise.

## 196. No fake interactivity

Do not create components that appear interactive but do nothing: toggles,
switches, filters, charts, cards, buttons.

## 197. No disabled-looking decorative controls

Do not imitate application chrome if it is not functional.

## 198. No unnecessary tooltip

Labels should usually be understandable without hover explanations.

## 199. No tooltip as substitute for clear wording

Fix unclear terminology first.

## 200. No hidden essential controls

Do not sacrifice discoverability to minimalism.

## Agent decision test

Before adding any UI element, section, animation, visual effect, copy
block, or dependency, answer:

1. What exact user or content problem does this solve?
2. Why is the existing simpler solution insufficient?
3. Does it communicate information, hierarchy, state, or action?
4. Is it specific to this project's identity and context?
5. Is it merely copied from current SaaS/AI design conventions?
6. Would a competent human designer plausibly remove it?
7. Does it create visual noise, cognitive load, maintenance cost, or performance cost?
8. Does it still make sense with animation/glow/color removed?
9. Is the text saying something concrete?
10. Would the interface become clearer if this disappeared?

If there is no good answer, do not add it.

## Final anti-slop rule

> Prefer specific over generic, structural over decorative, quiet over
> attention-seeking, semantic over ornamental, real over simulated,
> contextual over fashionable, and subtraction over unnecessary addition.
> The goal is not to make the interface look "designed by AI." The goal is
> to make it look inevitable: as if each element is there because the
> product genuinely requires it.
