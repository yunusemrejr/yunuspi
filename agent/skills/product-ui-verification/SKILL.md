---
name: product-ui-verification
description: Use when changing interfaces, shared UI components or website presentation. Preserve product identity and verify real states instead of applying a generic aesthetic.
---

# Product-specific UI work

The user's design prompt overrides these defaults. A vague request is not permission to replace the product's identity.

- Inspect existing components, routes, styles, design tokens, content and user tasks before choosing changes. Use indexed symbol search and module outlines where available; inventory usages, variants and states before editing shared components.
- Derive hierarchy, density, geometry, color and motion from this product. Preserve justified design-system decisions. Avoid generic gradients, gratuitous glass, excess pills/cards, decorative “Live” badges, fabricated metrics, meaningless animation and equal emphasis everywhere. Do not replace those clichés with another fixed aesthetic.
- Make the smallest coherent change. Reuse established components and tokens; do not invent a second button system, styling framework or configuration layer. Preserve behavior, copy and responsive layout unless the task calls for changes.
- Check keyboard access, focus visibility, accessible names, contrast and relevant loading/error/empty/disabled states. Verify narrow and wide layouts. State what was actually tested rather than claiming a comprehensive accessibility audit.
- Inspect semantics before pixels when that answers the question. `render_see {source,output:"text"}` provides bounded live-DOM evidence in an isolated, unauthenticated browser; `output:"both"` adds pixels for vision models. Set `colorScheme:"dark"` or `reducedMotion:"reduce"` for relevant media states. Neither performs login or interaction. DOM facts do not establish visual quality.
- When pixels are necessary and the active model lacks vision, use an explicitly vision-capable native subagent with only the image and precise question, fresh context, no mutations and no further delegation. Verify capability first; return the artifact reference, observations and uncertainty. If that path is unavailable, report visual verification as unavailable—never pretend to have seen an image. Do not delegate merely because an image exists.

Without vision, `render_see` text output includes CSS-pixel bounds and overflow measurements. Compare layout at relevant widths; investigate overflow and clipped controls, which may be intentional. These measurements do not establish contrast, occlusion, composition or aesthetic quality. Keep pixel verification marked unavailable when no eligible vision route exists. Ask a vision child for specific hierarchy, alignment and state defects tied to the artifact, rather than an unsupported taste score.
