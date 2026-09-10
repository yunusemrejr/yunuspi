import {spawnSync} from 'node:child_process';
/** Explicit repository/index ownership for managed worktree operations.
 * Keep normal Git conversion semantics; never inherit another session's
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE or config injection overrides. */
export function runManagedGit(cwd:string,args:string[],indexFile?:string) {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',...(indexFile?{GIT_INDEX_FILE:indexFile}:{})});
 const result=spawnSync('git',['-c','core.fsmonitor=false','-C',cwd,...args],{env,encoding:'utf-8',windowsHide:true,timeout:30000,maxBuffer:32*1024*1024});
 return {stdout:result.stdout??'',stderr:result.stderr||result.error?.message||'',status:result.status,...(result.error?{error:result.error}:{})};
}
