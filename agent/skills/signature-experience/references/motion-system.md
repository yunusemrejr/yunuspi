# A motion system

Motion reads as one voice when durations, easings and springs come from a small set, every moving thing has one owner and a job, and reduced motion has a real answer.

## Tokens

```css
:root {
  --dur-1: 120ms; --dur-2: 220ms; --dur-3: 400ms; --dur-4: 700ms;   /* feedback, state, entrance, scene */
  --ease-out: cubic-bezier(.2, .8, .2, 1);       /* things arriving */
  --ease-in-out: cubic-bezier(.6, 0, .2, 1);     /* things travelling */
  --ease-spring: linear(0, .42 8%, .92 22%, 1.06 34%, 1.02 48%, 1);  /* settles with a small overshoot */
}
@media (prefers-reduced-motion: reduce) { :root { --dur-1: 1ms; --dur-2: 1ms; --dur-3: 1ms; --dur-4: 1ms; } }
```

Animate `transform` and `opacity`; never `top`, `left`, `width` or `height` in a loop. Use `will-change` only on elements that are about to move.

## Springs, for things that should feel physical (mascots, drag, magnetic hover)

```js
export function spring({ k = 170, c = 14, mass = 1 } = {}) {
  let x = 0, v = 0, target = 0;
  return {
    set(t) { target = t; }, get value() { return x; },
    step(dt) { const a = (-k * (x - target) - c * v) / mass; v += a * dt; x += v * dt; return x; },
    get settled() { return Math.abs(v) < 0.001 && Math.abs(x - target) < 0.001; },
  };
}
```

Drive it from one `requestAnimationFrame` loop that stops when everything is settled. Lower `c` for bounce, raise `k` for snap.

## Entrance choreography

```css
[data-reveal] { opacity: 0; transform: translateY(14px); transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out); transition-delay: calc(var(--i, 0) * 60ms); }
[data-reveal].is-in { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { [data-reveal] { opacity: 1; transform: none; transition: none; } }
```

```js
const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -10% 0px" });
document.querySelectorAll("[data-reveal]").forEach((el, i) => { el.style.setProperty("--i", i % 6); io.observe(el); });
```

If JavaScript fails the content must still show: set the hidden state only under a `.js` class added by an inline script.

## Scroll-linked motion

Native first, with a fallback that does the same job:

```css
@supports (animation-timeline: view()) {
  .scene .layer { animation: drift linear both; animation-timeline: view(); animation-range: entry 0% cover 60%; }
  @keyframes drift { from { transform: translateY(8vh) scale(.96); opacity: 0 } to { transform: none; opacity: 1 } }
}
```

Without support, fall back to the IntersectionObserver reveal above, or compute progress `p = clamp((vh - rect.top) / (vh + rect.height), 0, 1)` in one passive scroll listener and write it to a CSS variable. A pinned scene is a tall wrapper with a `position: sticky` child; the wrapper's height is the scroll time. Normalize progress to 0..1 and let the animation read only that number.

## Kinetic type that stays accessible

```js
function splitLetters(el) {
  const text = el.textContent; el.setAttribute("aria-label", text); el.textContent = "";
  [...text].forEach((ch, i) => { const s = document.createElement("span"); s.setAttribute("aria-hidden", "true"); s.textContent = ch === " " ? " " : ch; s.style.setProperty("--i", i); el.append(s); });
}
```

With a variable font, animate an axis instead of position: `font-variation-settings: "wght" 400` to `"wght" 800` on hover or with pointer distance, which costs layout but is cheap on short headings. Respect reduced motion by skipping the effect.

## Page transitions

Same-document: `document.startViewTransition(() => update())` with `::view-transition-old(root)` and `::view-transition-new(root)` styled with the tokens. Multi-page: `@view-transition { navigation: auto; }`. Guard with `if (!document.startViewTransition) update()`.

## Marquee

Duplicate the track content once, animate `transform: translateX(-50%)` linearly, pause on hover and under reduced motion. Never put essential copy in it.

## Sound

```js
let ctx, muted = localStorage.getItem("sound") !== "on";
export const soundToggle = () => { muted = !muted; localStorage.setItem("sound", muted ? "off" : "on"); if (!muted) (ctx ??= new AudioContext()).resume(); };
export function blip(freq = 660, ms = 90) {
  if (muted || !ctx) return; const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = freq; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + ms / 1000 + 0.02);
}
```

An `AudioContext` may only start after a user gesture. Sound is off until the visitor turns it on, the toggle is visible and labelled, and nothing depends on hearing it.

## Rules that keep it one voice

One timeline owner per property. Every animation has a job (feedback, state, navigation, narrative). Ambient loops are low amplitude and pause when hidden or off screen. Under `prefers-reduced-motion` keep the layout and the information, drop the movement. Check with `motion_inspect` for CSS and WAAPI, and with two captures a second apart for rAF and WebGL motion.
