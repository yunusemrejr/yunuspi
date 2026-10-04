# Living things: characters and live models of the product

Two signatures that make a page feel inhabited. Both are small state machines with a still fallback.

## A character with behavior

A character earns its place when it reacts: it looks where you point, blinks on its own schedule, squashes when poked, and changes mood with what the page is doing. Without reactions it is a sticker.

**States:** `idle` (breathing, blinks every 2 to 6 s), `look` (eyes and head follow the pointer, clamped), `react` (poke, hover, success, error), `rest` (after a long pause, slower). Keep the set small and name every transition.

```js
const mascot = document.querySelector("#mascot"), eyes = mascot.querySelector("[data-eyes]");
const squash = spring({ k: 220, c: 11 }), look = { x: spring({ k: 120, c: 16 }), y: spring({ k: 120, c: 16 }) };
let last = performance.now(), blinkAt = last + 2000 + Math.random() * 4000, running = false;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (now > blinkAt) { mascot.classList.add("blink"); setTimeout(() => mascot.classList.remove("blink"), 120); blinkAt = now + 2000 + Math.random() * 4000; }
  const s = 1 + squash.step(dt) * 0.12; eyes.style.transform = `translate(${look.x.step(dt) * 6}px, ${look.y.step(dt) * 4}px)`;
  mascot.style.transform = `scale(${1 / s}, ${s})`;
  if (!(squash.settled && look.x.settled && look.y.settled)) requestAnimationFrame(frame); else running = false;
}
const wake = () => { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } };
addEventListener("pointermove", (e) => { const r = mascot.getBoundingClientRect(); look.x.set(Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400))); look.y.set(Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 400))); wake(); });
mascot.addEventListener("click", () => { squash.set(1); wake(); setTimeout(() => squash.set(0), 90); });
```

Wrap the character in a `<button>` with a visible focus ring and an accessible name so the poke is reachable by keyboard; under reduced motion skip look-tracking and show the still pose.

**Where the art comes from:** hand-built SVG (separate groups for body, eyes, mouth so states can move them); glossy 3D looks rendered once with `blender_render` and exported as WebP with alpha, one image per state, swapped on transition; `image_generate` for concepts, then redraw or render for consistency. Fix the character's proportions, palette (from `palette.mjs`) and lighting once and reuse them for every state. Review the character at its real display size, on the page's background.

## A live model of the product

When the product computes something, show it computing. A visitor trying a tiny working version understands more than a paragraph can say.

- **Real model, small inputs.** Three to five inputs, one output that changes visibly. Label it as an illustrative example and use a fixed seed so the same inputs give the same result.
- **Deterministic.** Seed a PRNG (`mulberry32` is in `world-kit.mjs`) so screenshots and tests are stable.
- **Do not freeze the page.** Run heavy sampling in a Worker built from a Blob, or in chunks between frames, and show the previous result until the new one is ready.
- **Draw it as data:** an SVG histogram or line (`<rect>` or `<path>` driven by numbers), not a screenshot; mark the percentile or selection the user chose.
- **State in the URL hash** so a result can be shared and a capture can open a specific state.
- **Accessible twin:** the same numbers in a visually hidden or collapsible table, and the result in an `aria-live="polite"` region.
- **Fallback:** a precomputed example rendered in HTML.

```js
// sample n outcomes from three triangular-ish ranges and report percentiles
function simulate(ranges, n = 4000, seed = 1) {
  const rnd = mulberry32(seed), totals = new Float64Array(n);
  for (let i = 0; i < n; i++) { let t = 0; for (const [lo, mode, hi] of ranges) { const u = rnd(), c = (mode - lo) / (hi - lo); t += u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode)); } totals[i] = t; }
  totals.sort(); return { p50: totals[n * 0.5 | 0], p80: totals[n * 0.8 | 0], p90: totals[n * 0.9 | 0], totals };
}
```

Never invent numbers and present them as facts: an example that looks real must say it is an example, and any claim about accuracy needs a source.

## Verify

Capture the idle pose and one reaction state, hover and focus the character with `browser_session`, confirm reduced motion shows the still, and for a model change an input and confirm the output and the table change together.
