---
id: anti-slop
part: design
title: The anti-slop checklist
summary: Every element must earn its place. The condensed doctrine behind the 200-rule website checklist: necessity testing, visual cliches, fake state, copy honesty, structure at the right scale, honest motion and agent scope discipline.
terms: slop checklist necessity template generic saas cliche badge pill glow gradient glass bento card testimonial hero faq footer newsletter chatbot scope
tools: design_audit render_see code_quality artifact_check
skills: anti-ai-slop frontend-design ui-ux-principles ui-antipattern-review copywriting
---

# The anti-slop checklist

Standing constraints include no decorative label dots, boxed icon badges, generic lightbulb logos or muddy orange/brass/brown default palettes. A source comment calling a newly generated style "brand identity" does not authorize it. Require a specific user-brand or necessary-state basis for an exception. For requested visual, 3D or motion improvements, compare baseline and final evidence at matched viewports and relevant states; an attractive-sounding review or one static capture cannot establish improvement. Surface unaddressed policy cues through the existing quality checkpoint rather than launching another review system.

AI website work fails one underlying way: it optimizes for visible completeness and apparent sophistication instead of contextual necessity. The full 200-rule checklist lives in `docs/ANTI-SLOP-CHECKLIST.md`; these passages are the doctrine a reviewer applies. Prefer specific over generic, structural over decorative, quiet over attention-seeking, semantic over ornamental, real over simulated, contextual over fashionable, and subtraction over unnecessary addition.

## Every element must earn its place {#necessity-test}
<!-- terms: necessity earn justify remove decision test subtraction inevitable -->

**Principle.** An element stays only if it improves comprehension, navigation, hierarchy, state, action, brand identity or genuine beauty; otherwise remove it.

**Why.** A page that "looks designed" is not a page that works. Glow, cards, badges, chatbots and testimonials each feel like progress while adding them, and together they bury the actual content under interchangeable SaaS costume. The removal test cuts through that: describe what becomes worse without the element, concretely, for this reader. "Less flashy" is not worse. Agents feel pressure to produce visible output, so the bias runs toward addition; the checklist exists to make deletion the default move. A page where each remaining element is inevitable beats a longer page where each extra element is merely plausible.

**Signals.** Sections that could move to any other site unchanged; widgets whose removal loses nothing; copy describing the page instead of serving the reader.

**Ask.** What exactly becomes worse for this reader if this element disappears?

**Traps.** Removing load-bearing structure (navigation, labels, feedback) in the name of minimalism; confusing unfamiliar with unnecessary.

## No borrowed visual identity {#visual-cliches}
<!-- terms: gradient glow glass aurora blob orb particle cyberpunk neon mesh bokeh texture grain palette cliche -->

**Principle.** Build hierarchy from typography, spacing, alignment and contrast first; reach for glow, gradients, glass, particles and texture only when the brand demands them.

**Why.** Purple-cyan gradients, aurora blobs, glass cards and glowing grids are the fastest way to make unrelated sites look related: they signal "AI made this" louder than any content signals what the site is about. These effects also cost readability — text over gradients, washed-out low-contrast palettes — and performance, while adding zero information. A restrained system in the project's own colors survives longer than any fashionable effect, and when an effect is truly part of the identity it stands out precisely because everything else is quiet. design_audit counts the rendered signatures; the eye judges whether the remainder coheres.

**Signals.** Glows, gradient text, glass panels, particle fields, cyberpunk terminals, sparkle icons, mesh-gradient backgrounds on ordinary content pages.

**Ask.** Would this page keep its identity if every glow, gradient and particle were removed?

**Traps.** Flagging a deliberate brand system as a cliche; demanding flat minimalism from a site whose subject is expressive.

## No simulated state or proof {#fake-state}
<!-- terms: live badge pill status testimonial social proof trusted metric dashboard fake simulated scarcity -->

**Principle.** Status indicators, metrics, testimonials, logos and dashboards must reflect real underlying facts, never decorate.

**Why.** A blinking LIVE dot on a static page, invented "10x faster" claims, fictional testimonials and KPI dashboards for blogs all trade short-term impressiveness for long-term trust: the first visitor who checks finds nothing behind them. Fabricated proof is worse than missing proof, because missing proof invites the honest fix of earning it. Badges, pills and counters are taxonomy and state machinery; using them as ornament teaches readers to ignore the real ones. When the fact does not exist yet, the correct element is nothing — a short honest page beats a long performed one.

**Signals.** LIVE/NEW/BETA pills with no backing state; glowing, pulsing or blinking dots in any form (ping spans, keyframe loops, haloed dots, literal ●/emoji prefixes); eyebrow pills above headings; invented AI ACTIVE/SYSTEM ONLINE/COMING SOON labels; round impressive numbers with no source; testimonial carousels; "trusted by" strips; dashboards on content sites; first-person build narration ("I designed", "this section showcases") leaked into reader copy.

**Ask.** What real fact stands behind this indicator, number or endorsement?

**Traps.** Demanding citations for obvious qualitative statements; stripping genuine earned proof along with the fake.

## No shape and container reflexes {#shape-spam}
<!-- terms: pill card bento border shadow radius container callout sidebar hero layout symmetry -->

**Principle.** Pills, cards, bento grids, callouts, borders and shadows must encode meaning — selection, objects, grouping — not merely signal "designed".

**Why.** Wrapping every paragraph in a card, every label in a pill and every page in a bento grid produces the same page regardless of content: eyebrow, heading, paragraph, three cards, repeat. Containers cost scanability — borders and shadows compete with the text for attention — and they flatten hierarchy, since everything framed identically weighs identically. Plain text on a well-spaced page is a legitimate design; so are sharp corners and borderless layouts. When a container does carry meaning — a card per real object, a callout for genuinely elevated importance — it works because the rest of the page declines the costume.

**Signals.** Pill labels above headings; card-per-paragraph; bento grids with no comparison logic; left-border callout rows; nested bordered boxes; alternating tinted sections.

**Ask.** What meaning would be lost if this container became plain flow?

**Traps.** Forcing all content into undifferentiated prose; ignoring that some objects genuinely want cards.

## No words without content {#copy-honesty}
<!-- terms: copy adjective unlock seamless innovative premium mission voice triad emdash bold headline -->

**Principle.** Copy must say something concrete: cut unearned adjectives, boilerplate openers, mission-statement philosophy and rhetorical tics.

**Why.** "Seamless, intuitive, cutting-edge platform" fits ten thousand products because it describes none of them; each vague adjective spends reader attention without buying understanding. Boilerplate intros, "in conclusion" summaries, rhetorical questions and triad chains ("fast, flexible, powerful") are the verbal equivalent of decorative gradients — recognizable AI texture that delays the point. code_quality prose flags the stock phrases; the deeper fix is structural: start with the substance, name the reader, state the concrete capability, then stop. Preserved human copy that is specific beats smoother generated replacement every time.

**Signals.** Adjective stacks without evidence; "unlock/elevate/supercharge" verbs; mission statements on practical sites; em-dash and triad rhythms in every paragraph; vague Discover/Explore headings.

**Ask.** What concrete fact remains if every adjective and rhetorical flourish is deleted?

**Traps.** Editing voice into flat sameness; cutting deliberate rhetoric the brand actually owns.

## No structure beyond the content's scale {#structure-scale}
<!-- terms: faq footer navigation search taxonomy sidebar breadcrumb metadata scale sitemap -->

**Principle.** Navigation, search, taxonomy, FAQs, footers and sidebars must fit the content's actual volume, not a template's expectations.

**Why.** A six-page site with search, faceted filters, mega menu, tag taxonomy and a forty-link footer spends most of its interface managing content that is not there; each empty structure is a promise the site cannot keep. Manufactured FAQs answer questions nobody asked, bloated footers bury the few real links, and metadata rows (reading time, version, difficulty) imply an editorial machine behind a single page. Structure should emerge from scale: one list beats a taxonomy under dozens of items, a short page needs no table of contents, and a small site earns a small footer. Add structure when readers demonstrably need it, not when the template has a slot.

**Signals.** FAQs with generic questions; footers longer than pages; search over tiny corpora; deep nav for flat content; sidebars and TOCs on short pages.

**Ask.** What reader task at this content volume needs this structure?

**Traps.** Under-structuring genuinely large content; removing wayfinding readers rely on.

## No motion, AI or chrome without a job {#motion-scope}
<!-- terms: animation motion hover parallax scroll cursor chatbot modal carousel tooltip reduced-motion scope creep -->

**Principle.** Animation, AI features, sticky chrome, modals and carousels ship only when they serve a concrete user task better than the simpler alternative.

**Why.** Scroll-jacked pages, magnetic buttons, custom cursors, autoplay carousels and entrance-animation spam all spend the user's time and device budget to demonstrate technique rather than to help. The same holds for unrequested AI: a chatbot, summarizer or "Ask AI" button added because AI was available is a slot machine where an answer should be — a paragraph that answers beats a widget that chats. Motion must respect reduced-motion settings and serve orientation, feedback or continuity; chrome must earn its persistence; every animation library, chatbot and modal is a dependency with privacy, performance and maintenance cost. The agent's scope discipline is the same rule pointed inward: build what was asked, propose the rest, never invent pages and features to look finished.

**Signals.** Floating widgets, sticky purchase banners, newsletter modals, chatbots on content sites, parallax, scroll progress bars on short pages, magnetic buttons, tooltips papering over unclear labels.

**Ask.** What task does this moving, floating or AI element do better than plain content?

**Traps.** Stripping motion that genuinely aids orientation; refusing an AI feature the user explicitly requested.

## The decision test before adding anything {#decision-test}
<!-- terms: decision add element test inevitability specific structural quiet semantic real contextual -->

**Principle.** Before adding any element, section, effect, copy block or dependency, answer ten questions; with no good answer, do not add it.

**Why.** The checklist's two hundred rules compress into one habit: justify addition, never justify removal. The ten questions — what problem it solves, why simpler fails, what it communicates, whether it is specific to this project, whether it is copied convention, whether a good designer would cut it, what it costs, whether it survives undecorated, whether its text is concrete, whether disappearance clarifies — catch every category at once, including ones no rule names. Applied consistently, the test produces the final rule's outcome: an interface that looks inevitable, where each element is present because the product genuinely requires it. Reviewers apply the same test in reverse to existing work.

**Signals.** Additions justified by fashion ("modern sites have..."), symmetry, fullness or available technology rather than by a reader problem.

**Ask.** Which of the ten questions does this addition answer well?

**Traps.** Using the test to veto deliberate, briefed expression; applying it only to others' additions and never your own.
