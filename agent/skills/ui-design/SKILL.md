---
name: ui-design
description: "Design, redesign, critique and verify interfaces: pages, sites, dashboards, app screens, desktop apps, decks. Grounding in the subject, palette and type decisions, layout, states, copy, the tells of generated design and how to avoid them, render checks."
---

# Interface design

A model asked to design with no constraints does not design, it averages: the result is the median of every page it has seen. Two medians are in circulation, and both are recognisable at a glance.

- **Indigo SaaS:** an indigo-to-purple or purple-to-pink gradient, Inter (or Space Grotesk, Geist), a permanent near-black background, three identical rounded cards with an icon on top, a pill badge above the headline, a glow behind it, a row of invented statistics, copy like "Build faster. Ship smarter."
- **Cream editorial:** an ivory background, a terracotta or rust accent, an oversized serif with one italic word, tracked-out capitals, hairline rules. It was adopted as the opposite of the first and became the same thing in another palette.

Any one of these can be a real choice. The tell is several together with no argument for why this subject needed them. Both fail one test: swap the logo and the headline for another company's and the page still works.

## Before any code

1. **Name the subject.** The concrete product, who uses it, and the one job this screen does for them. Look at what exists first: the live product, its current screens, its real data, its brand. Inside an existing product you extend its tokens, components and voice; you restyle only when asked to.
2. **Derive the look from the subject's own material:** its units, its data, its workflow, the physical thing it is about. A tide table, a bakery and a network monitor should not share a palette or a layout.
3. **Write the decisions down, one line each, with the reason:** the neutral and its hue bias (not a pure grey chosen because it is safe), the one accent and what it means, the type pairing (one you would not reuse on an unrelated project), the layout idea.
4. **One point of view per screen.** Pick the single thing the screen is about and let everything else be quiet. A page where every element tries equally hard fails whether it is maximal or minimal.

If the user's own words ask for one of the looks above, build exactly that. Their instruction outranks this guide.

## While building

- **Real content only.** No invented numbers, logos, testimonials or status. A figure with no source is a labelled placeholder or it is not there.
- **Every repeated element earns its place.** A badge, tag, numbered step or coloured border has to carry information. If removing it loses none, remove it. Numbered steps are for things that are actually sequential.
- **Ornament must mean something.** A pulsing dot needs a live status behind it. A glow behind a headline has no such excuse.
- **Less text, more picture.** Cut each screen to the few things its user comes for; move or delete the rest. One good figure beats a wall of labels.
- **Colour carries meaning:** the strongest colour goes to what matters most. Body text holds at least 4.5:1 contrast in every theme you ship.
- **Design the states a user can reach:** empty, loading, error, long text, many items, keyboard focus. Hover and focus must not shift the layout.
- **One system:** one spacing scale, a small set of type roles, one radius, at most two shadows.
- Icons are drawn or taken from one set; emoji are not icons.
- Motion moves `transform` and `opacity` only, explains a change of state, and stops for a reader who asked for reduced motion.

## Before reporting

- Render it in a real browser at 360, 768 and 1440 px (`render_see`, or `browser_session` when it needs interaction) and look at the screenshots. Fix what a designer would reject: overflow, overlap, cramped or orphaned text, weak hierarchy.
- Run the swap test once more on the finished screen.
- Say which states and widths you looked at, and what you did not check.
