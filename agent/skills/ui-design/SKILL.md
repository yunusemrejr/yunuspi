---
name: ui-design
description: "Design, critique and verify product UI/UX, dashboards, web pages, desktop apps and key visuals: palettes, WCAG contrast, dark mode, type, spacing, states, copy, anti-AI-slop tells, Electron, Tauri, desktop conventions, render checks."
---

# UI design (consolidated — see also `create` hub)

## Ground and anti-slop
- Ground every choice in the actual product, audience and content; no stock hero, gradient or card-grid defaults.
- One spacing scale, 3 type roles, 2–3 colors, one radius, two shadows. Remove one element per pass until it breaks, then step back.

## Swap test
- Swap the brand, headline and palette with a competitor's: if the page still "works", it says nothing — rewrite until it only fits this product.

## Banned as defaults
- Purple-blue gradients, glassmorphism, generic 3-card features, lorem-style copy, stock icon rows, centered everything. Use only when the subject truly calls for them.

## Verify by rendering
- Render at 320px, tablet and desktop; check contrast (WCAG), focus order, reduced motion and real content lengths before claiming done.
