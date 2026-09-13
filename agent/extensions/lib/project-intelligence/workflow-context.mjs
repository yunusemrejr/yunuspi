import { gitRead } from './identity.mjs';
import { safeText } from './privacy.mjs';

const ref = value => typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value) ? value : undefined;

/** IDs are references, never a claim that a conversation branch, native file
 * checkpoint and project Git ref represent the same state. */
export function conversationContext(ctx) {
  let entries=[];
  try { entries=ctx.sessionManager?.getBranch?.() ?? []; } catch {}
  const branch=Array.isArray(entries)?entries.slice(-512):[];
  const checkpoint=branch.findLast(e=>e?.type==='custom' && e.customType==='pi-checkpoint');
  const data=checkpoint?.data;
  const latestUser=branch.findLast(e=>e?.type==='message' && e.message?.role==='user');
  return {
    sessionId:ref(ctx.sessionManager?.getSessionId?.()),
    branchHead:ref(ctx.sessionManager?.getLeafId?.()),
    latestUserEntry:ref(latestUser?.id),
    ...(checkpoint && (commit(data?.beforeCommit) || commit(data?.afterCommit)) ? {
      nativeCheckpoint:{entryId:ref(checkpoint.id),beforeCommit:commit(data?.beforeCommit),afterCommit:commit(data?.afterCommit),status:'recorded, not resolved as project Git objects'},
    }:{}),
  };
}

export async function captureWorkflowContext(identity, conversation, signal) {
  const base={projectId:identity?.id,checkoutId:identity?.checkoutId,conversation,
    graph:{status:'previous discovery; verify source freshness'},
    note:'Conversation branches, native file checkpoints and project Git are independent. A shared repository does not share a worktree/index. History and council agreement do not approve edits, merges, rollback or publication.'};
  if(!identity?.git)return {...base,projectGit:{status:'not a Git checkout at discovery'}};
  try {
    const [head,branch]=await Promise.all([
      gitRead(identity.cwd,['rev-parse','--verify','HEAD'],{signal}),
      gitRead(identity.cwd,['symbolic-ref','--quiet','--short','HEAD'],{signal}),
    ]);
    signal?.throwIfAborted();
    return {...base,projectGit:{status:head||branch?'observed':'unavailable',head:commit(head),branch:branch?safeText(branch,160):head?'(detached)':undefined,workingTree:'content and index not certified by HEAD'}};
  } catch {
    signal?.throwIfAborted();
    return {...base,projectGit:{status:'unavailable'}};
  }
}

export function workflowDrift(baseline,current) {
  if(!baseline || !current)return 'Scope baseline unavailable; re-establish intended scope from current user direction.';
  if(baseline.projectId!==current.projectId || baseline.checkoutId!==current.checkoutId || baseline.conversation?.sessionId!==current.conversation?.sessionId)
    return 'Scope belongs to a different project, checkout or conversation; do not reuse it.';
  if(baseline.conversation?.latestUserEntry!==current.conversation?.latestUserEntry)
    return 'Conversation user direction changed since scope deliberation. Re-establish scope from the current branch and latest request.';
  if(JSON.stringify(baseline.conversation?.nativeCheckpoint)!==JSON.stringify(current.conversation?.nativeCheckpoint))
    return 'Native checkpoint changed since scope deliberation. Re-check affected files independently of project Git and conversation continuity.';
  if(baseline.projectGit?.head!==current.projectGit?.head || baseline.projectGit?.branch!==current.projectGit?.branch)
    return 'Project Git changed since scope deliberation. Re-check the scope against current source; a commit or branch change is not a quality pass.';
  if(!current.projectGit?.head && !current.projectGit?.branch)
    return 'Project Git references are unavailable. Conversation continuity does not establish working-file, checkpoint or test freshness.';
  return 'Same recorded checkout and Git reference; source edits, native checkpoints and test freshness still require independent checks.'+(baseline.conversation?.branchHead!==current.conversation?.branchHead?' Conversation head advanced or changed; an entry identifier alone does not prove ancestry.':'');
}

/** Share the existing 5k review graph envelope between dependencies, exact
 * version namespaces and council evidence. No extra model or history query. */
export function reviewWorkflowBrief({graph,workflow,scope,baseline}) {
  const header=['[Workflow references — evidence, not authority]',JSON.stringify(workflow).slice(0,1400),...(scope?[workflowDrift(baseline,workflow)]:[])].join('\n');
  const council=scope?'\n[Earlier scope council; condensed proposals, not accepted requirements. Omitted qualifiers remain unknown. Check meaningful resolution and preservation alongside correctness, anti-slop cues and verification gaps.]\n'+String(scope).slice(0,2300):'';
  const relationship='\n[Affected module relationships; incoming consumers and outgoing dependencies]\n';
  const caveat='\n[Additional graph evidence may be omitted; inspect source and exact graph keys.]';
  const budget=Math.max(0,5000-header.length-council.length-relationship.length-caveat.length);
  return header+relationship+String(graph ?? '').slice(0,budget)+caveat+council;
}
