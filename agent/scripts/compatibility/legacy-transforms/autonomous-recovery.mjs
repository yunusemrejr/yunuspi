// Durable root/scoped-child retry ownership + fail-closed request gate. No inner retry or tool replay policy changes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const gateMarker = 'PI_AUTONOMOUS_REQUEST_GATE_V1';
const identifier = '[A-Za-z_$][\\w$]*';
const recoveryHead = new RegExp(`async _prepareRetry\\((${identifier})\\)\\s*\\{`, 'g');
function recoveryPreamble(message, version = 4) {
  return `
 /* PI_AUTONOMOUS_RECOVERY_V${version} */
${version >= 4 ? ` const _piRecoveryChildAllowed=(()=>{if(process.env.PI_SUBAGENT_CHILD!=="1")return true;try{const encoded=process.env.PI_SUBAGENT_RECOVERY_ROUTES??"";if(encoded.length>8192)return false;const routes=JSON.parse(encoded||"[]");return Array.isArray(routes)&&routes.length>=2&&routes.length<=8&&new Set(routes).size===routes.length&&routes.every(route=>typeof route==="string"&&route.length<=512&&route.includes("/")&&!/[\\s\\x00-\\x1f]/.test(route));}catch{return false;}})();\n` : ''} if(${version >= 4 ? '_piRecoveryChildAllowed' : 'process.env.PI_SUBAGENT_CHILD!=="1"'} && this.settingsManager.getRetrySettings().enabled && this._extensionRunner.hasHandlers("pi_provider_recovery")) {
   if(${message}.content?.some(b=>b.type==="toolCall")) return false;
   const controller=new AbortController(); this._retryAbortController=controller;
   const event={type:"pi_provider_recovery",message:${message},signal:controller.signal,decision:undefined};
   try { await this._extensionRunner.emit(event);
     if(controller.signal.aborted) return false;
     if(event.decision!==undefined) {
       if(event.decision==="retry") {
         ${version >= 2 ? 'this._flushPendingCustomMessages();' : ''}this.agent.state.messages=this.agent.state.messages.filter(m=>m!==${message});
         return true;
       }
       return false;
     }
   } finally { ${version >= 3 ? 'if(this._retryAbortController===controller)' : ''}this._retryAbortController=undefined; }
 }
 `;
}
export function patchRecovery(source) {
  const heads = [...source.matchAll(recoveryHead)];
  if (heads.length !== 1) throw Error(`autonomous recovery: expected one retry seam, found ${heads.length}`);
  const [head] = heads, start = head.index + head[0].length;
  const markers = source.match(/PI_AUTONOMOUS_RECOVERY_V\w*/g) ?? [];
  if (!markers.length) {
    if (source.includes('const event={type:"pi_provider_recovery",message:'))
      throw Error('autonomous recovery: markerless recovery patch drift');
    return source.slice(0, start) + recoveryPreamble(head[1]) + source.slice(start);
  }
  if (markers.length !== 1) throw Error('autonomous recovery: duplicate or partial recovery patch');
  for (const version of [4, 3, 2, 1]) {
    const old = recoveryPreamble(head[1], version);
    if (markers[0] === `PI_AUTONOMOUS_RECOVERY_V${version}` && source.startsWith(old, start))
      return source.slice(0, start) + recoveryPreamble(head[1]) + source.slice(start + old.length);
  }
  throw Error('autonomous recovery: recovery patch postcondition drift');
}
export function patchRequestGate(source) {
  const heads = [...source.matchAll(/async emitBeforeProviderRequest\(/g)];
  if (heads.length !== 1) throw Error(`autonomous recovery: expected one provider request gate, found ${heads.length}`);
  const start = heads[0].index;
  const end = source.indexOf('async emitBeforeProviderHeaders(', start);
  if (end < 0) throw Error('autonomous recovery: missing provider request gate boundary');
  const region = source.slice(start, end);
  const catches = [...region.matchAll(new RegExp(`catch\\s*\\((${identifier})\\)\\s*\\{`, 'g'))];
  if (catches.length !== 1) throw Error(`autonomous recovery: expected one request catch, found ${catches.length}`);
  const [caught] = catches, offset = caught.index + caught[0].length;
  const guard = `/* ${gateMarker} */if(${caught[1]}?.code==="PI_AUTONOMOUS_REQUEST_DENIED")throw ${caught[1]};`;
  const markers = source.match(/PI_AUTONOMOUS_REQUEST_GATE_V\w*/g) ?? [];
  if (markers.length) {
    if (markers.length === 1 && markers[0] === gateMarker && region.startsWith(guard, offset)) return source;
    throw Error('autonomous recovery: request gate postcondition drift');
  }
  if (region.includes('PI_AUTONOMOUS_REQUEST_DENIED'))
    throw Error('autonomous recovery: markerless request gate drift');
  return source.slice(0, start + offset) + guard + source.slice(start + offset);
}
/** Capture the turn signal once: lazy context getters may later point at a new turn. */
export function patchHookCancellation(source) {
  const start=source.indexOf('async emitBeforeProviderRequest(');
  const end=source.indexOf('async emitBeforeProviderHeaders(',start);
  if(start<0||end<0) throw Error('request cancellation: missing lifecycle owner');
  const region=source.slice(start,end);
  const context=region.match(/(?:const|let) ([\w$]+)\s*=\s*this\.createContext\(\)[^;]*;/);
  const dispatch=region.match(/await ([\w$]+)\((?:\{[^}]+\}|[\w$]+),\s*([\w$]+)\)/);
  const gate=region.match(/\/\* PI_AUTONOMOUS_REQUEST_GATE_V1 \*\/if\(([\w$]+)\?\.code==="PI_AUTONOMOUS_REQUEST_DENIED"\)throw \1;/);
  if(!context||!dispatch||!gate) throw Error('request cancellation: hook anchors drift');
  const capture=`/* PI_REQUEST_HOOK_SIGNAL_V1 */const _piRequestSignal=${context[1]}.signal;_piRequestSignal?.throwIfAborted();`;
  const check='_piRequestSignal?.throwIfAborted();';
  const rethrow='if(_piRequestSignal?.aborted)throw _piRequestSignal.reason;';
  if(region.includes('PI_REQUEST_HOOK_SIGNAL_V1')) {
    if((region.match(/PI_REQUEST_HOOK_SIGNAL_V1/g)??[]).length!==1||!region.includes(context[0]+capture)||!region.includes(dispatch[0]+';'+check)||!region.includes(gate[0]+rethrow)) throw Error('request cancellation: applied hook drift');
    return source;
  }
  const next=region.replace(context[0],context[0]+capture).replace(dispatch[0]+';',dispatch[0]+';'+check).replace(gate[0],gate[0]+rethrow);
  if(next===region) throw Error('request cancellation: no change');
  return patchHookCancellation(source.slice(0,start)+next+source.slice(end));
}

export function targets() {
  if (!process.env.PI_HARNESS_PATCH_TEST_CORE) throw Error("Legacy transform targets are test-only; set an isolated fixture core explicitly");
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim(),
    '@yunuspi/coding-agent',
  );
  const chunks = path.join(core, 'dist/bundle/chunks');
  const bundles = fs.readdirSync(chunks).filter(name => name.endsWith('.js')).map(name => path.join(chunks, name));
  const locate = (name, anchor) => {
    const matches = bundles.filter(file => fs.readFileSync(file, 'utf8').includes(anchor));
    if (matches.length !== 1) throw Error(`autonomous recovery: expected one bundle ${name} owner, found ${matches.length}`);
    return matches[0];
  };
  const specs = [
    [path.join(core, 'dist/core/agent-session.js'), patchRecovery],
    [locate('retry', 'async _prepareRetry('), patchRecovery],
    [path.join(core, 'dist/core/extensions/runner.js'), source => patchHookCancellation(patchRequestGate(source))],
    [locate('request gate', 'async emitBeforeProviderRequest('), source => patchHookCancellation(patchRequestGate(source))],
  ];
  return specs.map(([file, patch]) => ({
    name: `autonomous recovery: ${path.relative(core, file)}`, file,
    exists: () => fs.existsSync(file),
    isApplied() {
      try { const source = fs.readFileSync(file, 'utf8'); return patch(source) === source; }
      catch { return false; }
    },
    apply() {
      // An update must not leave one runtime repaired while a sibling has drifted.
      for (const [target, transform] of specs) transform(fs.readFileSync(target, 'utf8'));
      const source = fs.readFileSync(file, 'utf8'), next = patch(source);
      if (source === next) return;
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
      const temp = `${file}.recovery-${process.pid}`;
      try {
        fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode });
        fs.renameSync(temp, file);
      } finally { fs.rmSync(temp, { force: true }); }
    },
  }));
}
