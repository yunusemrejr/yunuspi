#!/usr/bin/env node
// Derive a palette from one accent hue instead of guessing hex values. Zero dependencies.
//
//   node palette.mjs --hue 48 --mood vivid --bias warm --harmony split --dark
//   node palette.mjs --hue 215 --chroma 0.09 --bias 215 --json
//
// Colors are built in OKLCH (perceptual lightness, so equal steps look equal), mapped into the sRGB gamut by
// reducing chroma, and every text role is searched until it meets the contrast target. The report lists each
// pair so the numbers can be quoted as evidence. The two house defaults (indigo-to-purple, cream with terracotta)
// are flagged, not forbidden: if the user asked for one, pass --allow-default.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

function oklchToLinear(L, C, hDeg) {
	const h = (hDeg * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
const gamma = (c) => { c = clamp(c, 0, 1); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const hex = (rgb) => `#${rgb.map((c) => Math.round(gamma(c) * 255).toString(16).padStart(2, "0")).join("")}`;

/** OKLCH to a hex string, reducing chroma until the color is inside sRGB. */
export function oklchToHex(L, C, h) {
	let rgb = oklchToLinear(L, C, h);
	if (!inGamut(rgb)) {
		let lo = 0, hi = C;
		for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; (inGamut(oklchToLinear(L, mid, h)) ? (lo = mid) : (hi = mid)); }
		rgb = oklchToLinear(L, lo, h);
	}
	return hex(rgb);
}
const luminance = (hexColor) => {
	const n = parseInt(hexColor.slice(1), 16), lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
/** WCAG 2 contrast ratio of two hex colors. */
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** Move L away from the background until `target` is met (text colors only). */
function legible(L, C, h, against, target, direction) {
	let l = L, color = oklchToHex(l, C, h);
	for (let i = 0; i < 120 && contrast(color, against) < target; i++) { l = clamp(l + direction * 0.01, 0.02, 0.99); color = oklchToHex(l, C, h); }
	return color;
}

const MOODS = { vivid: { chroma: 0.19, lift: 0.62 }, soft: { chroma: 0.11, lift: 0.7 }, deep: { chroma: 0.15, lift: 0.46 }, muted: { chroma: 0.06, lift: 0.58 } };
const HARMONIES = { mono: [0], analogous: [-32, 32], complement: [180], split: [150, 210], triad: [120, 240] };
const BIAS = { warm: 65, cool: 245 };
const wrap = (h) => ((h % 360) + 360) % 360;

/** Build the light (and optionally dark) token set. Pure and deterministic. */
export function derivePalette({ hue, chroma, mood = "vivid", bias = "accent", harmony = "analogous", target = 4.5, dark = false } = {}) {
	if (!Number.isFinite(hue)) throw new Error("hue (0-360) is required");
	const m = MOODS[mood] ?? MOODS.vivid, C = clamp(chroma ?? m.chroma, 0.02, 0.32), H = wrap(hue);
	const nHue = bias === "accent" ? H : BIAS[bias] ?? (Number.isFinite(Number(bias)) ? wrap(Number(bias)) : H);
	const nC = 0.012;
	const theme = (isDark) => {
		const bg = oklchToHex(isDark ? 0.17 : 0.975, nC, nHue), surface = oklchToHex(isDark ? 0.215 : 0.995, nC, nHue);
		const surface2 = oklchToHex(isDark ? 0.255 : 0.945, nC, nHue), line = oklchToHex(isDark ? 0.33 : 0.89, nC, nHue);
		const dir = isDark ? 1 : -1;
		const ink = legible(isDark ? 0.96 : 0.22, nC, nHue, bg, 12, dir), ink2 = legible(isDark ? 0.86 : 0.38, nC, nHue, bg, 7, dir), muted = legible(isDark ? 0.74 : 0.5, nC, nHue, bg, target, dir);
		let accentL = isDark ? clamp(m.lift + 0.1, 0.55, 0.85) : m.lift;
		let accent = oklchToHex(accentL, C, H);
		// Text on the accent is white or near-black, whichever reads better; nudge the accent until it clears the target.
		const light = "#ffffff", darkInk = oklchToHex(0.18, nC, nHue);
		let accentInk = contrast(light, accent) >= contrast(darkInk, accent) ? light : darkInk;
		for (let i = 0; i < 120 && contrast(accentInk, accent) < target; i++) { accentL = clamp(accentL + (accentInk === light ? -0.01 : 0.01), 0.1, 0.95); accent = oklchToHex(accentL, C, H); }
		const link = legible(accentL, C, H, bg, target, dir);
		const roles = { bg, surface, "surface-2": surface2, line, ink, "ink-2": ink2, muted, accent, "accent-ink": accentInk, link, "accent-wash": oklchToHex(isDark ? 0.27 : 0.94, Math.min(C, 0.05), H) };
		const hues = HARMONIES[harmony] ?? HARMONIES.analogous;
		hues.slice(0, 2).forEach((offset, i) => { roles[i === 0 ? "accent-2" : "accent-3"] = legible(isDark ? 0.74 : 0.5, harmony === "mono" ? C * 0.6 : C, wrap(H + offset), bg, target, dir); });
		return roles;
	};
	const light = theme(false), result = { hue: H, neutralHue: nHue, chroma: C, mood, harmony, light };
	if (dark) result.dark = theme(true);
	result.ramps = {
		neutral: [0.985, 0.95, 0.9, 0.82, 0.7, 0.58, 0.46, 0.36, 0.28, 0.2, 0.15, 0.1].map((l) => oklchToHex(l, nC, nHue)),
		accent: [0.96, 0.9, 0.82, 0.74, m.lift, 0.54, 0.46, 0.38, 0.3].map((l) => oklchToHex(l, C, H)),
	};
	result.report = [];
	const pairs = (name, t) => [["ink", "bg"], ["ink-2", "bg"], ["muted", "bg"], ["link", "bg"], ["ink", "surface"], ["accent-ink", "accent"]]
		.map(([fg, bg]) => ({ theme: name, fg, bg, ratio: Math.round(contrast(t[fg], t[bg]) * 100) / 100 }))
		.map((row) => ({ ...row, aa: row.ratio >= 4.5, aaa: row.ratio >= 7 }));
	result.report.push(...pairs("light", light));
	if (result.dark) result.report.push(...pairs("dark", result.dark));
	result.flags = houseDefaultFlags(result);
	return result;
}

/** Advisory: the two looks every unprompted model converges on. */
export function houseDefaultFlags({ hue, chroma, light }) {
	const flags = [];
	if (hue >= 255 && hue <= 330 && chroma >= 0.12) flags.push("accent sits in the indigo-to-purple band every default SaaS page uses; choose it only if the subject or the user asks for it");
	const bgWarm = light && light.bg > "#f5f0e0" && light.bg < "#fffbee" && parseInt(light.bg.slice(1, 3), 16) > parseInt(light.bg.slice(5, 7), 16) + 8;
	if (bgWarm && hue >= 20 && hue <= 55) flags.push("cream background with a terracotta/rust accent is the second house default; derive the neutral and accent from the subject instead");
	return flags;
}

/** CSS custom properties for the tokens, light first and dark behind the media query and a data attribute. */
export function paletteCss(p, prefix = "") {
	const block = (roles, indent = "\t") => Object.entries(roles).map(([k, v]) => `${indent}--${prefix}${k}: ${v};`).join("\n");
	const out = [`:root {\n${block(p.light)}\n}`];
	if (p.dark) {
		out.push(`@media (prefers-color-scheme: dark) {\n\t:root:not([data-theme="light"]) {\n${block(p.dark, "\t\t")}\n\t}\n}`);
		out.push(`:root[data-theme="dark"] {\n${block(p.dark)}\n}`);
	}
	return out.join("\n");
}

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2), next = argv[i + 1];
		if (["dark", "json", "allow-default", "help"].includes(key)) o[key] = true;
		else { o[key] = next; i++; }
	}
	return o;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const a = parseArgs(process.argv.slice(2));
	if (a.help || a.hue === undefined) {
		console.log("usage: palette.mjs --hue <0-360> [--chroma 0.02-0.32] [--mood vivid|soft|deep|muted] [--bias accent|warm|cool|<hue>] [--harmony mono|analogous|complement|split|triad] [--target 4.5|7] [--dark] [--json] [--allow-default]");
		process.exit(a.help ? 0 : 1);
	}
	const p = derivePalette({ hue: Number(a.hue), chroma: a.chroma === undefined ? undefined : Number(a.chroma), mood: a.mood, bias: a.bias, harmony: a.harmony, target: a.target ? Number(a.target) : 4.5, dark: Boolean(a.dark) });
	if (a.json) console.log(JSON.stringify(p, null, 2));
	else {
		console.log(paletteCss(p));
		console.log("\n/* contrast */");
		for (const r of p.report) console.log(`/* ${r.theme.padEnd(5)} ${r.fg} on ${r.bg}: ${r.ratio}${r.aaa ? " AAA" : r.aa ? " AA" : " FAIL"} */`);
	}
	if (p.flags.length && !a["allow-default"]) for (const f of p.flags) console.error(`warning: ${f}`);
}
