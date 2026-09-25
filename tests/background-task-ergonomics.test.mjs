import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const {BackgroundTaskRegistry}=await jiti.import('../agent/extensions/pi-background-tasks/src/core/registry.ts');
const {servicePort,serviceNotificationOnly,isPersistentService}=await jiti.import('../agent/extensions/pi-background-tasks/src/core/service-policy.ts');
const {selfMatchingSignal}=await jiti.import('../agent/extensions/lib/bash-routing.ts');

test('real finished tasks resolve by name and notify with their output tail', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-bg-ergonomics-'));
 const sent=[];
 const registry=new BackgroundTaskRegistry({sendCompletionNotification:message=>sent.push(message)});
 try {
  const ctx={cwd:root,sessionId:'session-a',modelRegistry:{getAll:()=>[]}};
  const task=await registry.startTask(ctx,"printf 'compiling\\nerror: Missing symbol Foo at Bar.java:12\\n'; exit 1",{name:'targeted compile',isAgent:false,notifyOnCompletion:true,triggerOnCompletion:true});
  for(let i=0;i<200&&!sent.length;i++) await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(registry.resolveTask('targeted compile').id,task.id,'bg tools accept the name notifications lead with');
  assert.match(sent[0].content,/<output-tail>[\s\S]*Missing symbol Foo at Bar\.java:12/,'a failure carries its cause, not only the exit code');
  assert.match(sent[0].content,/Do not call bg_status or bg_logs to reconfirm/);
  assert.throws(()=>registry.resolveTask('unknown-server'),/Known: .*targeted compile/);
 } finally { await registry.stopAllRunning?.('shutdown'); fs.rmSync(root,{recursive:true,force:true}); }
});

test('services declared explicitly never wake the agent and record their port', () => {
 assert.equal(servicePort('./run.sh --no-open --port 8791 2>&1'),8791);
 assert.equal(servicePort('uvicorn app:api --host 0.0.0.0 --port=9000'),9000);
 assert.equal(servicePort('node --test'),undefined);
 assert.equal(serviceNotificationOnly({command:'./run.sh --no-open --port 8791',service:true}),true);
 assert.equal(serviceNotificationOnly({command:'./run.sh --self-test'}),false);
 assert.equal(isPersistentService('uvicorn app:api'),true);
});

test('self-match advice ignores redirections and terminating pkill (host safety owns that block)', () => {
 assert.equal(selfMatchingSignal("pkill -f 'com.mailgenie.Main' 2>/dev/null; echo done"),null);
 assert.equal(selfMatchingSignal('pgrep -f 2>/dev/null'),null);
 const advice=selfMatchingSignal("pgrep -f com.mailgenie.Main 2>/dev/null");
 assert.equal(advice?.replacement,"pgrep -f '[c]om.mailgenie.Main'");
});

test('an empty curl response piped into a JSON parser gets its cause named', async () => {
 const {emptyJsonPipeHint}=await jiti.import('../agent/extensions/lib/bash-routing.ts');
 const failure=[{type:'text',text:'Traceback (most recent call last):\njson.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)'}];
 assert.match(emptyJsonPipeHint('curl -s -m 30 "http://127.0.0.1:8791/api/search" | python3 -c "import sys,json; json.load(sys.stdin)"',failure),/empty or non-JSON output/);
 assert.equal(emptyJsonPipeHint('python3 parse.py',failure),null);
});

test('a redundant cd into the session cwd is detected', async () => {
 const {redundantCdPrefix}=await jiti.import('../agent/extensions/lib/bash-routing.ts');
 assert.equal(redundantCdPrefix('cd /srv/app && ls','/srv/app'),true);
 assert.equal(redundantCdPrefix('cd "/srv/app/" && ls','/srv/app'),true);
 assert.equal(redundantCdPrefix('cd /srv/app/sub && ls','/srv/app'),false);
 assert.equal(redundantCdPrefix('ls','/srv/app'),false);
});
