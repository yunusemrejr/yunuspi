/** Evidence for the existing video QA report, not an automatic taste score.
 * Geometry and decode can be checked; semantic craft needs pixel review. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './video-segments.ts';

export async function referenceEvidence(references: string[], base: string, signal?: AbortSignal) {
  const out: any[]=[];
  for (const source of references.slice(0,8)) {
    if (/^https?:\/\//i.test(source)) {out.push({source,kind:'remote',note:'Reviewer must inspect the reference; this URL is not downloaded or visually approved automatically'});continue;}
    const file=path.resolve(base,source);
    try {
      if ((await fs.stat(file)).size>20*1024*1024) throw Error('reference exceeds 20 MiB');
      out.push({source:file,kind:'local',sha256:await fileDigest(file,signal)});
    } catch(error:any) {signal?.throwIfAborted();out.push({source:file,kind:'local',unavailable:error.message});}
  }
  return out;
}
