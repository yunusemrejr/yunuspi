import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences } from '@yunuspi/tui';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';
import registerSignals from '../agent/extensions/session-signals.ts';
import { withSessionWriteLock } from '../core/coding-agent/src/utils/session-write-lock.js';
import { FooterComponent } from '../core/coding-agent/src/modes/interactive/components/footer.js';
import { initTheme } from '../core/coding-agent/src/modes/interactive/theme/theme.js';

initTheme('dark', false);

const model = {id:'main',name:'Synthetic',provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',
  input:['text'],reasoning:false,contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const type = 'auxiliary-model-usage-v1';
const receipt = (id, total) => ({id,owner:'image-generate',provider:'fixture',model:'helper',status:'completed',
  usage:{cost:{total,source:'provider-reported'}}});

async function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'yunuspi-live-accounting-'));
  const manager = SessionManager.create(cwd,cwd);
  manager.appendMessage({role:'assistant',provider:model.provider,model:model.id,api:model.api,timestamp:1,
    content:[{type:'text',text:'Synthetic result.'}],stopReason:'stop',
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:.02,source:'provider-reported'}}});
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const resourceLoader = new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noContextFiles:true,
    noPromptTemplates:true,noSkills:true,noThemes:true});
  await resourceLoader.reload();
  const modelRuntime = {
    getModel:() => model,getAvailable:() => [model],hasConfiguredAuth:() => false,isUsingSubscription:() => false,
    streamSimple() { assert.fail('The accounting fixture must not dispatch a model.'); },
  };
  const {session} = await createAgentSession({cwd,agentDir:cwd,noTools:'all',model,modelRuntime,resourceLoader,settingsManager,
    sessionManager:manager,thinkingLevel:'off'});
  const footer = new FooterComponent(session,{getGitBranch:() => undefined,getAvailableProviderCount:() => 1,getExtensionStatuses:() => new Map()});
  t.after(() => { footer.dispose(); session.dispose(); rmSync(cwd,{recursive:true,force:true}); });
  const file = manager.getSessionFile();
  return {file,cwd,manager,session,leaf:manager.getLeafId(),render:() => footer.render(120).map(stripTerminalSequences).join('\n'),
    append:manager.bindAccountingReceipt(type)};
}

async function terminalCost(manager) {
  const commands = new Map();
  registerSignals({ on() {}, registerTool() {}, registerCommand: (name, command) => commands.set(name, command) });
  let report;
  await commands.get('cost').handler('', { sessionManager: manager, hasUI: false, ui: { notify: text => { report = text; } } });
  return report;
}

function untilAccountingUpdate(session) {
  let unsubscribe, timer;
  return Promise.race([
    new Promise(resolve => { unsubscribe = session.subscribe(event => { if (event.type === 'accounting_updated') resolve(); }); }),
    new Promise((_,reject) => { timer = setTimeout(() => reject(Error('No active accounting notification arrived')),8_000); }),
  ]).finally(() => { unsubscribe?.(); clearTimeout(timer); });
}

function appendInAnotherProcess(file, cwd, rows) {
  const module = new URL('../core/coding-agent/src/core/session-manager.js', import.meta.url).href;
  const script = `import {SessionManager} from ${JSON.stringify(module)};
      const [file,cwd,rows] = process.argv.slice(1);
      const append = SessionManager.open(file,cwd,cwd).bindAccountingReceipt(${JSON.stringify(type)});
      for (const data of JSON.parse(rows)) if (!append(data)) throw Error('Detached receipt rejected');`;
  execFileSync(process.execPath,['--input-type=module','-e',script,file,cwd,JSON.stringify(rows)],{timeout:10_000});
}

test('live footer replays separate durable receipts in disk order without changing navigation or parsing local appends', async t => {
  const {file,cwd,session,manager,leaf,render,append} = await fixture(t);
  const previousOpen = fs.open;
  let reads = 0;
  fs.open = (name,...args) => {
    if (name === file) reads++;
    return previousOpen(name,...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = previousOpen; syncBuiltinESMExports(); });

  append(receipt('local-first',.001));
  for (let i=0;i<20;i++) assert.match(render(),/\$0\.021000 total/);
  await delay(100);
  assert.equal(reads,0);
  const refresh = untilAccountingUpdate(session);
  appendInAnotherProcess(file,cwd,[receipt('detached',.03),receipt('corrected',.05)]);
  // The local append follows unseen rows and may not advance past them.
  append(receipt('corrected',.01));
  const originalBranch = manager.getBranch();
  await refresh;
  assert.equal(session.getSessionStats().costLabel,'$0.061000');
  assert.match(render(),/\$0\.061000 total/);
  assert.deepEqual(manager.getAccountingEntries().filter(row => row.customType === type).map(row => row.data.id),
    ['local-first','detached','corrected','corrected']);
  assert.equal(manager.getEntries().some(row => row.data?.id === 'detached'),false);
  assert.equal(manager.getLeafId(),leaf);
  assert.deepEqual(manager.getBranch(),originalBranch);
  assert.equal(reads,1);
  append(receipt('local-after-replay',.004));
  for (let i=0;i<20;i++) assert.match(render(),/\$0\.065000 total/);
  await delay(100);
  assert.equal(reads,1);
  assert.match(await terminalCost(manager), /\$0\.065000 total/);
  manager.createBranchedSession(leaf);
  assert.equal(session.getSessionStats().costLabel, '$0.065000', 'a branch retains its externally settled receipt');
});

test('same-inode transcript changes refresh billing, budget refusal is visible, and another inode cannot take ownership', async t => {
  const {file,session,manager,leaf,render,append} = await fixture(t);
  append(receipt('corrected',.01));
  const lines = readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);
  lines.at(-1).data.usage.cost.total = .04;
  const updated = lines.map(row => JSON.stringify(row)).join('\n')+'\n';
  let refresh = untilAccountingUpdate(session);
  withSessionWriteLock(file,() => writeFileSync(file,updated));
  await refresh;
  assert.equal(session.getSessionStats().costLabel,'$0.060000');
  assert.equal(manager.getLeafId(),leaf);

  refresh = untilAccountingUpdate(session);
  withSessionWriteLock(file,() => truncateSync(file,128*1024*1024+1));
  await refresh;
  assert.equal(session.getSessionStats().accountingIncomplete,true);
  assert.match(render(),/\$\? total/);

  refresh = untilAccountingUpdate(session);
  withSessionWriteLock(file,() => writeFileSync(file,updated));
  await refresh;
  assert.equal(session.getSessionStats().costLabel,'$0.060000');
  assert.equal(session.getSessionStats().accountingIncomplete,undefined);

  refresh = untilAccountingUpdate(session);
  renameSync(file,file+'.old');
  lines.at(-1).data.usage.cost.total = 99;
  writeFileSync(file,lines.map(row => JSON.stringify(row)).join('\n')+'\n');
  await refresh;
  assert.equal(session.getSessionStats().costLabel,'$?');
  assert.equal(session.getSessionStats().cost,.06,'the new inode has no authority over the old session');
  assert.equal(manager.getLeafId(),leaf);
});

test('damaged ledger records keep the total unknown until a clean revision is read', async t => {
  const { file, session, manager, render } = await fixture(t);
  const clean = readFileSync(file, 'utf8');
  let update = untilAccountingUpdate(session);
  withSessionWriteLock(file, () => writeFileSync(file, clean + '{"type":"custom",broken}\n'));
  await update;
  assert.equal(session.getSessionStats().accountingIncomplete, true);
  assert.match(render(), /\$\? total/);
  assert.match(await terminalCost(manager), /\$\? total/);
  const reopened = SessionManager.open(file);
  assert.equal(reopened.isAccountingIncomplete(), true, 'reopening a damaged ledger keeps its coverage unknown');

  update = untilAccountingUpdate(session);
  withSessionWriteLock(file, () => writeFileSync(file, clean));
  await update;
  assert.equal(session.getSessionStats().costLabel, '$0.020000');
});
