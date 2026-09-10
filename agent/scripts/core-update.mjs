// Invoked by auto-update.sh under the shared update/repair lock.
// Stage npm separately; preserve the exact patched core until validation passes.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const PACKAGE='@earendil-works/pi-coding-agent';
const scripts=path.dirname(fileURLToPath(import.meta.url));
export function customizationDigest(agent) {
 const hash=createHash('sha256');let bytes=0,files=0;
 const skip=new Set(['node_modules','.git','cache','.cache','logs','sessions','artifacts','backups','worktrees']);
 const visit=file=>{
  if(++files>30000) throw Error('Customization inventory exceeds validation limit');
  const stat=fs.lstatSync(file);hash.update(path.relative(agent,file)+'\0');
  if(stat.isSymbolicLink()){hash.update('link:'+fs.readlinkSync(file));return;}
  if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())if(!skip.has(name))visit(path.join(file,name));return;}
  if(!stat.isFile())return;
  bytes+=stat.size;if(bytes>512*1024*1024)throw Error('Customization inventory exceeds 512MiB validation limit');
  hash.update(fs.readFileSync(file));
 };
 for(const entry of ['extensions','skills','scripts','settings.json','npm/package.json','npm/package-lock.json']){
  const file=path.join(agent,entry);if(fs.existsSync(file))visit(file);
 }
 return hash.digest('hex');
}
export function activePiProcesses(core) {
 const found=[];
 if(process.platform!=='linux') throw Error('Cannot attest idle Pi processes on this platform; update deferred');
 for(const entry of fs.readdirSync('/proc')) {
  if(!/^\d+$/.test(entry)||Number(entry)===process.pid) continue;
  try {
   const args=fs.readFileSync(`/proc/${entry}/cmdline`,'utf8').split('\0');
   if(args.some(arg=>arg.startsWith(core+path.sep)||/^(?:pi|pi\.m?js)$/.test(path.basename(arg)))) found.push(Number(entry));
  } catch(error) { if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code)) throw error; }
 }
 return found;
}
const writeJournal=(file,data)=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
export function recoverInterruptedUpdate(core,journal) {
 if(!fs.existsSync(journal)) return false;
 const record=JSON.parse(fs.readFileSync(journal,'utf8'));
 if(record.core!==core||record.backup!==path.join(path.dirname(core),'.pi-core-last-good')||record.rejected!==path.join(path.dirname(core),'.pi-core-rejected')) throw Error('Update journal paths do not match this installation');
 if(!['prepared','validating','validated'].includes(record.phase))throw Error('Unknown update journal phase');
 if(record.phase==='validated') {if(!fs.existsSync(core))throw Error('Validated core missing; preserve recovery state');fs.rmSync(journal);return false; }
 if(fs.existsSync(record.backup)) {
  if(fs.existsSync(core)) { if(fs.existsSync(record.rejected)) throw Error('Previous rejected core still exists; preserve it and resolve before recovery'); fs.renameSync(core,record.rejected); }
  fs.renameSync(record.backup,core);
 }
 if(!fs.existsSync(core)) throw Error('Interrupted update has no recoverable core');
 fs.rmSync(journal);return true;
}
export async function promoteCandidate({core,candidate,journal,validate,idle=()=>[]}) {
 if(idle().length) throw Object.assign(Error('Pi sessions are active; update deferred'),{code:'PI_UPDATE_BUSY'});
 recoverInterruptedUpdate(core,journal);
 const backup=path.join(path.dirname(core),'.pi-core-last-good'),rejected=path.join(path.dirname(core),'.pi-core-rejected');
 if(fs.existsSync(rejected)) fs.rmSync(rejected,{recursive:true});
 if(fs.existsSync(backup)) fs.rmSync(backup,{recursive:true});
 const record={core,backup,rejected,phase:'prepared'};
 writeJournal(journal,record);
 try {
  fs.renameSync(core,backup);
  fs.renameSync(candidate,core);
  writeJournal(journal,{...record,phase:'validating'});
  await validate();
  writeJournal(journal,{...record,phase:'validated'});
  fs.rmSync(journal);
  return {updated:true,backup};
 } catch(error) {
  recoverInterruptedUpdate(core,journal);
  throw Error(`Candidate rejected; previous core restored: ${error.message}`,{cause:error});
 }
}
async function main() {
 if(process.env.PI_HARNESS_LOCK_HELD!=='1') throw Error('Run auto-update.sh: the shared update lock is required');
 const command=(bin,args,options={})=>execFileSync(bin,args,{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,...options});
 const core=path.join(command('npm',['root','-g']).trim(),PACKAGE);
 const logDir=path.join(os.homedir(),'.pi/agent/logs');fs.mkdirSync(logDir,{recursive:true});
 const journal=path.join(logDir,'core-update-transaction.json');
 const idle=()=>activePiProcesses(core);
 if(idle().length) throw Object.assign(Error('Pi sessions active; leaving installed core unchanged'),{code:'PI_UPDATE_BUSY'});
 if(recoverInterruptedUpdate(core,journal)) console.log('Restored previous core after interrupted update');
 if(process.argv.includes('--recover')) return;
 // Do not replace an already unhealthy baseline or modify local forks/skills to mask it.
 command(process.execPath,[path.join(scripts,'verify-harness.mjs')]);
 const agent=path.dirname(scripts), baselineDigest=customizationDigest(agent);
 if(!fs.lstatSync(core).isDirectory())throw Error('Unsupported linked core installation; leaving it unchanged');
 const installed=JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8'));
 const stage=fs.mkdtempSync(path.join(path.dirname(core),'.pi-update-stage-'));
 try {
  command('npm',['install','--global','--prefix',stage,'--ignore-scripts','--no-audit','--no-fund',PACKAGE+'@latest'],{timeout:300000});
  const candidate=path.join(stage,'lib/node_modules',PACKAGE);
  const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8'));
  if(manifest.name!==PACKAGE) throw Error('Unexpected staged package identity');
  if(manifest.version===installed.version){console.log(`Pi ${installed.version} already current`);return;}
  if(JSON.stringify(manifest.bin)!==JSON.stringify(installed.bin)) throw Error('Upstream CLI entrypoints changed; review before activation');
  if(customizationDigest(agent)!==baselineDigest)throw Error('Customizations changed during staging; retry against a stable snapshot');
  const result=await promoteCandidate({core,candidate,journal,idle,validate:async()=>{
   command(process.execPath,[path.join(scripts,'verify-harness.mjs'),'--fix']);
   for(const test of ['retry-lifecycle-test.mjs','summary-recovery-test.mjs','automatic-compaction-test.mjs','hook-lifecycle-integrity-test.mjs','tool-integrity-test.mjs','skill-pack-routing-test.mjs','reasoning-aids-loader-test.mjs','session-recovery-guidance-test.mjs','autonomous-recovery-test.mjs','atomic-edit-preflight-test.mjs']) {
    const output=command(process.execPath,['--experimental-strip-types',path.join(scripts,'bench',test)],{env:{...process.env,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_MEMORY_EXIT_SUMMARY:'0',PI_MEMORY_QMD_UPDATE:'off'}});
    fs.writeFileSync(path.join(logDir,'update-'+test+'.log'),output,{mode:0o600});
   }
   command(process.execPath,[path.join(scripts,'verify-harness.mjs')]);
   if(customizationDigest(agent)!==baselineDigest)throw Error('Customizations changed during validation; candidate is not attested');
  }});
  console.log(`Validated Pi update ${installed.version} → ${manifest.version}; rollback copy: ${result.backup}`);
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
 console.error(error.message);process.exitCode=error.code==='PI_UPDATE_BUSY'?75:1;
});
