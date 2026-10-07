// Shared choreography mathematics. Seconds and normalized rectangles are the
// contract used by the compositor, authoring tools and validation. No renderer
// imports, wall clock or state: a segment can seek to any frame in any order.
export type Box = [number, number, number, number];
export type Easing = 'linear' | 'smooth' | 'snappy' | 'spring' | 'hold';
export type Key = { t: number; x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number; rotate?: number; rotateX?: number; rotateY?: number; opacity?: number; blur?: number; easing?: Easing };
export type Motion = { at?: number; cue?: string; duration?: number; enter?: 'none' | 'rise' | 'slide' | 'pop' | 'wipe'; travel?: number; keys?: Key[]; easing?: Easing; stagger?: number;
  route?: [number, number][]; orient?: boolean;
  exit?: { at?: number; cue?: string; duration?: number; to?: 'fade' | 'rise' | 'slide' | 'shrink' | 'wipe'; travel?: number } };
export type CameraKey = { t: number; x: number; y: number; zoom: number };
export type Layer = {
  id: string; kind: 'text' | 'image' | 'video' | 'shot' | 'shape' | 'path' | 'counter'; box: Box;
  role?: 'hero' | 'support' | 'label' | 'background';
  asset?: { stage: 'blockout' | 'draft' | 'final'; description?: string };
  text?: string; src?: string; shot?: string; color?: string; colorRole?: 'ink' | 'muted' | 'accent' | 'accent2' | 'surface' | 'background'; font?: 'display' | 'text' | 'mono';
  size?: number; weight?: number; align?: 'left' | 'center' | 'right'; fit?: 'cover' | 'contain';
  reveal?: 'block' | 'lines' | 'words' | 'typewriter'; wordTimes?: number[]; wordCues?: string[];
  path?: { points: [number, number][]; smooth?: boolean; closed?: boolean; draw?: boolean; arrow?: boolean };
  value?: { from: number; to: number; decimals?: number; prefix?: string; suffix?: string };
  stroke?: string; strokeWidth?: number; shadow?: 'none' | 'soft';
  radius?: number; shape?: 'rect' | 'ellipse'; motion?: Motion; startFrom?: number; speed?: number;
  mode?: 'hold' | 'loop' | 'pingpong'; camera?: CameraKey[];
  /** false retains the Blender camera's full composition; true fits foreground bounds. */
  subjectFit?: boolean;
  sourceWidth?: number; sourceHeight?: number;
  screen?: { src: string; prefix?: string; startFrom?: number; speed?: number; width?: number; height?: number };
  chrome?: 'browser' | 'phone' | 'none'; label?: string; sound?: 'whoosh' | 'pop' | 'tick' | 'chime' | 'impact' | 'none';
};
export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smooth = (v: number) => { const t = clamp(v); return t * t * t * (t * (t * 6 - 15) + 10); };
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** A sampled analytical spring: seekable in film rendering, including frame
 * ranges, rather than a running CSS animation whose clock can drift. */
export const motionEase = (t: number, style = 'smooth') => {
  const u = clamp(t);
  if (style === 'linear') return u;
  if (style === 'hold') return u < 1 ? 0 : 1;
  if (style === 'snappy') return 1 - (1-u)**4;
  if (style === 'spring' && u < 1) return 1 - Math.exp(-8*u)*(Math.cos(11*u)+8/11*Math.sin(11*u));
  return smooth(u);
};
export const cueTime = (motion: Motion = {}, cues: Record<string, number> = {}) => {
  if (motion.cue && !Number.isFinite(cues[motion.cue])) throw Error(`Missing motion cue ${motion.cue}`);
  return motion.cue ? cues[motion.cue] : motion.at ?? 0;
};
export function keyed<T extends { t: number; easing?: Easing }, K extends string>(keys: T[], t: number, defaults: Record<K, number>, easing = 'smooth'): Record<K, number> {
  if (!keys.length) return { ...defaults };
  let i = 0; while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const p = a.t === b.t ? 0 : motionEase((t - a.t) / (b.t - a.t), a.easing ?? easing);
  // Sparse fields carry forward rather than snapping to a default at a key.
  const value = (field: K, end: number) => {
    for (let k = end; k >= 0; k--) if (Number.isFinite((keys[k] as any)[field])) return (keys[k] as any)[field];
    return defaults[field];
  };
  return Object.fromEntries((Object.keys(defaults) as K[]).map(field => [field, mix(value(field, i), value(field, Math.min(i + 1, keys.length - 1)), p)])) as Record<K, number>;
}
export function layerPose(t: number, motion: Motion = {}, cues: Record<string, number> = {}, aspect = 1) {
  const at = cueTime(motion, cues), p = motionEase((t - at) / Math.max(.01, motion.duration ?? .65), motion.easing);
  const pose = keyed(motion.keys ?? [], t, { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, rotateX: 0, rotateY: 0, opacity: 1, blur: 0 }, motion.easing);
  if (motion.route?.length === 4) {
    const point = bezierPoint(motion.route, p, aspect);
    pose.x += point.x; pose.y += point.y;
    if (motion.orient) pose.rotate += point.angle;
  }
  if (motion.enter !== 'none') {
    pose.opacity *= t < at ? 0 : clamp(p);
    if (motion.enter === 'rise') pose.y += (1 - p) * (motion.travel ?? .06);
    if (motion.enter === 'slide') pose.x -= (1 - p) * (motion.travel ?? .08);
    if (motion.enter === 'pop') pose.scale *= 1 - .18 * (1 - p) + .04 * Math.sin(p * Math.PI);
  }
  let reveal = motion.enter === 'wipe' ? clamp(p) : 1;
  if (motion.exit) {
    const end = motion.exit, e = smooth((t - cueTime(end, cues)) / Math.max(.01, end.duration ?? .4));
    if (end.to === 'wipe') reveal *= 1-e;
    else pose.opacity *= 1-e;
    if (end.to === 'rise') pose.y -= e*(end.travel ?? .06);
    if (end.to === 'slide') pose.x += e*(end.travel ?? .08);
    if (end.to === 'shrink') pose.scale *= 1-e*.18;
  }
  return { ...pose, opacity: clamp(pose.opacity), blur: Math.max(0, pose.blur), reveal };
}

/** Four control points in canvas offsets. A pure cubic keeps curved gestures
 * identical during backwards seeking and segmented rendering. */
export function bezierPoint(points: [number, number][], p: number, aspect = 1) {
  const q = 1-p, [a,b,c,d] = points;
  const x = q*q*q*a[0]+3*q*q*p*b[0]+3*q*p*p*c[0]+p*p*p*d[0];
  const y = q*q*q*a[1]+3*q*q*p*b[1]+3*q*p*p*c[1]+p*p*p*d[1];
  const dx = 3*q*q*(b[0]-a[0])+6*q*p*(c[0]-b[0])+3*p*p*(d[0]-c[0]);
  const dy = 3*q*q*(b[1]-a[1])+6*q*p*(c[1]-b[1])+3*p*p*(d[1]-c[1]);
  return { x, y, angle: Math.atan2(dy,dx*aspect)*180/Math.PI };
}

/** Native SVG geometry; no injected markup or runtime path measurements. */
export function pathData(points: [number, number][], width: number, height: number, curved = false, closed = false) {
  const p = points.map(([x,y]) => [x*width,y*height]);
  let d = `M ${p[0][0]} ${p[0][1]}`;
  for (let i=1;i<p.length;i++) {
    if (!curved) { d += ` L ${p[i][0]} ${p[i][1]}`; continue; }
    const a=p[Math.max(0,i-2)], b=p[i-1], c=p[i], e=p[Math.min(p.length-1,i+1)];
    d += ` C ${b[0]+(c[0]-a[0])/6} ${b[1]+(c[1]-a[1])/6} ${c[0]-(e[0]-b[0])/6} ${c[1]-(e[1]-b[1])/6} ${c[0]} ${c[1]}`;
  }
  return d+(closed?' Z':'');
}

/** Fit once using a caller's loaded-font measurement. Binary search replaces
 * one-pixel retries; overlong words are split without losing Unicode points. */
export function fitLines(text: string, width: number, height: number, measure: (text: string, size: number) => number, wanted: number, minimum = 14) {
  const linesAt = (size: number) => text.split('\n').flatMap(paragraph => {
    const lines: string[] = []; let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next,size) <= width) { line=next; continue; }
      if (line) { lines.push(line); line=''; }
      for (const char of Array.from(word)) {
        if (line && measure(line+char,size)>width) { lines.push(line); line=''; }
        line += char;
      }
    }
    lines.push(line); return lines;
  });
  const fits = (lines: string[], size: number) => lines.length*size*1.08 <= height && lines.every(line=>measure(line,size)<=width);
  let lo=minimum, hi=Math.max(minimum,Math.floor(wanted));
  while (lo<hi) { const mid=Math.ceil((lo+hi)/2); if(fits(linesAt(mid),mid))lo=mid;else hi=mid-1; }
  const lines=linesAt(lo);
  return { lines, size:lo, overflow:!fits(lines,lo) };
}
/** Camera crops remain inside the source. The source-relative clock is used
 * even after trimming, speeding up a take, or rendering a later film segment. */
export function cameraAt(keys: CameraKey[] = [], seconds: number, coverage = { x: 1, y: 1 }) {
  const p = keyed(keys, seconds, { x: .5, y: .5, zoom: 1 });
  const zoom = Math.max(1, p.zoom), hx = Math.min(.5, .5*coverage.x/zoom), hy = Math.min(.5, .5*coverage.y/zoom);
  return { x: clamp(p.x, hx, 1-hx), y: clamp(p.y, hy, 1-hy), zoom };
}
/** Homography from a rectangle to a projected screen quad (TL, TR, BR, BL).
 * Returns CSS's column-major matrix3d. Rejects singular/edge-on quads. */
export function screenMatrix(width: number, height: number, points: Array<{ x: number; y: number }>): number[] | null {
  if (!(width > 0 && height > 0) || points.length !== 4 || points.some(p => !Number.isFinite(p.x + p.y))) return null;
  const source = [[0, 0], [width, 0], [width, height], [0, height]], rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = source[i], { x: u, y: v } = points[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c; for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-8) return null;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c]; for (let k = c; k < 9; k++) rows[c][k] /= divisor;
    for (let r = 0; r < 8; r++) if (r !== c) { const factor = rows[r][c]; for (let k = c; k < 9; k++) rows[r][k] -= factor * rows[c][k]; }
  }
  const [a, b, c, d, e, f, g, h] = rows.map(row => row[8]);
  return [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, 1];
}
