import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const UNIT = /^(?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2}){1,200}\.(?:service|socket|timer|target|mount|automount|path|scope|slice)$/;
const CURSOR = /^[A-Za-z0-9;=_:-]{1,1024}$/;
const PROPERTIES = ['Id','LoadState','ActiveState','SubState','UnitFileState','MainPID','ControlPID','Result','ExecMainCode','ExecMainStatus','NRestarts','Restart','ActiveEnterTimestampMonotonic','InactiveEnterTimestampMonotonic','StateChangeTimestampMonotonic'];
type Runner = (binary:string,args:string[],signal?:AbortSignal)=>Promise<string>;
export type ServiceProbeOptions = {unit?:string;cursor?:string;lookbackSeconds?:number;user?:boolean};

const nativeRun: Runner = async (binary,args,signal) => {
  try {
    const user = args.includes('--user') && typeof process.getuid === 'function' ? {XDG_RUNTIME_DIR:`/run/user/${process.getuid()}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${process.getuid()}/bus`} : {};
    const result = await execute(binary,args,{signal,timeout:5000,maxBuffer:512*1024,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',SYSTEMD_PAGER:'cat',SYSTEMD_COLORS:'0',...user}});
    return result.stdout;
  } catch (error:any) {
    signal?.throwIfAborted();
    if(error?.code==='ENOENT')throw Error('System inspection command is unavailable');
    if(error?.killed || error?.signal || error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw Error('System inspection exceeded its time or output limit');
    throw Error('System inspection failed; the service manager or journal may be unavailable or inaccessible');
  }
};

/** Fixed read-only arguments, explicit unit and allowlisted response fields. */
export async function serviceProbe(action:string,limit:number,options:ServiceProbeOptions,signal?:AbortSignal,run:Runner=nativeRun) {
  signal?.throwIfAborted();
  const unit=options.unit;
  if(typeof unit!=='string'||!UNIT.test(unit)||unit.startsWith('-'))throw Error('Specify one exact systemd unit name with its suffix; patterns and paths are unsupported');
  if(options.cursor!==undefined&&(!CURSOR.test(options.cursor)||typeof options.cursor!=='string'))throw Error('Invalid journal cursor');
  if(options.lookbackSeconds!==undefined&&(!Number.isSafeInteger(options.lookbackSeconds)||options.lookbackSeconds<1||options.lookbackSeconds>86400))throw Error('lookbackSeconds must be 1–86400');
  if(options.user!==undefined&&typeof options.user!=='boolean')throw Error('user must be a boolean');
  limit=Number.isSafeInteger(limit)?Math.min(200,Math.max(1,limit)):100;
  const manager=options.user?['--user']:[];
  if(action==='service_detail'){
    if(options.cursor!==undefined||options.lookbackSeconds!==undefined)throw Error('Cursor and time window apply only to journal');
    const text=await run('/usr/bin/systemctl',[...manager,'show','--no-pager',`--property=${PROPERTIES.join(',')}`,'--',unit],signal);
    signal?.throwIfAborted();
    if(Buffer.byteLength(text)>32768)throw Error('Service metadata exceeds output limit');
    const values:Record<string,string|number>={};
    for(const line of text.split('\n')){
      const match=/^([A-Za-z]+)=(.*)$/.exec(line);
      if(!match||!PROPERTIES.includes(match[1]))continue;
      const [,key,value]=match;
      if(!value){values[key]='';continue;}
      if(key==='Id'){if(UNIT.test(value))values[key]=value;continue;}
      if(/^\d{1,16}$/.test(value)&&Number.isSafeInteger(Number(value)))values[key]=Number(value);
      else if(/^[a-zA-Z0-9_-]{1,80}$/.test(value))values[key]=value;
    }
    if(!Object.keys(values).length)throw Error('No recognized service metadata returned');
    return {action,unit,manager:options.user?'user':'system',rows:[values],scope:'Observed manager state only. No commands, environment values or unit file contents; no service mutation.'};
  }
  if(action!=='journal')throw Error('Unsupported service inspection action');
  const lookback=options.lookbackSeconds??(options.cursor?undefined:3600);
  const args=[...manager,'--no-pager','--quiet','--output=json','--output-fields=__CURSOR,__REALTIME_TIMESTAMP,PRIORITY,_PID,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT',`--lines=+${limit+1}`,`${options.user?'--user-unit':'--unit'}=${unit}`];
  if(options.cursor)args.push(`--after-cursor=${options.cursor}`);
  if(lookback!==undefined)args.push(`--since=-${lookback} seconds`);
  const text=await run('/usr/bin/journalctl',args,signal);
  signal?.throwIfAborted();
  if(Buffer.byteLength(text)>512*1024)throw Error('Journal metadata exceeds output limit');
  const raw=text.split('\n').filter(line=>line.trim());
  if(raw.length>limit+1)throw Error('Journal exceeded requested entry bound');
  const parsed=raw.map(line=>{try{return JSON.parse(line);}catch{throw Error('Invalid journal metadata JSON');}});
  const rows=parsed.slice(0,limit).map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.__CURSOR!=='string'||!CURSOR.test(value.__CURSOR))throw Error('Journal entry has no usable cursor');
    const row:Record<string,string|number>={};
    for(const [field,label] of [['__REALTIME_TIMESTAMP','timestamp_us'],['PRIORITY','priority'],['_PID','pid']]){
      const v=value[field];if(typeof v==='string'&&/^\d{1,20}$/.test(v))row[label]=v;
    }
    for(const field of ['_SYSTEMD_UNIT','_SYSTEMD_USER_UNIT'])if(typeof value[field]==='string'&&UNIT.test(value[field]))row[field]=value[field];
    return row;
  });
  const last=parsed[Math.min(parsed.length,limit)-1];
  return {action,unit,manager:options.user?'user':'system',rows,truncated:parsed.length>limit,next_cursor:last?.__CURSOR??options.cursor??null,...(lookback!==undefined?{lookback_seconds:lookback}:{}),scope:'Forward journal metadata page visible to the current user; no MESSAGE, hostname, identifiers, commands or environment. Empty results do not establish system-wide absence. Cursor resumption depends on retained journal entries.'};
}
