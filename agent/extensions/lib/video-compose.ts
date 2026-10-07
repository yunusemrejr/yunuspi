/** Native storyboard authoring for video_project. Extends the existing master
 * timeline and renderer; the shared production kernel also drives validation. */
import { cameraAt, layerPose, smooth, type Layer, type CameraKey } from '../../skills/remotion-video/assets/template/src/production.ts';
export type ProductionIssue = { severity: 'error' | 'warn'; scene?: string; message: string };
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const pathOK = (p: unknown) => typeof p === 'string' && !!p && !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/[\x00-\x1f]|^[a-z]+:/i.test(p);
const colorOK = (c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const layouts = ['hero-left', 'hero-right', 'screen', 'full', 'type'];

/** Comfortable, responsive regions with reserved caption space. Deliberate
 * custom layering remains possible through explicit normalized boxes. */
export function storyboardLayers(scene: any, spec: any): Layer[] {
  if (scene.layers) return scene.layers;
  const layout = scene.layout ?? (scene.hero ? 'hero-right' : 'type');
  if (!layouts.includes(layout)) throw Error(`Unknown layout ${layout}`);
  const vertical = spec.height > spec.width, layers: Layer[] = [];
  const right = layout !== 'hero-left';
  const headlineBox: any = layout === 'screen' || layout === 'full' ? [.06, .07, .88, .12] : vertical ? [.07, .08, .86, .26] : layout === 'type' ? [.07, .12, .86, .63] : [right ? .06 : .55, .15, .39, .55];
  if (scene.headline) layers.push({ id: 'headline', kind: 'text', text: scene.headline, box: headlineBox, size: scene.size ?? (layout === 'screen' ? 70 : 144), reveal: 'lines', motion: { enter: 'none', cue: scene.headlineCue, at: Math.min(.12, scene.seconds*.08), duration: Math.min(.65, scene.seconds*.45), easing: 'snappy', stagger: .09 }, sound: 'none' });
  if (scene.kicker) layers.push({ id: 'kicker', kind: 'text', text: scene.kicker, box: layout === 'screen' || layout === 'full' ? [.06, .02, .88, .035] : vertical ? [.07, .025, .86, .04] : [headlineBox[0], .06, headlineBox[2], .06], font: 'mono', size: 26, color: scene.ink ?? spec.theme?.muted, motion: { enter: 'wipe', at: 0, duration: Math.min(.5, scene.seconds*.45) } });
  if (scene.hero) {
    const hero = scene.hero;
    const box: any = hero.box ?? (layout === 'screen' ? [.06, .21, .88, .61] : layout === 'full' ? (scene.headline ? [.03, .23, .94, .59] : [.03, .03, .94, .79]) : vertical ? [.07, .38, .86, .43] : [right ? .51 : .04, .08, .45, .75]);
    layers.push({ id: 'hero', ...hero, box, motion: hero.motion ?? { enter: 'pop', at: Math.min(.2, scene.seconds*.1), duration: Math.min(.8, scene.seconds*.5) } });
  }
  if (scene.footer) layers.push({ id: 'footer', kind: 'text', text: scene.footer, box: [.07, .84, .86, .07], font: 'text', size: 32, motion: { enter: 'rise', at: Math.min(.7, scene.seconds*.35), duration: Math.min(.5, scene.seconds*.35) } });
  return layers;
}

/** Pointer targets are smoothed offline, then sampled on the source clock.
 * Bounded lag reduces pointer jitter; crops never expose missing source pixels. */
export function followCamera(take: any, zoom = 1.8, lag = .35): CameraKey[] {
  if (!Array.isArray(take.eventLog) || !finite(take.width) || !finite(take.height) || take.width <= 0 || take.height <= 0) throw Error('Browser metadata needs positive width, height and eventLog');
  if (!finite(zoom) || zoom < 1 || zoom > 4 || !finite(lag) || lag < .05 || lag > 2) throw Error('follow zoom must be 1..4 and lag .05..2 seconds');
  // Selector targets describe the action's subject. Following an idle cursor
  // parked in empty space can crop away the entire interface. Use observed
  // target/click positions when available, pointer samples for freeform takes.
  const targets = take.eventLog.filter((e: any) => ['target','highlight','click','tap'].includes(e.kind) && finite(e.t) && finite(e.x) && finite(e.y));
  const events = (targets.length ? targets.map((e: any) => ({ ...e, x: e.x+(e.width ?? 0)/2, y: e.y+(e.height ?? 0)/2 })) : take.eventLog.filter((e: any) => e.kind === 'pointer' && finite(e.t) && finite(e.x) && finite(e.y))).sort((a: any,b: any) => a.t-b.t);
  if (!events.length) throw Error('Browser take has no observed pointer positions');
  const seconds = Number(take.seconds), keys: CameraKey[] = []; let x = .5, y = .5, z = 1, index = 0;
  if (!finite(seconds) || seconds <= 0 || seconds > 120) throw Error('Invalid browser take duration');
  for (let t = 0; t <= seconds + .05; t += .1) {
    while (index + 1 < events.length && events[index + 1].t <= t) index++;
    const p = events[index], target = t < p.t ? { x: .5, y: .5 } : { x: p.x / take.width, y: p.y / take.height };
    const blend = 1 - Math.exp(-.1 / lag); x += (target.x - x) * blend; y += (target.y - y) * blend;
    // Wide action subjects need a wider shot. A tight cursor crop must not
    // sever a highlighted heading or responsive card at the viewport edge.
    const fitted = Math.max(1, Math.min(zoom, p.width ? 1/(p.width/take.width+.1) : zoom, p.height ? 1/(p.height/take.height+.1) : zoom));
    const framedZoom = 1+(fitted-1)*smooth(t/.9); z += (framedZoom-z)*blend;
    const cropped = cameraAt([{ t, x, y, zoom: z }], t, { x: 0, y: 0 }); keys.push({ t: Number(t.toFixed(2)), ...cropped });
  }
  return keys;
}

export function validateProductionScene(scene: any): ProductionIssue[] {
  if (scene?.component !== 'StudioScene') return [];
  const issues: ProductionIssue[] = [], layers = scene.props?.layers;
  const add = (severity: 'error' | 'warn', message: string) => issues.push({ severity, scene: scene.id, message });
  if (!Array.isArray(layers) || !layers.length || layers.length > 48) { add('error', 'StudioScene needs 1..48 layers'); return issues; }
  const ids = new Set();
  for (const field of ['background', 'ink']) if (scene.props?.[field] !== undefined && !colorOK(scene.props[field])) add('error', `${field} must be #rrggbb`);
  for (const layer of layers) {
    if (!layer || typeof layer.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(layer.id) || ids.has(layer.id)) { add('error', 'Layers need distinct kebab-case ids'); continue; }
    ids.add(layer.id);
    const name = `Layer ${layer.id}`;
    if (!['text', 'image', 'video', 'shot', 'shape'].includes(layer.kind)) add('error', `${name}: unknown kind`);
    if (!Array.isArray(layer.box) || layer.box.length !== 4 || layer.box.some((v: any) => !finite(v)) || layer.box[2] <= 0 || layer.box[3] <= 0 || layer.box[0] < 0 || layer.box[1] < 0 || layer.box[0] + layer.box[2] > 1.001 || layer.box[1] + layer.box[3] > 1.001) { add('error', `${name}: box [x,y,w,h] must fit the canvas in fractions`); continue; }
    if (layer.kind === 'text' && (typeof layer.text !== 'string' || !layer.text.trim() || layer.text.length > 1000)) add('error', `${name}: text required (1..1000 characters)`);
    if (['image', 'video'].includes(layer.kind) && !pathOK(layer.src)) add('error', `${name}: src must be a relative public/ asset path`);
    if (layer.kind === 'shot' && (typeof layer.shot !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(layer.shot))) add('error', `${name}: valid shot id required`);
    if (layer.color !== undefined && !colorOK(layer.color)) add('error', `${name}: color must be #rrggbb`);
    for (const [field, lo, hi] of [['size', 14, 300], ['radius', 0, 200], ['startFrom', 0, 86400], ['speed', .1, 4]] as const) if (layer[field] !== undefined && (!finite(layer[field]) || layer[field] < lo || layer[field] > hi)) add('error', `${name}: invalid ${field}`);
    const motion = layer.motion ?? {};
    if (motion.easing && !['smooth', 'snappy', 'spring'].includes(motion.easing)) add('error', `${name}: unknown easing`);
    if (motion.stagger !== undefined && (!finite(motion.stagger) || motion.stagger < 0 || motion.stagger > 2)) add('error', `${name}: stagger must be 0..2 seconds`);
    if (motion.travel !== undefined && (!finite(motion.travel) || Math.abs(motion.travel) > 1)) add('error', `${name}: travel must be -1..1 canvas units`);
    if (layer.reveal && !['block', 'lines'].includes(layer.reveal)) add('error', `${name}: unknown text reveal`);
    if (motion.cue && !finite(scene.cues?.[motion.cue])) add('error', `${name}: missing cue ${motion.cue}`);
    if (motion.at !== undefined && (!finite(motion.at) || motion.at < 0 || motion.at >= scene.seconds)) add('error', `${name}: motion.at outside scene`);
    if (motion.duration !== undefined && (!finite(motion.duration) || motion.duration < .01 || motion.duration > scene.seconds)) add('error', `${name}: invalid motion.duration`);
    if (motion.enter && !['none', 'rise', 'slide', 'pop', 'wipe'].includes(motion.enter)) add('error', `${name}: unknown entrance`);
    for (const [keys, label] of [[motion.keys, 'motion'], [layer.camera, 'camera']] as const) if (keys !== undefined) {
      if (!Array.isArray(keys) || keys.length > (label === 'camera' ? 1202 : 64)) { add('error', `${name}: invalid ${label} keys`); continue; }
      let last = -1;
      for (const k of keys) {
        if (!k || !finite(k.t) || k.t <= last || k.t < 0 || k.t > (label === 'camera' ? 86400 : scene.seconds) || Object.values(k).some(v => !finite(v))) add('error', `${name}: ordered finite ${label} keys required`);
        last = k?.t ?? last;
        if (label === 'motion' && ((k.scale !== undefined && (k.scale <= 0 || k.scale > 5)) || (k.opacity !== undefined && (k.opacity < 0 || k.opacity > 1)))) add('error', `${name}: invalid scale/opacity`);
        if (label === 'camera' && (!finite(k.zoom) || k.zoom < 1 || k.zoom > 4 || !finite(k.x) || !finite(k.y))) add('error', `${name}: camera needs x, y, zoom 1..4`);
      }
    }
    if (layer.screen && (!pathOK(layer.screen.src) || layer.kind !== 'shot')) add('error', `${name}: tracked screen belongs to a shot and needs a public src`);
    if (layer.screen) for (const [field, lo, hi] of [['startFrom', 0, 86400], ['speed', .1, 4], ['width', 64, 3840], ['height', 64, 3840]] as const) if (layer.screen[field] !== undefined && (!finite(layer.screen[field]) || layer.screen[field] < lo || layer.screen[field] > hi)) add('error', `${name}: invalid screen.${field}`);
  }
  if (issues.some(i => i.severity === 'error')) return issues;
  const reported = new Set<string>();
  for (let k = 0; k < 24; k++) {
    const t = scene.seconds * (k + .5) / 24;
    const regions = layers.map((l: Layer) => {
      const p = layerPose(t, l.motion, scene.cues), [x, y, w, h] = l.box;
      const cw = w * p.scale, ch = h * p.scale;
      return { l, p, x: x + p.x + (w - cw) / 2, y: y + p.y + (h - ch) / 2, w: cw, h: ch };
    });
    for (const a of regions) if (a.p.opacity > .95 && t > (a.l.motion?.at ?? 0) + (a.l.motion?.duration ?? .65)) {
      if ((a.x < -.01 || a.y < -.01 || a.x + a.w > 1.01 || a.y + a.h > 1.01) && !reported.has(a.l.id)) { add('warn', `${a.l.id} leaves the canvas at ${t.toFixed(2)}s`); reported.add(a.l.id); }
      if (a.l.kind !== 'text') continue;
      for (const b of regions) if (a !== b && b.p.opacity > .95 && b.l.kind !== 'shape') {
        const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const pair = [a.l.id, b.l.id].sort().join('/');
        if (area > a.w * a.h * .08 && !reported.has(pair)) { add('warn', `Reserved text region ${a.l.id} overlaps ${b.l.id} at ${t.toFixed(2)}s; use separate regions or inspect an intentional overlay`); reported.add(pair); }
      }
    }
  }
  return issues;
}

export function compileStoryboard(input: any[], spec: any, append = false) {
  if (!Array.isArray(input) || !input.length || input.length > 2000) throw Error('compose needs 1..2000 scenes');
  const scenes = input.map(raw => {
    if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(raw.id) || !finite(raw.seconds) || raw.seconds < .5 || raw.seconds > 600) throw Error('Scenes need kebab-case id and seconds .5..600');
    const previous = (spec.scenes ?? []).find((s: any) => s.id === raw.id && s.narration === raw.narration);
    const timing = previous ? Object.fromEntries(['narrationAudio', 'narrationWords', 'narrationSeconds', 'narrationOffset'].filter(k => previous[k] !== undefined).map(k => [k, previous[k]])) : {};
    const { layers, hero, headline, kicker, footer, layout, background, ink, size, headlineCue, ...scene } = raw;
    return { ...timing, ...scene, component: 'StudioScene', props: { layers: storyboardLayers(raw, spec), background, ink }, transition: raw.transition ?? { type: 'none', seconds: .2 } };
  });
  const combined = append ? [...spec.scenes, ...scenes] : scenes;
  const ids = combined.map(s => s.id);
  if (new Set(ids).size !== ids.length) throw Error('Scene ids must be distinct; append does not replace an existing id');
  const issues = combined.flatMap(validateProductionScene);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length) throw Error(errors.map(e => `[${e.scene}] ${e.message}`).join('; '));
  return { scenes: combined, issues };
}
