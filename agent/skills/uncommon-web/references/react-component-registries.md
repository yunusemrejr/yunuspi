# React component registries

Copy-in component collections in the shadcn mold, plus the small React primitives everyone ends up using.

8 libraries, from Uncommon Web (webdev.teknium.io, field guide vol. 1, October 2026). Versions are the ones shown there: check the current release before installing.

- **React Bits**: Animated, interactive React components you install as source `npx shadcn@latest add @react-bits/Dither-TS-TW` ; `npx shadcn@latest add @react-bits/SplitText-TS-TW @react-bits/ShinyText-TS-TW @react-bits/Magnet-TS-TW @react-bits/ClickSpark-TS-TW @react-bits/DecryptedText-TS-TW` · MIT + Commons Clause vregistry 2026-10-22 (Dither-TS-TW) · [source](https://github.com/DavidHDev/react-bits) · [demo 1](https://webdev.teknium.io/d/react/demos/reactbits-dither/) [demo 2](https://webdev.teknium.io/d/react/demos/reactbits-text-fx/)
- **Magic UI**: Animated landing-page components for shadcn/ui and Motion `npx shadcn@latest add @magicui/animated-beam @magicui/border-beam @magicui/number-ticker @magicui/flickering-grid` · MIT vregistry 2026-10-22 (motion 12.43.0) · [source](https://github.com/magicuidesign/magicui) · [demo](https://webdev.teknium.io/d/react/demos/magicui-beams/)
- **Aceternity UI**: Copy-paste Tailwind + Motion effects for landing pages `npx shadcn@latest add @aceternity/3d-card @aceternity/background-beams @aceternity/spotlight-new @aceternity/text-generate-effect` · Aceternity License (free components; no redistribution as a library) vregistry 2026-10-22 (motion 12.43.0) · [demo](https://webdev.teknium.io/d/react/demos/aceternity-3d-card/)
- **Animate UI**: Fully animated React primitives and components distribution `npx shadcn@latest add @animate-ui/components-backgrounds-bubble @animate-ui/primitives-texts-sliding-number @animate-ui/primitives-texts-rotating @animate-ui/primitives-texts-highlight` · MIT + Commons Clause vregistry 2026-10-22 (motion 12.43.0) · [source](https://github.com/imskyleen/animate-ui) · [demo](https://webdev.teknium.io/d/react/demos/animate-ui-bubble/)
- **Motion Primitives**: UI kit of motion components for React, built on Motion `npx shadcn@latest add @motion-primitives/morphing-dialog @motion-primitives/text-effect @motion-primitives/text-shimmer @motion-primitives/border-trail @motion-primitives/infinite-slider` · MIT vregistry 2026-10-22 (motion 12.43.0) · [source](https://github.com/ibelick/motion-primitives) · [demo](https://webdev.teknium.io/d/react/demos/motion-primitives-morph/)
- **Sonner**: An opinionated toast component for React `npm i sonner` · MIT v2.0.8 · [source](https://github.com/emilkowalski/sonner) · [demo](https://webdev.teknium.io/d/react/demos/sonner-toasts/)
- **Vaul**: Unstyled, draggable drawer component for React `npm i vaul` · MIT v1.1.2 · [source](https://github.com/emilkowalski/vaul) · [demo](https://webdev.teknium.io/d/react/demos/vaul-drawer/)
- **cmdk**: Fast, unstyled, composable command menu for React `npm i cmdk` · MIT v1.1.1 · [source](https://github.com/dip/cmdk) · [demo](https://webdev.teknium.io/d/react/demos/cmdk-palette/)

## Checked by hand, 27 Nov 2026

Outside the field guide; licences and versions as read on that date.

- **shadcn/ui registry and MCP**: the CLI copies a component's source from any registry into the repo, and `npx shadcn@latest mcp` (an install: only with the owner's OK at that moment) lets an agent search and read the registries named in `components.json` (React Bits, Magic UI, coss ui and Kibo UI are such registries) · MIT · [docs](https://ui.shadcn.com/docs/mcp), index at `ui.shadcn.com/llms.txt`
- **21st.dev**: 12,000+ community components, shaders and templates with previews · licence per component (many MIT) · browsing is free; fetching source through its MCP (`https://21st.dev/api/mcp`) needs an API key, and more than 2 copies a day needs a paid plan · [site](https://21st.dev/), index at `21st.dev/llms.txt`
- **coss ui** (formerly Origin UI): accessible copy-in components on Base UI and Tailwind from the Cal.com team, strong on forms, inputs, tables and dialogs · MIT · registry `https://coss.com/ui/r/<name>.json` · [site](https://coss.com/ui)
- **Kibo UI**: a shadcn registry for the parts that are hard to write: colour picker, Gantt, Kanban, calendar, editor, code block · MIT · `npx shadcn@latest add https://www.kibo-ui.com/r/<name>.json` · [site](https://www.kibo-ui.com/)
- **Base UI**: unstyled primitives with complete keyboard and focus behaviour, by MUI; stable v1 since Dec 2025 · MIT · `npm i @base-ui/react` · [docs](https://base-ui.com/) with `.md` pages and `/llms.txt`
- **Ariakit**: unstyled accessible primitives (combobox, menu, dialog, composite widgets) · MIT, still 0.4.x · `npm i @ariakit/react` · [docs](https://ariakit.com/)
- **shadcn charts**: Recharts chart components to start from · MIT · [gallery](https://ui.shadcn.com/charts). Tremor, the older choice, has had no release since Jan 2025. Read `dataviz` before using either.
