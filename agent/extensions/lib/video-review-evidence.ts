/** Current delivered-video reviews, scoped to the owning session. A technical
 * QA pass is never an aesthetic, playback or listening approval. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerContinuationSource } from './continuation-notice.ts';
import { videoQa } from './video-studio.ts';
import { rejectsCompletedWork } from './goal-state.ts';
import { fileDigest } from './video-segments.ts';

const ENTRY = 'video-review-evidence-v1';
export function videoCreationIntent(text: string): boolean {
  return /\b(?:creat(?:e|ing)|mak(?:e|ing)|produc(?:e|ing)|animat(?:e|ing)|render(?:ing)?|remak(?:e|ing)|build(?:ing)?|export(?:ing)?|edit(?:ing)?)\b[\s\S]{0,180}\b(?:videos?|films?|motion|animations?|mp4|blender)\b/i.test(text)
    || /\b(?:videos?|films?|motion|animations?|blender)\b[\s\S]{0,100}\b(?:create|make|produce|animate|render|remake|export)\b/i.test(text);
}
const compactRow = (row: any) => ({path:row.path,report:row.report,reportSha256:row.reportSha256,identity:row.identity,scope:row.scope,reviewStatus:row.reviewStatus,stale:row.stale === true,deliveryReady:row.deliveryReady === true,userWaiver:row.userWaiver,rejectedVideo:row.rejectedVideo,pixelHashes:row.pixelHashes ?? row.evidence?.map((e:any)=>e.sha256),referenceHashes:row.referenceHashes ?? row.references?.filter((r:any)=>r.kind==='local').map((r:any)=>r.sha256)});
const rejected = (row:any) => Boolean(row.rejectedVideo && row.rejectedVideo===row.identity?.video);

export function mediaReviewReceipt(row: any) {
  if (row.deliveryReady && !rejected(row)) return undefined;
  const state = row.stale ? 'stale' : rejected(row) ? 'needs-work after user rejection' : row.reviewStatus ?? 'unreviewed';
  return { source: 'media production', id: row.path, revision: row.identity?.video ?? row.report, state,
    line: `${path.basename(row.path)}: ${state}; ${row.report ? 'inspect current pixels/playback/audio and record video_qa verdicts' : 'run video_qa analyze and review the delivered video'}`,
    brief: `${path.basename(row.path)} still needs current visual/playback/listening review`, requiresUserWaiver: !currentUserWaiver(row) };
}
const currentUserWaiver = (row: any) => !row.stale && row.userWaiver?.report === row.report && row.userWaiver?.reviewStatus === row.reviewStatus && JSON.stringify(row.userWaiver?.identity) === JSON.stringify(row.identity) && Boolean(row.identity?.video);
export function mediaReviewWaiverIntent(text: string): boolean {
  if (/\b(?:don't|do not|never|not|no)\b[\s\S]{0,30}\b(?:waive|skip|ship|deliver)\b/i.test(text)) return false;
  return /\b(?:waive|skip)\b[\s\S]{0,55}\b(?:(?:media|video|visual|audio|listening|playback|motion)\s+(?:review|checks?)|(?:review|checks?)\s+(?:of|for)\s+(?:media|video|audio))\b/i.test(text)
    || /\b(?:ship|deliver)\b[\s\S]{0,25}\banyway\b[\s\S]{0,55}\b(?:without|unreviewed|unfinished)\b[\s\S]{0,35}\b(?:review|audio|listening|playback|visual)\b/i.test(text);
}

export function installVideoReviewEvidence(pi: any) {
  let owner: any, sid: string | undefined, epoch = 0, active = false, dispose: (() => void) | undefined;
  const rows = new Map<string, any>();
  function session(ctx: any) {
    const id = ctx?.sessionManager?.getSessionId?.() ?? ctx?.cwd;
    if (owner === ctx?.sessionManager && sid === id) return;
    dispose?.(); owner = ctx?.sessionManager; sid = id; epoch++; active = false; rows.clear();
    const snapshots = ctx?.sessionManager?.getBranch?.() ?? [];
    const saved = snapshots.findLast((e: any) => e.type === 'custom' && e.customType === ENTRY)?.data;
    if (saved && Array.isArray(saved.rows)) {
      active = saved.active === true;
      for (const row of saved.rows) if (typeof row.path === 'string') rows.set(row.path, { ...compactRow(row), stale: true, deliveryReady: false });
    } else {
      // Upgrade resumed production goals that predate the review ledger. Old
      // native QA reports still need current byte checks, never prose approval.
      const goal = snapshots.findLast((e:any)=>e.type==='custom' && e.customType==='goal-state-v1')?.data;
      if (goal && videoCreationIntent(goal.text ?? '')) for (const entry of snapshots) {
        const message=entry.type==='message' ? entry.message : undefined;
        if(message?.role!=='toolResult' || message.toolName!=='video_qa' || message.isError) continue;
        const row=message.details;
        if(row?.format==='yunuspi-video-qa-v2' && typeof row.path==='string' && typeof row.report==='string' && (!goal.createdAt || Date.parse(entry.timestamp)>=goal.createdAt)) rows.set(row.path,{...compactRow(row),stale:true,deliveryReady:false});
      }
    }
    if (owner) dispose = registerContinuationSource({ name: 'media production', session: owner,
      pending: () => [], verificationReceipts: () => active ? [...rows.values()].map(mediaReviewReceipt).filter(Boolean) as any[] : [],
    });
  }
  function persist() { try { pi.appendEntry?.(ENTRY, { active, rows: [...rows.values()] }); } catch { /* the current session still owns its review debt */ } }
  function pixels(hashes: string[]) {
    for (const row of rows.values()) if (!row.stale) row.seenHashes=[...new Set([...(row.seenHashes ?? []),...hashes.filter(hash=>(row.pixelHashes ?? []).includes(hash) || (row.referenceHashes ?? []).includes(hash))])];
  }
  async function refresh(ctx: any) {
    session(ctx);
    if (!active) return;
    const ticket = epoch;
    const signal = AbortSignal.timeout(30_000);
    for (const row of [...rows.values()]) {
      let current: any;
      try { current = row.report ? await videoQa({ action: 'status', path: row.path, report: row.report }, ctx.cwd, signal) : row; }
      catch { current = { ...row, stale: true, deliveryReady: false }; }
      if (ticket !== epoch) return;
      if(row.reportSha256 && current.reportSha256!==row.reportSha256) current={...current,reportSha256:row.reportSha256,stale:true,reviewStatus:'stale',deliveryReady:false,supersededBy:undefined};
      if (current.supersededBy?.path) {
        rows.delete(row.path);
        if (!rows.has(current.supersededBy.path)) rows.set(current.supersededBy.path,{path:current.supersededBy.path,scope:row.scope,rejectedVideo:row.rejectedVideo,reviewStatus:'unreviewed',deliveryReady:false});
        else if (row.rejectedVideo) rows.get(current.supersededBy.path).rejectedVideo ??= row.rejectedVideo;
        continue;
      }
      rows.set(row.path, { ...row, ...current });
    }
  }
  for (const event of ['session_start', 'session_switch', 'session_tree']) pi.on?.(event, async (_e: any, ctx: any) => { sid = undefined; session(ctx); await refresh(ctx); });
  pi.on?.('session_shutdown', () => { epoch++; dispose?.(); dispose = undefined; owner = undefined; rows.clear(); });
  pi.on?.('tool_result', (event:any,ctx:any) => {
    if (owner !== ctx?.sessionManager || sid !== ctx?.sessionManager?.getSessionId?.() || event.isError) return;
    if (event.toolName==='image_understand' && event.details?.observations) pixels((event.details.images ?? []).filter((source:any)=>!source.region).map((source:any)=>source.hash));
    if (event.toolName==='read' && ctx?.model?.input?.includes('image')) pixels((event.content ?? []).filter((part:any)=>part.type==='image').map((part:any)=>createHash('sha256').update(Buffer.from(part.data,'base64')).digest('hex')));
  });
  pi.on?.('before_agent_start', (event: any, ctx: any) => {
    session(ctx);
    const goal=ctx?.sessionManager?.getBranch?.().findLast((e:any)=>e.type==='custom' && e.customType==='goal-state-v1')?.data;
    if (videoCreationIntent(String(event.prompt ?? '')) || (goal?.status==='active' && videoCreationIntent(goal.text ?? ''))) active = true;
  });
  pi.on?.('input', async (event: any, ctx: any) => {
    if (!['interactive','rpc'].includes(event.source)) return;
    const text=String(event.originalText ?? event.text ?? '');
    session(ctx);
    const goal=ctx?.sessionManager?.getBranch?.().findLast((e:any)=>e.type==='custom' && e.customType==='goal-state-v1')?.data;
    if ((active || videoCreationIntent(goal?.text ?? '')) && rejectsCompletedWork(text)) {
      active = true;
      for (const row of rows.values()) if(row.identity?.video) { row.rejectedVideo=row.identity.video; row.seenHashes=[]; row.userWaiver=undefined; }
      persist();
    }
    if (!mediaReviewWaiverIntent(text)) return;
    session(ctx); const ticket = epoch;
    await refresh(ctx);
    if (ticket !== epoch || event.signal?.aborted) return;
    for (const row of rows.values()) if (!row.stale && row.identity?.video && (!row.deliveryReady || rejected(row))) row.userWaiver = { identity:row.identity,report:row.report,reviewStatus:row.reviewStatus,at:new Date().toISOString() };
    persist();
  });
  // Refresh at the actual closing call, including out-of-tool edits to the MP4,
  // sampled frames, references or project. Cached passes cannot close a goal.
  pi.on?.('tool_call', async (event: any, ctx: any) => {
    if ((event.toolName === 'goal' && event.input?.action === 'complete') || event.toolName === 'todo') await refresh(ctx);
  });
  return {
    async assertVisualReviews(params:any,ctx:any,signal?:AbortSignal) {
      session(ctx);
      if(params.action!=='record') return;
      const row=rows.get(path.resolve(ctx.cwd,params.path));
      if(row?.reportSha256 && await fileDigest(row.report,signal)!==row.reportSha256) throw Error('QA report changed outside its native review owner. Analyze current evidence again; edited metadata cannot approve delivery.');
      const appearance=(params.reviews ?? []).filter((r:any)=>['art-direction','composition','typography'].includes(r.criterion) && r.verdict==='pass');
      if(!appearance.length) return;
      const seen=new Set(row?.seenHashes ?? []);
      if(row?.report !== path.resolve(ctx.cwd,params.report) || row.stale || !(row.pixelHashes ?? []).some((hash:string)=>seen.has(hash))) throw Error('A visual pass needs current QA pixels delivered to an image-capable model or inspected by image_understand/read in this session. Metadata and measured colors cannot approve appearance.');
      if(appearance.some((r:any)=>r.criterion==='art-direction') && (row.referenceHashes ?? []).some((hash:string)=>!seen.has(hash))) throw Error('An art-direction pass also needs the current local reference pixels inspected in this session.');
    },
    async observe(name: string, params: any, result: any, ctx: any, deliveredPixels: string[] = []) {
      session(ctx);
      if ((name === 'video_render' && ['final','segments'].includes(result.mode) && result.complete !== false && result.output) || (name === 'video_ambient' && params.action === 'render' && result.output)) {
        active = true;
        const scope = `${name}:${path.resolve(ctx.cwd, params.dir ?? params.plate)}`;
        let rejectedVideo;
        for (const [key, row] of rows) if (row.scope === scope) { rejectedVideo ??= row.rejectedVideo; rows.delete(key); }
        rows.set(result.output, { path: result.output, scope, rejectedVideo, reviewStatus: 'unreviewed', deliveryReady: false });
        persist();
        return;
      }
      if (name !== 'video_qa' || !result?.report || !result?.path) return;
      const prior=rows.get(result.path);
      if(params.action==='status' && prior?.reportSha256 && result.reportSha256!==prior.reportSha256) result={...result,reportSha256:prior.reportSha256,stale:true,reviewStatus:'stale',deliveryReady:false,supersededBy:undefined};
      if(result.supersededBy?.path) {
        const {scope,rejectedVideo} = rows.get(result.path) ?? {};
        rows.delete(result.path);
        if(!rows.has(result.supersededBy.path)) rows.set(result.supersededBy.path,{path:result.supersededBy.path,scope,rejectedVideo,reviewStatus:'unreviewed',deliveryReady:false});
        else if(rejectedVideo) rows.get(result.supersededBy.path).rejectedVideo ??= rejectedVideo;
        persist(); return;
      }
      const row = { ...rows.get(result.path), path:result.path,report:result.report,reportSha256:result.reportSha256 ?? prior?.reportSha256,identity:result.identity,reviewStatus:result.reviewStatus,stale:result.stale === true,deliveryReady: result.deliveryReady === true || (result.passedAutomatedChecks === true && result.reviewStatus === 'passed') };
      if(result.format==='yunuspi-video-qa-v2') Object.assign(row,{pixelHashes:result.evidence?.map((e:any)=>e.sha256) ?? [],referenceHashes:(result.references ?? []).filter((r:any)=>r.kind==='local').map((r:any)=>r.sha256),seenHashes:[]});
      rows.set(result.path, row);
      pixels(deliveredPixels);
      // Trim settled history only. Pending deliveries cannot disappear merely
      // because a session produced more than sixteen clips.
      let settled = [...rows.values()].filter(row=>row.deliveryReady && !rejected(row));
      while (settled.length > 16) rows.delete(settled.shift().path);
      persist();
    },
    refresh,
  };
}
