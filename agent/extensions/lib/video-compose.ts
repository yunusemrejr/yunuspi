/** Native storyboard authoring for video_project. Extends the existing master
 * timeline and renderer; the shared production kernel also drives validation. */
import { cameraAt, cueTime, layerPose, smooth, type Layer, type CameraKey } from '../../skills/remotion-video/assets/template/src/production.ts';
export type ProductionIssue = { severity: 'error' | 'warn'; scene?: string; message: string };
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const pathOK = (p: unknown) => typeof p === 'string' && !!p && !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/[\x00-\x1f]|^[a-z]+:/i.test(p);
const colorOK = (c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const layouts = ['hero-left', 'hero-right', 'screen', 'full', 'type'];
const easings = ['linear', 'smooth', 'snappy', 'spring', 'hold'];
const pointsOK = (p: any, count: number | null, lo: number, hi: number) => Array.isArray(p) && (count === null ? p.length >= 2 && p.length <= 64 : p.length === count) && p.every((v: any) => Array.isArray(v) && v.length === 2 && v.every((n: any) => finite(n) && n >= lo && n <= hi));

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
    layers.push({ id: 'hero', role: 'hero', ...hero, box, motion: hero.motion ?? { enter: 'pop', at: Math.min(.2, scene.seconds*.1), duration: Math.min(.8, scene.seconds*.5) } });
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
    if (layer.role !== undefined && !['hero','support','label','background'].includes(layer.role)) add('error', `${name}: unknown visual role`);
    if (layer.asset !== undefined && (!layer.asset || !['blockout','draft','final'].includes(layer.asset.stage) || (layer.asset.description !== undefined && (typeof layer.asset.description !== 'string' || layer.asset.description.length > 400)))) add('error', `${name}: asset needs stage blockout/draft/final and an optional description up to 400 characters`);
    if (!['text', 'image', 'video', 'shot', 'shape', 'path', 'counter'].includes(layer.kind)) add('error', `${name}: unknown kind`);
    if (!Array.isArray(layer.box) || layer.box.length !== 4 || layer.box.some((v: any) => !finite(v)) || layer.box[2] <= 0 || layer.box[3] <= 0 || layer.box[0] < 0 || layer.box[1] < 0 || layer.box[0] + layer.box[2] > 1.001 || layer.box[1] + layer.box[3] > 1.001) { add('error', `${name}: box [x,y,w,h] must fit the canvas in fractions`); continue; }
    if (layer.kind === 'text' && (typeof layer.text !== 'string' || !layer.text.trim() || layer.text.length > 1000)) add('error', `${name}: text required (1..1000 characters)`);
    if (['image', 'video'].includes(layer.kind) && !pathOK(layer.src)) add('error', `${name}: src must be a relative public/ asset path`);
    if (layer.kind === 'shot' && (typeof layer.shot !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(layer.shot))) add('error', `${name}: valid shot id required`);
    if (layer.subjectFit !== undefined && (layer.kind !== 'shot' || typeof layer.subjectFit !== 'boolean')) add('error', `${name}: subjectFit is a boolean for shot layers; false preserves the authored full-frame camera composition`);
    if (layer.color !== undefined && !colorOK(layer.color)) add('error', `${name}: color must be #rrggbb`);
    if (layer.colorRole !== undefined && !['ink','muted','accent','accent2','surface','background'].includes(layer.colorRole)) add('error', `${name}: unknown theme colorRole`);
    if (layer.stroke !== undefined && !colorOK(layer.stroke)) add('error', `${name}: stroke must be #rrggbb`);
    if (layer.strokeWidth !== undefined && (!finite(layer.strokeWidth) || layer.strokeWidth < .1 || layer.strokeWidth > 40)) add('error', `${name}: strokeWidth must be .1..40`);
    if (layer.shadow !== undefined && !['soft','none'].includes(layer.shadow)) add('error', `${name}: unknown shadow`);
    if (layer.kind === 'path' && (!layer.path || !pointsOK(layer.path.points,null,0,1))) add('error', `${name}: path needs 2..64 normalized 2D points`);
    if (layer.path) for (const key of ['smooth','closed','draw','arrow']) if (layer.path[key] !== undefined && typeof layer.path[key] !== 'boolean') add('error', `${name}: path.${key} must be boolean`);
    if (layer.kind === 'counter' && (!layer.value || !finite(layer.value.from) || !finite(layer.value.to) || Math.abs(layer.value.from)>1e12 || Math.abs(layer.value.to)>1e12)) add('error', `${name}: counter needs finite from/to within 1e12`);
    if (layer.value) {
      if (layer.value.decimals !== undefined && (!Number.isInteger(layer.value.decimals) || layer.value.decimals<0 || layer.value.decimals>6)) add('error', `${name}: counter decimals must be 0..6`);
      for (const k of ['prefix','suffix']) if (layer.value[k] !== undefined && (typeof layer.value[k] !== 'string' || layer.value[k].length>40)) add('error', `${name}: counter ${k} must be at most 40 characters`);
    }
    for (const [field, lo, hi] of [['size', 14, 300], ['radius', 0, 200], ['startFrom', 0, 86400], ['speed', .1, 4]] as const) if (layer[field] !== undefined && (!finite(layer[field]) || layer[field] < lo || layer[field] > hi)) add('error', `${name}: invalid ${field}`);
    const motion = layer.motion ?? {};
    if (motion.easing && !easings.includes(motion.easing)) add('error', `${name}: unknown easing`);
    if (motion.stagger !== undefined && (!finite(motion.stagger) || motion.stagger < 0 || motion.stagger > 2)) add('error', `${name}: stagger must be 0..2 seconds`);
    if (motion.travel !== undefined && (!finite(motion.travel) || Math.abs(motion.travel) > 1)) add('error', `${name}: travel must be -1..1 canvas units`);
    if (layer.reveal && !['block', 'lines', 'words', 'typewriter'].includes(layer.reveal)) add('error', `${name}: unknown text reveal`);
    if (layer.wordTimes !== undefined && layer.wordCues !== undefined) add('error', `${name}: provide wordTimes or wordCues, not both`);
    if (layer.wordCues !== undefined) {
      const text=typeof layer.text==='string'?layer.text:'';
      const count=layer.reveal==='typewriter'?Array.from(text).length:text.trim().split(/\s+/).length;
      if(layer.kind!=='text' || !['words','typewriter'].includes(layer.reveal) || !Array.isArray(layer.wordCues) || layer.wordCues.length!==count || layer.wordCues.some((cue: any,i: number)=>typeof cue!=='string' || !finite(scene.cues?.[cue]) || (i>0 && scene.cues[cue]<scene.cues[layer.wordCues[i-1]])))add('error',`${name}: wordCues needs one ordered existing cue per word/character`);
    }
    if (layer.wordTimes !== undefined) {
      const text=typeof layer.text==='string'?layer.text:'';
      const count = layer.reveal === 'typewriter' ? Array.from(text).length : text.trim().split(/\s+/).length;
      if (layer.kind !== 'text' || !['words','typewriter'].includes(layer.reveal) || !Array.isArray(layer.wordTimes) || layer.wordTimes.length !== count || layer.wordTimes.some((v: any,i: number) => !finite(v) || v<0 || v>=scene.seconds || (i>0 && v<layer.wordTimes[i-1]))) add('error', `${name}: wordTimes needs one ordered scene time per revealed word/character`);
    }
    if (motion.cue && !finite(scene.cues?.[motion.cue])) add('error', `${name}: missing cue ${motion.cue}`);
    if (motion.at !== undefined && (!finite(motion.at) || motion.at < 0 || motion.at >= scene.seconds)) add('error', `${name}: motion.at outside scene`);
    if (motion.duration !== undefined && (!finite(motion.duration) || motion.duration < .01 || motion.duration > scene.seconds)) add('error', `${name}: invalid motion.duration`);
    if (motion.enter && !['none', 'rise', 'slide', 'pop', 'wipe'].includes(motion.enter)) add('error', `${name}: unknown entrance`);
    if (motion.route !== undefined && !pointsOK(motion.route,4,-2,2)) add('error', `${name}: route needs four cubic control points in canvas offsets within -2..2`);
    if (motion.orient !== undefined && typeof motion.orient !== 'boolean') add('error', `${name}: orient must be boolean`);
    if (motion.exit !== undefined) {
      const end=motion.exit;
      if (!end || typeof end !== 'object' || Array.isArray(end)) add('error', `${name}: exit must be a timing object`);
      else {
        if (end.cue && !finite(scene.cues?.[end.cue])) add('error', `${name}: missing exit cue ${end.cue}`);
        if (end.at !== undefined && (!finite(end.at) || end.at<0 || end.at>=scene.seconds)) add('error', `${name}: exit.at outside scene`);
        if (end.duration !== undefined && (!finite(end.duration) || end.duration<.01 || end.duration>scene.seconds)) add('error', `${name}: invalid exit.duration`);
        if (end.to !== undefined && !['fade','rise','slide','shrink','wipe'].includes(end.to)) add('error', `${name}: unknown exit`);
        if (end.travel !== undefined && (!finite(end.travel) || Math.abs(end.travel)>1)) add('error', `${name}: invalid exit.travel`);
      }
    }
    for (const [keys, label] of [[motion.keys, 'motion'], [layer.camera, 'camera']] as const) if (keys !== undefined) {
      if (!Array.isArray(keys) || keys.length > (label === 'camera' ? 1202 : 64)) { add('error', `${name}: invalid ${label} keys`); continue; }
      let last = -1;
      for (const k of keys) {
        if (!k || !finite(k.t) || k.t <= last || k.t < 0 || k.t > (label === 'camera' ? 86400 : scene.seconds) || Object.entries(k).some(([field,v]) => field === 'easing' ? !easings.includes(String(v)) : !finite(v))) { add('error', `${name}: ordered finite ${label} keys required`); continue; }
        last = k?.t ?? last;
        if (label === 'motion' && ((k.scale !== undefined && (k.scale <= 0 || k.scale > 5)) || (k.opacity !== undefined && (k.opacity < 0 || k.opacity > 1)))) add('error', `${name}: invalid scale/opacity`);
        if (label === 'motion' && (['scaleX','scaleY'].some(f=>k[f] !== undefined && (k[f]<=0 || k[f]>5)) || (k.blur !== undefined && (k.blur<0 || k.blur>100)))) add('error', `${name}: invalid axis scale/blur`);
        if (label === 'camera' && (!finite(k.zoom) || k.zoom < 1 || k.zoom > 4 || !finite(k.x) || !finite(k.y))) add('error', `${name}: camera needs x, y, zoom 1..4`);
      }
    }
    if (layer.screen && (!pathOK(layer.screen.src) || layer.kind !== 'shot')) add('error', `${name}: tracked screen belongs to a shot and needs a public src`);
    if (layer.screen) for (const [field, lo, hi] of [['startFrom', 0, 86400], ['speed', .1, 4], ['width', 64, 3840], ['height', 64, 3840]] as const) if (layer.screen[field] !== undefined && (!finite(layer.screen[field]) || layer.screen[field] < lo || layer.screen[field] > hi)) add('error', `${name}: invalid screen.${field}`);
  }
  if (issues.some(i => i.severity === 'error')) return issues;
  for (const l of layers) if (['text','counter'].includes(l.kind)) {
    const m=l.motion ?? {}, at=cueTime(m,scene.cues);
    let settled=(m.enter === 'none' ? 0 : at+(m.duration ?? .65));
    if (l.kind === 'counter') settled=at+(m.duration ?? .65);
    if (l.reveal === 'words' || l.reveal === 'typewriter') {
      const count=l.reveal==='words'?l.text.trim().split(/\s+/).length:Array.from(l.text).length;
      settled=Math.max(settled,l.wordCues?.length?scene.cues[l.wordCues.at(-1)]:l.wordTimes?.at(-1) ?? at+(count-1)*(m.stagger ?? (l.reveal==='words'?.12:.04)));
    }
    const end=m.exit ? cueTime(m.exit,scene.cues) : scene.seconds;
    const hold=end-settled;
    if (hold<.25) add('warn', `${l.id} has ${Math.max(0,hold).toFixed(2)}s of settled reading time; its reveal may finish after exit or cut`);
  }
  const reported = new Set<string>();
  for (let k = 0; k < 24; k++) {
    const t = scene.seconds * (k + .5) / 24;
    const regions = layers.map((l: Layer) => {
      const aspect=scene.props.canvasAspect ?? 1;
      const p = layerPose(t, l.motion, scene.cues,aspect), [x, y, w, h] = l.box;
      const radians=p.rotate*Math.PI/180;
      const cw = Math.abs(Math.cos(radians))*w*p.scale*p.scaleX+Math.abs(Math.sin(radians))*h*p.scale*p.scaleY/aspect;
      const ch = Math.abs(Math.sin(radians))*w*p.scale*p.scaleX*aspect+Math.abs(Math.cos(radians))*h*p.scale*p.scaleY;
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

/** Bounded cue/gesture evidence for the renderer and model, never an aesthetic
 * score. Endpoints are quantized to actual delivered frames. */
export function productionTimes(scene: any, fps: number): number[] {
  const frames=Math.max(1,Math.round(scene.seconds*fps)), times=new Set([0,frames-1]);
  const add=(t: number) => { if(finite(t)) { const f=Math.max(0,Math.min(frames-1,Math.round(t*fps))); for(const d of [-1,0,1])if(f+d>=0&&f+d<frames)times.add(f+d); } };
  for (const l of scene.props?.layers ?? []) {
    const m=l.motion ?? {}, at=cueTime(m,scene.cues);
    add(at); add(at+(m.duration ?? .65));
    for(const key of m.keys ?? []) add(key.t);
    for(const time of l.wordTimes ?? []) add(time);
    if(m.exit) {const at=cueTime(m.exit,scene.cues);add(at);add(at+(m.exit.duration ?? .4));}
  }
  for(const t of Object.values(scene.cues ?? {}))add(Number(t));
  return [...times].sort((a,b)=>a-b).map(f=>f/fps);
}

export function compileStoryboard(input: any[], spec: any, append = false) {
  if (!Array.isArray(input) || !input.length || input.length > 2000) throw Error('compose needs 1..2000 scenes');
  const scenes = input.map(raw => {
    if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(raw.id) || !finite(raw.seconds) || raw.seconds < .5 || raw.seconds > 600) throw Error('Scenes need kebab-case id and seconds .5..600');
    const previous = (spec.scenes ?? []).find((s: any) => s.id === raw.id && s.narration === raw.narration);
    const timing = previous ? Object.fromEntries(['narrationAudio', 'narrationWords', 'narrationSeconds', 'narrationOffset'].filter(k => previous[k] !== undefined).map(k => [k, previous[k]])) : {};
    const { layers, hero, headline, kicker, footer, layout, background, ink, size, headlineCue, ...scene } = raw;
    return { ...timing, ...scene, component: 'StudioScene', props: { layers: storyboardLayers(raw, spec), background, ink,canvasAspect:(spec.width ?? 1920)/(spec.height ?? 1080) }, transition: raw.transition ?? { type: 'none', seconds: .2 } };
  });
  const combined = append ? [...spec.scenes, ...scenes] : scenes;
  const ids = combined.map(s => s.id);
  if (new Set(ids).size !== ids.length) throw Error('Scene ids must be distinct; append does not replace an existing id');
  const issues = combined.flatMap(validateProductionScene);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length) throw Error(errors.map(e => `[${e.scene}] ${e.message}`).join('; '));
  return { scenes: combined, issues };
}
