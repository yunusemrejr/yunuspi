/** Deterministic RGB atmosphere over an approved locked-camera plate.
 * Geometry and typography are never substituted or moved by this renderer. */
export function ambientPlan(p: any) {
  const num = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const n = p[key] ?? fallback;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw Error(`${key} must be ${min}..${max}${integer ? ' (integer)' : ''}`);
    return n;
  };
  const width = num('width', 1920, 64, 3840, true), height = num('height', 1080, 64, 2160, true);
  if (width % 2 || height % 2) throw Error('Delivery dimensions must be even');
  const requestedSeconds = num('seconds', 10, .25, 120), fps = num('fps', 24, 1, 60, true);
  const frames = Math.max(1, Math.round(requestedSeconds * fps)), seconds = frames / fps;
  const clouds = num('clouds', .75, 0, 1), rain = num('rain', .35, 0, 1);
  const skyline = p.skyline;
  if (skyline !== undefined && (!Array.isArray(skyline) || skyline.length < 2 || skyline.length > 64 || skyline.some((point, i) => !Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || (i > 0 && point[0] <= skyline[i-1][0])) || skyline[0][0] !== 0 || skyline.at(-1)[0] !== 1)) throw Error('skyline needs 2..64 ordered [x,y] canvas fractions, from x:0 to x:1; white sky is above this boundary');
  if (p.skyMask && skyline) throw Error('Provide skyMask or skyline, not both');
  if (clouds > 0 && !p.skyMask && !skyline) throw Error('Cloud movement requires an inspected skyMask image or skyline: white sky, black stationary terrain/buildings. Set clouds:0 for rain only.');
  const lightning = p.lightning ?? [];
  if (!Array.isArray(lightning) || lightning.length > 12 || lightning.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t >= seconds)) throw Error('lightning needs at most 12 seconds within the clip');
  return { width, height, seconds, fps, frames, clouds, rain, skyline, seed: num('seed', 17, 0, 4294967295, true),
    cloudSpeed: num('cloudSpeed', 1.2, -10, 10), lightning, exposure: num('exposure', 0, -2, 1), crf: num('crf', 18, 1, 40, true) };
}
export function skylineMask(points: number[][], w: number, h: number) {
  const pixels = new Uint8Array(w*h*3); let edge = 0;
  for (let x = 0; x < w; x++) {
    const nx=x/Math.max(1,w-1);
    while(edge < points.length-2 && nx > points[edge+1][0]) edge++;
    const [a,b]=[points[edge],points[edge+1]], at=(nx-a[0])/(b[0]-a[0]), boundary=(a[1]+(b[1]-a[1])*at)*h;
    for(let y=0;y<Math.min(h,Math.ceil(boundary));y++) {
      const v=Math.round(255*Math.min(1,Math.max(0,(boundary-y)/Math.max(2,h/90))));
      pixels.fill(v,(y*w+x)*3,(y*w+x)*3+3);
    }
  }
  return pixels;
}
const wrap = (n: number, m: number) => ((n % m) + m) % m;
export function createAmbientFrames(base: Uint8Array, mask: Uint8Array | undefined, plan: ReturnType<typeof ambientPlan>) {
  const { width: w, height: h } = plan, bytes = w * h * 3;
  if (base.length !== bytes || (mask && mask.length !== bytes)) throw Error('Plate and mask must match the RGB delivery canvas');
  let seed = plan.seed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const gain = 2 ** plan.exposure;
  const plate = Uint8Array.from(base, v => Math.min(255, Math.round(v * gain)));
  const sky: number[] = [];
  if (mask && plan.clouds) for (let i = 0; i < w * h; i++) if (mask[i * 3] > 0) sky.push(i);
  const drops = Array.from({ length: Math.round(plan.rain * 420) }, () => {
    const depth = random();
    return { x: random() * w, y: random() * h, speed: (180 + depth * 600) * h / 1080, length: (6 + depth * 24) * h / 1080, alpha: (.02 + depth * .10) * plan.rain, slant: -.16 };
  });
  return (seconds: number) => {
    const frame = Buffer.from(plate);
    const shift = seconds * plan.cloudSpeed * w / 1920;
    // Warp only sky samples. The source mask prevents sampling buildings or
    // trees into the moving clouds; stationary foreground pixels remain exact.
    if (mask) for (const pixel of sky) {
      const x = pixel % w, y = Math.floor(pixel / w), sx = wrap(x + shift, w), lo = Math.floor(sx), hi = (lo + 1) % w, a = sx - lo;
      const i = pixel * 3, j = (y * w + lo) * 3, k = (y * w + hi) * 3;
      const coverage = mask[i] / 255 * Math.min(mask[j], mask[k]) / 255 * plan.clouds;
      for (let c = 0; c < 3; c++) frame[i + c] = Math.round(plate[i + c] + (plate[j + c] * (1 - a) + plate[k + c] * a - plate[i + c]) * coverage);
    }
    for (const drop of drops) {
      const y = wrap(drop.y + seconds * drop.speed, h + drop.length * 2) - drop.length;
      const x = wrap(drop.x + seconds * drop.speed * drop.slant, w);
      for (let d = 0; d < drop.length; d++) {
        const px = Math.round(x - d * drop.slant), py = Math.round(y - d);
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const at = (py * w + px) * 3, opacity = drop.alpha * Math.sin(Math.PI * d / drop.length);
        for (let c = 0; c < 3; c++) frame[at + c] = Math.round(frame[at + c] + (220 - frame[at + c]) * opacity);
      }
    }
    const flash = Math.min(.075, plan.lightning.reduce((sum, t) => sum + .055 * Math.exp(-(((seconds - t) / .14) ** 2)) + .022 * Math.exp(-(((seconds - t - .22) / .1) ** 2)), 0));
    if (flash > .0005) for (let y = 0; y < h; y++) {
      const opacity = flash * (1 - .65 * y / h);
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) frame[at + c] = Math.round(frame[at + c] + (230 - frame[at + c]) * opacity);
      }
    }
    return frame;
  };
}
