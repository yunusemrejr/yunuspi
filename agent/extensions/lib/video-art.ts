/** Evidence for the existing video QA report, not an automatic taste score.
 * Geometry and decode can be checked; semantic craft needs pixel review. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeImage } from './design-studio.ts';
import { fileDigest } from './video-segments.ts';
import { containsPath } from './path-safety.ts';

export async function inspectVideoAssets(dir: string, spec: any) {
  const issues: Array<{severity:'error'|'warn';scene:string;message:string}> = [];
  const assets: any[] = [], measured = new Map<string,any>();
  const root = await fs.realpath(path.join(dir,'public')).catch(()=>path.resolve(dir,'public'));
  for (const scene of Array.isArray(spec.scenes) ? spec.scenes : []) for (const layer of Array.isArray(scene?.props?.layers) ? scene.props.layers : []) {
    if (!layer || typeof layer !== 'object') continue;
    if (layer.asset?.stage && layer.asset.stage !== 'final') issues.push({severity:'warn',scene:scene.id,message:`Layer ${layer.id} is an explicit ${layer.asset.stage} asset; replace or finish it before final delivery`});
    const focal = layer.role === 'hero' || layer.id === 'hero';
    if (focal || layer.asset) assets.push({scene:scene.id,layer:layer.id,kind:layer.kind,role:layer.role ?? (focal?'hero':'support'),stage:layer.asset?.stage ?? 'unspecified',description:layer.asset?.description ?? null,source:layer.src ?? layer.shot ?? null});
    for (const source of [(['image','video'].includes(layer.kind) ? layer.src : undefined),layer.screen?.src].filter(Boolean)) {
      // Native assets stay in public/. Resolve symlinks before reading bytes.
      if (typeof source !== 'string' || path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) continue;
      const file = path.join(root,source);
      try {
        const real = await fs.realpath(file);
        if (!containsPath(root,real)) throw Error('asset resolves outside public/');
        const stat = await fs.stat(real);
        if (!stat.isFile()) throw Error('asset is not a regular file');
        if (layer.kind !== 'image' || source !== layer.src || /\.svg$/i.test(source)) continue;
        if (stat.size > 64*1024*1024) throw Error('image exceeds 64 MiB');
        let info=measured.get(real);
        if (!info) { info=await probeImage(await fs.readFile(real));measured.set(real,info); }
        const [,,w,h] = Array.isArray(layer.box) ? layer.box : [0,0,0,0];
        const keys=Array.isArray(layer.motion?.keys) ? layer.motion.keys.filter((k:any)=>k && typeof k==='object') : [];
        const scale=Math.max(1,...keys.map((k:any)=>(k.scale ?? 1)*Math.max(k.scaleX ?? 1,k.scaleY ?? 1)));
        const x=w*spec.width*scale/info.width,y=h*spec.height*scale/info.height;
        const enlargement=layer.fit==='cover'?Math.max(x,y):Math.min(x,y);
        if (enlargement>1.5) issues.push({severity:'warn',scene:scene.id,message:`Image ${source} (${info.width}x${info.height}) is enlarged ${enlargement.toFixed(1)}x; inspect sharpness at delivery size or use a larger source`});
        const entry=assets.find(a=>a.scene===scene.id && a.layer===layer.id);
        if(entry)entry.pixels={width:info.width,height:info.height,enlargement:Number(enlargement.toFixed(2))};
      } catch(error:any) {
        issues.push({severity:'error',scene:scene.id,message:`Asset ${source}: ${error.message}`});
      }
    }
  }
  return {assets,issues};
}

/** Local comparison images are hash-bound just like the render. Remote
 * links name references, not a claim that their pixels were inspected. */
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
