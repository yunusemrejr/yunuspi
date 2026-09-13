// Invoked by auto-update.sh under the shared update/repair lock.
// Stage npm separately; preserve the exact patched core until validation passes.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CORE_COMPATIBILITY_TESTS} from './lib/core-compatibility.mjs';
const PACKAGE='@earendil-works/pi-coding-agent';
const scripts=path.dirname(fileURLToPath(import.meta.url));
export function launcherSpec(core) {
 const prefix=path.resolve(core,'../../../..');
 const manifest=JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8'));
 const entry=manifest.bin?.pi;
 if(typeof entry!=='string'||path.isAbsolute(entry)||entry.split(/[\\/]/).includes('..'))throw Error('Unsupported Pi CLI entrypoint');
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 return {file:path.join(prefix,'bin/pi'),source:`#!/usr/bin/env bash\n# PI_HARNESS_LAUNCHER_V1\nexec /bin/bash ${quote(path.join(scripts,'pi-launch.sh'))} ${quote(path.join(prefix,'bin/node'))} ${quote(path.join(core,entry))} "$@"\n`};
}
export function attestLock(fd,file,flag) {
 const held=fs.fstatSync(fd),expected=fs.statSync(file);
 if(process.env[flag]!=='1'||held.ino!==expected.ino||held.dev!==expected.dev)throw Error('Run auto-update.sh: inherited update/session lock is required');
 // An open descriptor and an environment flag are not proof of ownership.
 // flock uses the inherited open-file description, so this cannot self-deadlock.
 const stdio=Array.from({length:fd+1},(_,i)=>i===fd?fd:i<3?'pipe':'ignore');
 execFileSync('flock',['-n','-E','75',String(fd)],{stdio,timeout:5000});
}
export function candidateCommandArgs(core,candidate,bin,args) {
 return ['--unshare-user','--unshare-pid','--unshare-net','--ro-bind','/','/',
  '--bind',candidate,core,'--tmpfs','/tmp','--proc','/proc','--dev-bind','/dev','/dev',
  '--cap-drop','ALL','--die-with-parent','--',bin,...args];
}
export function customizationDigest(agent) {
 const hash=createHash('sha256');let bytes=0,files=0;
 const seen=new Set();
 const skip=new Set(['node_modules','.git','cache','.cache','logs','sessions','artifacts','backups','worktrees']);
 const visit=file=>{
  if(++files>30000) throw Error('Customization inventory exceeds validation limit');
  const stat=fs.lstatSync(file);hash.update(path.relative(agent,file)+'\0'+(stat.mode&0o777)+'\0');
  if(stat.isSymbolicLink()){
   hash.update('link:'+fs.readlinkSync(file));
   const resolved=fs.realpathSync(file);
   if(!seen.has(resolved)){seen.add(resolved);visit(resolved);}
   return;
  }
  if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())if(!skip.has(name))visit(path.join(file,name));return;}
  if(!stat.isFile())return;
  bytes+=stat.size;if(bytes>512*1024*1024)throw Error('Customization inventory exceeds 512MiB validation limit');
  hash.update(fs.readFileSync(file));
 };
 for(const entry of ['extensions','skills','scripts','settings.json','models.json','npm/package.json','npm/package-lock.json']){
  const file=path.join(agent,entry);if(fs.existsSync(file))visit(file);
 }
 const settingsFile=path.join(agent,'settings.json');
 if(fs.existsSync(settingsFile)){
  const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
  for(const entry of settings.skills??[]){
   if(typeof entry!=='string'||entry.startsWith('!'))continue;
   const file=entry.startsWith('~/')?path.join(os.homedir(),entry.slice(2)):path.resolve(agent,entry);
   if(fs.existsSync(file))visit(file);else hash.update('missing skill:'+file);
  }
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
const syncDirectory=dir=>{const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const identity=file=>{const s=fs.lstatSync(file);if(!s.isDirectory())throw Error('Core transaction requires real directories');return `${s.dev}:${s.ino}`;};
const writeJournal=(file,data)=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);syncDirectory(path.dirname(file));};
const clearJournal=file=>{fs.rmSync(file);syncDirectory(path.dirname(file));};
export function recoverInterruptedUpdate(core,journal) {
 if(!fs.existsSync(journal)) return false;
 const record=JSON.parse(fs.readFileSync(journal,'utf8'));
 if(record.core!==core||record.backup!==path.join(path.dirname(core),'.pi-core-last-good')||record.rejected!==path.join(path.dirname(core),'.pi-core-rejected')) throw Error('Update journal paths do not match this installation');
 if(!['prepared','validating','validated'].includes(record.phase))throw Error('Unknown update journal phase');
 if(record.phase==='validated') {if(!fs.existsSync(core))throw Error('Validated core missing; preserve recovery state');if(record.candidateIdentity&&identity(core)!==record.candidateIdentity)throw Error('Validated core identity changed; preserve recovery state');clearJournal(journal);return false; }
 if(fs.existsSync(record.backup)) {
  if(record.originalIdentity&&identity(record.backup)!==record.originalIdentity)throw Error('Rollback core identity changed; preserve recovery state');
  if(fs.existsSync(core)) { if(fs.existsSync(record.rejected)) throw Error('Previous rejected core still exists; preserve it and resolve before recovery'); fs.renameSync(core,record.rejected); }
  fs.renameSync(record.backup,core);
  syncDirectory(path.dirname(core));
 }
 if(!fs.existsSync(core)) throw Error('Interrupted update has no recoverable core');
 if(record.originalIdentity ? identity(core)!==record.originalIdentity : record.phase==='validating'&&!fs.existsSync(record.rejected))throw Error('Previous core cannot be attested; preserve recovery state');
 clearJournal(journal);return true;
}
export async function promoteCandidate({core,candidate,journal,validate,idle=()=>[]}) {
 if(idle().length) throw Object.assign(Error('Pi sessions are active; update deferred'),{code:'PI_UPDATE_BUSY'});
 recoverInterruptedUpdate(core,journal);
 const backup=path.join(path.dirname(core),'.pi-core-last-good'),rejected=path.join(path.dirname(core),'.pi-core-rejected');
 if(fs.existsSync(rejected)) fs.rmSync(rejected,{recursive:true});
 if(fs.existsSync(backup)) fs.rmSync(backup,{recursive:true});
 const record={core,backup,rejected,phase:'prepared',originalIdentity:identity(core),candidateIdentity:identity(candidate)};
 writeJournal(journal,record);
 try {
  fs.renameSync(core,backup);
  syncDirectory(path.dirname(core));
  fs.renameSync(candidate,core);
  syncDirectory(path.dirname(core));
  writeJournal(journal,{...record,phase:'validating'});
  await validate();
  writeJournal(journal,{...record,phase:'validated'});
  clearJournal(journal);
  return {updated:true,backup};
 } catch(error) {
  try { recoverInterruptedUpdate(core,journal); }
  catch(recoveryError) { throw Error(`Candidate validation failed: ${error.message}; rollback incomplete: ${recoveryError.message}. Preserve ${journal}`,{cause:error}); }
  throw Error(`Candidate rejected; previous core restored: ${error.message}`,{cause:error});
 }
}
async function main() {
 const args=process.argv.slice(2);
 if(args.length>1||args.some(arg=>!['--recover','--rehearse','--force'].includes(arg)))throw Error('Usage: core-update.mjs [--recover|--rehearse|--force] (under auto-update locks)');
 const rehearse=args.includes('--rehearse');
 const logDir=path.join(os.homedir(),'.pi/agent/logs');fs.mkdirSync(logDir,{recursive:true});
 attestLock(9,path.join(logDir,'harness-update.lock'),'PI_HARNESS_LOCK_HELD');
 attestLock(8,path.join(logDir,'harness-session.lock'),'PI_HARNESS_SESSION_LOCK_HELD');
 const command=(bin,args,{logFile,...options}={})=>{
  try {
   const output=execFileSync(bin,args,{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,...options});
   if(logFile)fs.writeFileSync(logFile,output,{mode:0o600});
   return output;
  }
  catch(error){
   const output=[error.stdout,error.stderr].filter(Boolean).map(text=>String(text).slice(-8000)).join('\n');
   if(logFile)fs.writeFileSync(logFile,output||error.message,{mode:0o600});
   throw Error(`Update command failed: ${[bin,...args].join(' ')} (${error.code||`exit ${error.status}`})${output?'\n'+output:''}`,{cause:error});
  }
 };
 // execFileSync closes extra descriptors by default. The verifier validates
 // FD 9 as well as the flag; without forwarding it, it waits on our own lock.
 // Forward only to the verifier, not npm or the behavioral test subprocesses.
 const verify=(...args)=>command(process.execPath,[path.join(scripts,'verify-harness.mjs'),...args],{
  stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore',8,9],
 });
 const core=path.join(command('npm',['root','-g']).trim(),PACKAGE);
 const journal=path.join(logDir,'core-update-transaction.json');
 const idle=()=>activePiProcesses(core);
 if(idle().length) throw Object.assign(Error('Pi sessions active; leaving installed core unchanged'),{code:'PI_UPDATE_BUSY'});
 if(recoverInterruptedUpdate(core,journal)) console.log('Restored previous core after interrupted update');
 if(process.argv.includes('--recover')) return;
 // Do not replace an already unhealthy baseline or modify local forks/skills to mask it.
 verify();
 const agent=path.dirname(scripts), baselineDigest=customizationDigest(agent);
 if(!fs.lstatSync(core).isDirectory())throw Error('Unsupported linked core installation; leaving it unchanged');
 const installed=JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8'));
 const stage=fs.mkdtempSync(path.join(path.dirname(core),'.pi-update-stage-'));
 try {
  command('npm',['install','--global','--prefix',stage,'--ignore-scripts','--no-audit','--no-fund',PACKAGE+'@'+(rehearse?installed.version:'latest')],{timeout:300000});
  const candidate=path.join(stage,'lib/node_modules',PACKAGE);
  const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8'));
  if(manifest.name!==PACKAGE) throw Error('Unexpected staged package identity');
  if(!rehearse&&!args.includes('--force')&&manifest.version===installed.version){console.log(`Pi ${installed.version} already current`);return;}
  if(JSON.stringify(manifest.bin)!==JSON.stringify(installed.bin)) throw Error('Upstream CLI entrypoints changed; review before activation');
  if(customizationDigest(agent)!==baselineDigest)throw Error('Customizations changed during staging; retry against a stable snapshot');
  // Patches and tests see the candidate at the canonical package path in a
  // private mount namespace. Local forks, settings, skills and the live core
  // stay read-only; unavailable isolation rejects the update before activation.
  const staged=(bin,args,options={})=>command('/usr/bin/bwrap',candidateCommandArgs(core,candidate,bin,args),options);
  const stagedVerify=(...args)=>staged(process.execPath,[path.join(scripts,'verify-harness.mjs'),...args,'--staged'],{
   stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore',8,9],
   logFile:path.join(logDir,args.includes('--fix')?'update-staged-repair.log':'update-staged-verify.log'),
  });
  stagedVerify('--fix');
  for(const test of CORE_COMPATIBILITY_TESTS) {
    const output=staged(process.execPath,['--experimental-strip-types',path.join(scripts,'compatibility',test)],{env:{...process.env,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_MEMORY_EXIT_SUMMARY:'0',PI_MEMORY_QMD_UPDATE:'off'}});
    fs.writeFileSync(path.join(logDir,'update-'+test+'.log'),output,{mode:0o600});
   }
  stagedVerify();
  if(customizationDigest(agent)!==baselineDigest)throw Error('Customizations changed during validation; candidate is not attested');
  if(rehearse){console.log(`Rehearsal passed for pristine Pi ${manifest.version}; installed core retained`);return;}
  const result=await promoteCandidate({core,candidate,journal,idle,validate:async()=>{
   verify();
   if(customizationDigest(agent)!==baselineDigest)throw Error('Customizations changed during validation; candidate is not attested');
  }});
  console.log(`Validated Pi update ${installed.version} → ${manifest.version}; rollback copy: ${result.backup}`);
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
 console.error(error.message);process.exitCode=error.code==='PI_UPDATE_BUSY'?75:1;
});
