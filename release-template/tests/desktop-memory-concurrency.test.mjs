import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';

test('independent session processes commit to one project vector index without losing each other’s records', { timeout: 20_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'shared/memory.sqlite');
  const module = pathToFileURL(path.resolve(import.meta.dirname, '../agent/extensions/lib/project-vector-store.ts')).href;
  const source = `import {openProjectStore} from ${JSON.stringify(module)};
    const [file,session]=process.argv.slice(1),store=openProjectStore(file,{projectId:'project-example'});
    for(let i=0;i<40;i++)store.upsertChunk({id:session+'-'+i,project_id:'project-example',session_id:session,source_type:'decision',title:'Concurrent decision',text:session+' independent memory '+i,content_hash:session+'-hash-'+i});
    store.close();`;
  await Promise.all(['session-a', 'session-b', 'session-c'].map(session => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, database, session], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-3000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(error || `writer exit ${code}`)));
  })));
  const shared = openProjectStore(database, { projectId: 'project-example' });
  const other = openProjectStore(path.join(root, 'other/memory.sqlite'), { projectId: 'other-example' });
  try {
    assert.equal(shared.counts().chunks, 120);
    for (const session of ['session-a', 'session-b', 'session-c']) assert.equal(shared.getChunk(`${session}-39`).session_id, session);
    assert.equal(other.counts().chunks, 0, 'a separate project never inherits another project index');
  } finally { shared.close(); other.close(); }
});
