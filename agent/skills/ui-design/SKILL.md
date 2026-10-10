---
name: ui-design
description: "Design, critique and verify product UI, UX, dashboards, web pages, desktop apps and key visuals: palettes, WCAG contrast, dark mode, type, spacing, states, copy, anti-AI-slop tells, Electron, Tauri and desktop conventions, render checks."
---

## Ground and anti-slop
- Ground in the subject: product, audience, the screen's one job; derive choices from that, not the SaaS median.
- Swap test: if the headline and logo fit an unrelated company, redo it. One point of view per page.
- Banned as defaults: indigo-to-pink gradients, cream-terracotta-serif, the Inter/Geist/Space Grotesk rotation. Allowed only when asked or brand-owned.
- Cut ornament without a job: side stripes, dots, blur blobs, glows, gradient text, glass, icon tiles, emoji, fake terminals, pill/hype badges, unbacked LIVE/NEW labels, 80px+ type, giant radii, carousels.
- Stock layouts (trusted-by, identical cards, FAQ) and centered-everything: tells.

## Copy
- Value line: outcome for who, in their words. Numbers need a stated base; invent no metrics, logos or quotes.
- CTA: verb plus outcome, never "Submit", "OK" or "Click here"; one primary CTA per screen.
- Errors: what happened, why, the fix. Confirms name the object and count. No build or framework talk unless docs.

## Color
- Neutrals first: one hue-tinted oklch ramp (chroma ~0.005-0.01), 5-7 steps. Say why that hue.
- One brand accent for action, links and focus. Success, warning, danger, info: tint plus text-on-tint.
- Contrast: text 4.5:1; large text, icons, borders, focus rings 3:1; measured on the real background.
- Never color alone for status; saturation in small accents; grayscale must keep the hierarchy.
- Dark mode is a remap: base near #0f-#1a, not black; lighter surfaces elevate; muted accents; ~88% white text; on-dark links.

## Type
- Two families max (display, text); mono only for code. Pick one you would not reuse elsewhere.
- Body 16px+ at 1.5-1.6; display 1.0-1.2; prose 45-75ch; rem units, never px on interactive text.
- 3-4 size steps per view, ratio 1.2-1.33. Self-host woff2, font-display swap, metric-matched fallback; tnum for tables.

## Layout and spacing
- One focal element and primary action per view; rank by size, weight, space before color.
- 4/8pt grid: related 8-12px apart, unrelated 24-40px, sections 64-128px. Proximity beats borders: drop a border, double the gap.
- One elevation language per product (flat, hairline or soft shadow), never mixed.
- Phone: one column, one primary action, sticky CTA, 44px touch targets.
- Key visual: one hero form (ideally brand mark), one light, deep darks, near-white highlight, soft shadow.

## Components and states
- Interactive surfaces ship default, hover, focus-visible, disabled, loading, error and empty states.
- Three token tiers (primitive, semantic, component); components read semantic tokens only, never raw hex; dark mode re-maps them.
- Few variants, composition over boolean props, keyboard path, accessible name on every control.
- Motion confirms an action: 100-300ms ease-out, transform and opacity only; reduced motion keeps information.

## Desktop
- Every action has a keyboard path; menus show accelerators (Ctrl/Cmd+N, W, S, Z, F, P, Q; Cmd+, is macOS only).
- Native open and save dialogs; remember window size and position; one running instance.
- macOS: traffic lights stay top-left; Cmd+Q quits. Windows: caption controls right, DPI-safe at 125 and 150%.
- Linux: GNOME header bars or KDE title bars, never a fake one; global shortcuts flaky on Wayland.
- Tray item offers Open and Quit. Status is an indicator, not a toast; toasts sit bottom, 4-8s, max 3. Undo beats confirm.

## App builds
- Electron: web teams needing OS integration. Tauri: small, Rust backend. Native: performance-critical.
- Electron: contextIsolation on, nodeIntegration off, sandbox on, minimal contextBridge, native .node files asarUnpacked.
- Tauri: least-privilege capabilities, path-scoped files. Sign and notarize macOS, sign Windows, test the packaged build.

## Verify by rendering
- render_see: "text" for DOM and overflow bounds, "both" adds pixels; colorScheme dark and reducedMotion reduce. browser_session covers hover and keyboard.
- Check 360-390px and 1440px, empty, loading and error states, a keyboard Tab walk, contrast on real surfaces.
- Desktop: bg_run the real entrypoint, confirm the window (xdotool or screenshot), drive keys, read bg_logs.
- No vision? Say so. DOM bounds prove overflow, not contrast or taste.
