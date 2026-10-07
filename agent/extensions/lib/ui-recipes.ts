/** Adaptable browser mechanics, with no generated brand, content or dependency install. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mountScrollReveal, mountScrollStory, mountUiModel } from '../../scripts/ui-motion-runtime.mjs';
import { studioFolder } from './design-studio.ts';
import { inspectAsset } from './asset-registry.ts';

export const UI_PATTERNS = ['scroll-reveal', 'scroll-story', 'three-model'] as const;
type Pattern = typeof UI_PATTERNS[number];
type Frames = Array<{ opacity?: number; transform?: string }>;
const selector = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[{};\\\n\r<>@]/.test(value)) throw Error(`${label} requires a bounded CSS selector without CSS declarations`);
  return value.trim();
};
const finite = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${label} must be finite in ${min}..${max}`);
  return value;
};
function frames(value: unknown): Frames {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw Error('keyframes needs 2..8 opacity/transform frames');
  return value.map(frame => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).some(key => !['opacity', 'transform'].includes(key))) throw Error('Frames support only opacity and transform; layout and arbitrary CSS are excluded');
    if (frame.opacity === undefined && frame.transform === undefined) throw Error('Each keyframe needs opacity or transform');
    if (frame.transform !== undefined && (typeof frame.transform !== 'string' || frame.transform.length > 240 || /url\(|[{};<>\n\r]/i.test(frame.transform))) throw Error('Invalid transform keyframe');
    return { ...(frame.opacity === undefined ? {} : { opacity: finite(frame.opacity, 1, 0, 1, 'opacity') }), ...(frame.transform === undefined ? {} : { transform: frame.transform }) };
  });
}
function easing(value: unknown): string {
  const text = value === undefined ? 'cubic-bezier(0.22, 1, 0.36, 1)' : String(value);
  if (/^(?:linear|ease|ease-in|ease-out|ease-in-out)$/.test(text)) return text;
  const match = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(text);
  if (!match || match.slice(1).some(n => !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 10) || Number(match[1]) < 0 || Number(match[1]) > 1 || Number(match[3]) < 0 || Number(match[3]) > 1) throw Error('Use a CSS easing name or finite cubic-bezier with x values in 0..1');
  return text;
}
const PLANS: Record<Pattern, { mechanism: string; inputs: string[]; checks: string[] }> = {
  'scroll-reveal': { mechanism: 'IntersectionObserver entrances with shared WAAPI timing; once per element, focus-safe and static under reduced motion.', inputs: ['selector', 'optional keyframes, durationMs and easing'], checks: ['Real content is readable before JavaScript and when it fails.', 'Capture entry and settled frames at phone and desktop widths; test focus during entry.', 'Use motion_inspect mode scroll on the served URL, then review pixels.'] },
  'scroll-story': { mechanism: 'Explicit transform/opacity tracks tied to section scroll progress; one passive scroll owner and frame-coalesced updates. Mobile and reduced-motion retain normal document flow.', inputs: ['section', 'tracks with selector/keyframes/start/end', 'optional stickySelector and mobileBelow'], checks: ['Write the narrative/content first; every chapter and control remains reachable without pinning.', 'Keep text/controls outside opacity tracks; verify forward and backward scroll plus resize.', 'Inspect reduced motion and breakpoint neighbors with ui_explore and motion_inspect mode scroll.'] },
  'three-model': { mechanism: 'Local glTF preflight followed by an on-demand Three.js renderer. Fits camera bounds, caps DPR, skips invisible/hidden rendering, preserves a host-authored fallback and disposes owned GPU resources.', inputs: ['assetPath (local glTF/GLB)', 'modelUrl (actual served asset URL)', 'optional scrollSection, maxDpr and rotation range'], checks: ['Inspect the existing package/import-map version; keep Three.js and its GLTFLoader at the same version.', 'Retain a real static image and accessible content when loading/WebGL fails.', 'Test real model loading, mobile memory/frame cost, resize, reduced motion, unmount and WebGL context loss.', 'Compressed assets require configured loaders; source inspection does not prove appearance.'] },
};

export async function uiRecipe(params: any, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const action = params.action ?? 'plan';
  if (!['plan', 'scaffold'].includes(action)) throw Error('ui_recipe action must be plan or scaffold');
  if (params.pattern === undefined && action === 'plan') return { action, patterns: UI_PATTERNS.map(pattern => ({ pattern, ...PLANS[pattern] })), principle: 'Choose from the actual narrative and project constraints. References inform composition and motion, never a copied brand or category template.', tools: ['creative_direct', 'ui_explore', 'motion_inspect', 'ui_consistency', 'asset_register', 'image_generate'] };
  if (!(UI_PATTERNS as readonly string[]).includes(params.pattern)) throw Error(`pattern must be ${UI_PATTERNS.join(', ')}`);
  const pattern: Pattern = params.pattern;
  let asset: any;
  if (params.assetPath !== undefined) {
    if (typeof params.assetPath !== 'string' || !/\.(gltf|glb)$/i.test(params.assetPath)) throw Error('assetPath requires local glTF/GLB');
    asset = await inspectAsset({ path: params.assetPath }, cwd, signal);
  }
  const plan = { action, pattern, ...PLANS[pattern], ...(asset ? { asset } : {}), network: 'No installation, generation, upload or rendering performed.', visualIdentity: 'Use the project content, palette, typography, spacing and motion tokens. No stock hero, ornamental defaults, fabricated proof or AI status chrome.', referenceUse: 'Record the transferable layout/motion principle and why it fits this brief; do not copy a reference site.', verification: { status: 'prepared', appearance: 'unverified', interaction: 'unverified' } };
  if (action === 'plan') return plan;
  let config: any, runtime: Function, integration: string, css = '';
  if (pattern === 'scroll-reveal') {
    config = { selector: selector(params.selector, 'selector'), keyframes: frames(params.keyframes ?? [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }]), durationMs: finite(params.durationMs, 420, 80, 1600, 'durationMs'), easing: easing(params.easing) };
    runtime = mountScrollReveal; integration = 'Call mount(document) after real content is mounted; call handle.refresh() after adding targets and handle.dispose() before replacing the route.';
  } else if (pattern === 'scroll-story') {
    if (!Array.isArray(params.tracks) || params.tracks.length < 1 || params.tracks.length > 12) throw Error('scroll-story needs 1..12 authored tracks');
    const tracks = params.tracks.map((track: any) => {
      const start = finite(track.start, 0, 0, 1, 'start'), end = finite(track.end, 1, 0, 1, 'end');
      if (end <= start) throw Error('Track end must exceed start');
      return { selector: selector(track.selector, 'track selector'), keyframes: frames(track.keyframes), start, end, easing: easing(track.easing ?? 'linear') };
    });
    if (new Set(tracks.map((track: any) => track.selector)).size !== tracks.length) throw Error('Each track must own a distinct selector; merge transforms on one target');
    config = { section: selector(params.section, 'section'), tracks, mobileBelow: finite(params.mobileBelow, 768, 320, 1600, 'mobileBelow') };
    if (params.stickySelector !== undefined) {
      const sticky = selector(params.stickySelector, 'stickySelector');
      css = `@media (min-width: ${config.mobileBelow}px) and (prefers-reduced-motion: no-preference) {\n  ${config.section} { min-block-size: 240svh; }\n  ${sticky} { position: sticky; inset-block-start: 0; }\n}\n`;
    }
    runtime = mountScrollStory; integration = 'Keep the section and every chapter semantic and readable in normal flow. Import the optional sticky CSS only when pinning serves the narrative. Mount once, refresh on target changes, dispose on route unmount.';
  } else {
    if (!asset) throw Error('three-model scaffold needs assetPath for current local glTF preflight');
    const extensions = asset.extensionsRequired ?? [];
    if (extensions.some((extension: string) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension))) throw Error('Model requires decoder loaders. Use the preflight extension list to configure the existing GLTFLoader explicitly or export a plain GLB before scaffolding. Asset is preserved.');
    if (typeof params.modelUrl !== 'string' || !params.modelUrl || params.modelUrl.length > 2048 || /^(?:data|javascript|file):/i.test(params.modelUrl)) throw Error('modelUrl must be the actual served relative or HTTP(S) model URL');
    if (/^[a-z]+:/i.test(params.modelUrl) && !/^https?:/i.test(params.modelUrl)) throw Error('modelUrl requires relative or HTTP(S) URL');
    if (/^https?:/i.test(params.modelUrl)) { const url = new URL(params.modelUrl); if (url.username || url.password) throw Error('modelUrl must not embed credentials'); }
    config = { modelUrl: params.modelUrl, maxDpr: finite(params.maxDpr, 1.5, 1, 2, 'maxDpr'), rotationFrom: finite(params.rotationFrom, 0, -Math.PI * 4, Math.PI * 4, 'rotationFrom'), rotationTo: finite(params.rotationTo, Math.PI * 0.75, -Math.PI * 4, Math.PI * 4, 'rotationTo'), ...(params.scrollSection ? { scrollSection: selector(params.scrollSection, 'scrollSection') } : {}) };
    runtime = mountUiModel; integration = 'Import Three.js and GLTFLoader from the project matching version; const handle = mount(container, { THREE, GLTFLoader }); await handle.ready. Keep a real poster and accessible content in host markup outside the owned canvas. Provide container dimensions via project CSS; dispose the handle before unmount, including while loading.';
  }
  signal?.throwIfAborted();
  const dir = await studioFolder(params.outputDir, cwd, 'ui-recipe');
  try {
    const code = `const mounts = new WeakMap();\nexport const config = ${JSON.stringify(config, null, 2)};\n${runtime.toString()}\nexport const mount = ${pattern === 'three-model' ? '(element, modules) => mountUiModel(element, config, modules)' : `(root = document) => ${runtime.name}(root, config)`};\n`;
    const outputs = [['ui-motion.mjs', code], ...(css ? [['ui-motion.css', css]] : [])];
    const files: any[] = [];
    for (const [name, bytes] of outputs) { signal?.throwIfAborted(); const file = path.join(dir, name); await fs.writeFile(file, bytes, { flag: 'wx' }); files.push({ path: path.relative(cwd, file), bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }); }
    signal?.throwIfAborted();
    const receipt = { ...plan, action: 'scaffold', config, files, integration, next: pattern === 'three-model' ? 'Verify the served GLB/Three.js path and WebGL fallback; inspect real viewport pixels before approval.' : 'Adapt to the page narrative, run on the real served URL and inspect scroll/reduced-motion/mobile states. Generated code is prepared, not verified in the target app.' };
    await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
