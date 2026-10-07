// Shared choreography mathematics. Seconds and normalized rectangles are the
// contract used by the compositor, authoring tools and validation. No renderer
// imports, wall clock or state: a segment can seek to any frame in any order.
export type Box = [number, number, number, number];
export type Key = { t: number; x?: number; y?: number; scale?: number; rotate?: number; opacity?: number };
export type Motion = { at?: number; cue?: string; duration?: number; enter?: 'none' | 'rise' | 'slide' | 'pop' | 'wipe'; travel?: number; keys?: Key[]; easing?: 'smooth' | 'snappy' | 'spring'; stagger?: number };
export type CameraKey = { t: number; x: number; y: number; zoom: number };
export type Layer = {
  id: string; kind: 'text' | 'image' | 'video' | 'shot' | 'shape'; box: Box;
  text?: string; src?: string; shot?: string; color?: string; font?: 'display' | 'text' | 'mono';
  size?: number; weight?: number; align?: 'left' | 'center' | 'right'; fit?: 'cover' | 'contain';
  reveal?: 'block' | 'lines';
  radius?: number; shape?: 'rect' | 'ellipse'; motion?: Motion; startFrom?: number; speed?: number;
  mode?: 'hold' | 'loop' | 'pingpong'; camera?: CameraKey[];
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
  if (style === 'snappy') return 1 - (1-u)**4;
  if (style === 'spring' && u < 1) return 1 - Math.exp(-8*u)*(Math.cos(11*u)+8/11*Math.sin(11*u));
  return smooth(u);
};
export const cueTime = (motion: Motion = {}, cues: Record<string, number> = {}) => {
  if (motion.cue && !Number.isFinite(cues[motion.cue])) throw Error(`Missing motion cue ${motion.cue}`);
  return motion.cue ? cues[motion.cue] : motion.at ?? 0;
};
export function keyed<T extends { t: number }, K extends string>(keys: T[], t: number, defaults: Record<K, number>): Record<K, number> {
  if (!keys.length) return { ...defaults };
  let i = 0; while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const p = a.t === b.t ? 0 : smooth((t - a.t) / (b.t - a.t));
  // Sparse fields carry forward rather than snapping to a default at a key.
  const value = (field: K, end: number) => {
    for (let k = end; k >= 0; k--) if (Number.isFinite((keys[k] as any)[field])) return (keys[k] as any)[field];
    return defaults[field];
  };
  return Object.fromEntries((Object.keys(defaults) as K[]).map(field => [field, mix(value(field, i), value(field, Math.min(i + 1, keys.length - 1)), p)])) as Record<K, number>;
}
export function layerPose(t: number, motion: Motion = {}, cues: Record<string, number> = {}) {
  const at = cueTime(motion, cues), p = motionEase((t - at) / Math.max(.01, motion.duration ?? .65), motion.easing);
  const pose = keyed(motion.keys ?? [], t, { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 });
  if (motion.enter !== 'none') {
    pose.opacity *= t < at ? 0 : clamp(p);
    if (motion.enter === 'rise') pose.y += (1 - p) * (motion.travel ?? .06);
    if (motion.enter === 'slide') pose.x -= (1 - p) * (motion.travel ?? .08);
    if (motion.enter === 'pop') pose.scale *= 1 - .18 * (1 - p) + .04 * Math.sin(p * Math.PI);
  }
  return { ...pose, reveal: motion.enter === 'wipe' ? p : 1 };
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
