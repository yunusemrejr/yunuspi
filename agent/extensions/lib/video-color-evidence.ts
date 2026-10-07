import fs from 'node:fs/promises';
import { decodeImage } from './design-studio.ts';

/** Measured pixels accompany vision inference; a palette is not an art verdict. */
export function measureFrameColor(data: Uint8Array, stride = 1) {
  const mean = [0,0,0]; let magenta = 0, n = 0;
  for (let i = 0; i < data.length; i += 4 * Math.max(1, stride)) {
    const [r,g,b] = data.subarray(i,i+3); n++;
    mean[0] += r; mean[1] += g; mean[2] += b;
    if (r > 24 && b > 24 && r > g * 1.5 && b > g * 1.5) magenta++;
  }
  return { meanRgb: mean.map(v => Math.round(v / Math.max(1,n))), magentaFraction: Math.round(magenta / Math.max(1,n) * 1000) / 1000 };
}
export async function sampledColorEvidence(frames: {path:string}[], signal?: AbortSignal) {
  const samples = [];
  for (const frame of frames) {
    const decoded = await decodeImage(await fs.readFile(frame.path), { maxWidth: 96, maxPixels: 16384 }, signal);
    samples.push({ path: frame.path, ...measureFrameColor(decoded.data) });
  }
  return { samples, note: 'Stored decoded RGB pixel measurements. Strong magenta can be intentional; compare with the actual brief and references. These measurements do not establish aesthetic quality or unseen motion.' };
}
