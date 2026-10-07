import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.join(root, '..', 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/task-pipelines.ts')));
const { selectTaskPipelines, automaticPipelineTools, createPipelineLedger, recordPipelineEvidence, pendingPipelineStages, nextPipelineStages, buildPipelineContext, inspectPipelineSource, resolveRoutingTask, pipelineToolExcluded } = await import(pathToFileURL(path.join(agent, 'extensions/lib/task-pipelines.ts')));
const { classifyExecution } = await import(pathToFileURL(path.join(agent, 'extensions/lib/adaptive-execution.ts')));
const selected = (prompt, extra = {}) => selectTaskPipelines({ prompt, ...extra });
const automatic = (prompt, extra = {}) => automaticPipelineTools(selected(prompt, extra), { prompt, ...extra });
const coordinate = { scope: 'task:fixture', revision: 'tree:observed-bytes' };
const record = (selection, ledger, stageId, evidenceKind, extra = {}) => recordPipelineEvidence(ledger, { ...coordinate, stageId, status: 'passed', evidenceKind, source: `native:${stageId}:call-1`, ...extra }, selection);
function settle(selection, ledger) {
  for (const stage of selection.stages) record(selection, ledger, stage.id, stage.evidenceKinds[0]);
}

test('a direct question and an explicit workflow opt-out have no pipeline overhead', () => {
  for (const prompt of ['What is Go?', 'Explain JavaScript event loops', 'Can you go to the documentation?', 'Write a Python answer without tools']) {
    assert.deepEqual(selected(prompt).ids, []);
    assert.equal(buildPipelineContext(selected(prompt), createPipelineLedger(), coordinate), undefined);
  }
});

test('relevant file metadata selects language pipelines without scanning tool prose or skill paths', () => {
  const expected = new Map([
    ['src/index.php', 'php'], ['src/worker.mjs', 'node'], ['src/main.go', 'go'], ['src/main.rs', 'rust'],
    ['src/Main.java', 'java'], ['src/api.py', 'python'], ['scripts/build.bash', 'bash'], ['src/main.c', 'c'], ['src/main.cpp', 'cpp'],
  ]);
  for (const [file, id] of expected) assert.ok(selected('Fix the affected behavior', { files: [file] }).ids.includes(id), file);
  assert.deepEqual(selected('Fix the typo', { files: ['skills/java/SKILL.md', 'node_modules/library/index.ts', 'vendor/test.php'] }).ids, []);
  assert.ok(!selected('Fix JavaScript event handling', { files: ['public/app.html'] }).ids.includes('java'));
});

test('React CDN and normal React edition stay distinct, while shared frontend validators deduplicate', () => {
  const cdn = selected('Build a React.js app via CDN with pinned script tags');
  assert.ok(cdn.ids.includes('react-cdn'));
  assert.ok(!cdn.ids.includes('react-node'));
  assert.ok(!cdn.ids.includes('node'));
  const node = selected('Fix the React app state', { files: ['src/App.tsx', 'package.json'], dependencies: { react: '^19' } });
  assert.ok(node.ids.includes('react-node'));
  assert.ok(node.ids.includes('node'));
  assert.ok(!node.ids.includes('react-cdn'));
  assert.equal(new Set(node.stages.map(stage => stage.id)).size, node.stages.length);
  assert.equal(new Set(node.skills).size, node.skills.length);
  assert.equal(new Set(node.tools).size, node.tools.length);
});

test('recurring stacks and fine-tuning preparation choose their installed skills and appropriate evidence', () => {
  assert.ok(selected('Fix Flask session validation', { files: ['app.py'] }).ids.includes('python-flask'));
  assert.ok(selected('Build a vanilla frontend local webapp on localhost').ids.includes('vanilla-frontend'));
  assert.ok(selected('Build a Linux-native C/C++ application').ids.includes('linux-native'));
  const algorithms = selected('Implement an AI/ML algorithm and benchmark its boundary cases');
  assert.ok(algorithms.ids.includes('algorithms'));
  assert.ok(algorithms.ids.includes('ai-ml'));
  const prepared = selected('Prepare a Google Colab QLoRA fine-tuning notebook');
  for (const id of ['colab', 'finetuning', 'ai-ml']) assert.ok(prepared.ids.includes(id));
  assert.ok(prepared.skills.includes('google-colab-training'));
  assert.ok(!prepared.stages.some(stage => stage.id === 'training-smoke'), 'preparing a notebook does not require a paid run');
  const live = selected('Run Google Colab QLoRA fine-tuning and evaluate the exported model');
  assert.ok(live.stages.some(stage => stage.id === 'training-smoke'));
  assert.ok(live.stages.some(stage => stage.id === 'model-evaluation'));
});

test('shared-host deployment plans cannot turn into claims of a live deployment', () => {
  const plan = selected('Prepare a deployment pipeline through Git and SSH on Namecheap');
  assert.ok(plan.ids.includes('git-ssh-deploy'));
  assert.ok(plan.tools.includes('ssh_plan'));
  assert.ok(!plan.stages.some(stage => stage.id === 'deploy-remote'));
  assert.match(plan.stages[0].check, /actual cPanel\/VPS\/SSH support/);
  const live = selected('Deploy the PHP website through Git and SSH to GoDaddy');
  assert.deepEqual(live.stages.filter(stage => stage.id.startsWith('deploy-')).map(stage => stage.id), ['deploy-preflight', 'deploy-remote', 'deploy-live']);
  assert.deepEqual(live.stages.find(stage => stage.id === 'deploy-live').evidenceKinds, ['live']);
  assert.deepEqual(live.stages.find(stage => stage.id === 'seo-live').evidenceKinds, ['live']);
  assert.ok(live.stages.find(stage => stage.id === 'seo-live').dependsOn.includes('deploy-remote'));
});

test('stage ordering and native evidence requirements block premature delivery and source-only UI approval', () => {
  const selection = selected('Fix the vanilla frontend form', { files: ['public/index.html'] });
  const ledger = createPipelineLedger();
  assert.deepEqual(nextPipelineStages(selection, ledger, coordinate).map(stage => stage.id), ['discovery']);
  assert.throws(() => record(selection, ledger, 'delivery', 'artifact'), /unresolved prerequisite/);
  record(selection, ledger, 'discovery', 'inspection');
  record(selection, ledger, 'implementation', 'artifact');
  record(selection, ledger, 'validation', 'execution');
  assert.throws(() => record(selection, ledger, 'ui-pixels', 'execution'), /requires pixels/);
  assert.throws(() => record(selection, ledger, 'ui-interaction', 'pixels'), /requires interaction/);
  assert.throws(() => record(selection, ledger, 'delivery', 'artifact'), /unresolved prerequisite/);
  record(selection, ledger, 'ui-pixels', 'pixels');
  record(selection, ledger, 'ui-responsive', 'inspection');
  record(selection, ledger, 'ui-interaction', 'interaction');
  record(selection, ledger, 'seo-raw', 'inspection');
  record(selection, ledger, 'seo-content', 'assessment');
  record(selection, ledger, 'delivery', 'artifact');
  assert.deepEqual(pendingPipelineStages(selection, ledger, coordinate), []);
  assert.equal(buildPipelineContext(selection, ledger, coordinate), undefined);
});

test('passed receipts deduplicate in unchanged scope and content, while stale revisions and todo scopes revalidate', () => {
  const selection = selected('Fix the Go service');
  const ledger = createPipelineLedger();
  settle(selection, ledger);
  assert.equal(record(selection, ledger, 'delivery', 'artifact').recorded, false);
  assert.equal(ledger.receipts.length, selection.stages.length);
  assert.deepEqual(nextPipelineStages(selection, ledger, { ...coordinate, revision: 'tree:changed' }).map(stage => stage.id), ['discovery']);
  assert.deepEqual(nextPipelineStages(selection, ledger, { ...coordinate, scope: 'todo:another-task' }).map(stage => stage.id), ['discovery']);
});

test('a new upstream failure invalidates delivery and its descendants without reopening unrelated UI validation', () => {
  const selection = selected('Fix the frontend login form', { files: ['index.html'] });
  const ledger = createPipelineLedger();
  settle(selection, ledger);
  record(selection, ledger, 'validation', 'execution', { status: 'failed', source: 'project_tests:failure:call-2' });
  const pending = pendingPipelineStages(selection, ledger, coordinate);
  assert.deepEqual(pending.map(stage => stage.id), ['validation', 'delivery']);
  assert.equal(pending[0].failures, 1);
  assert.equal(pending[1].ready, false);
  record(selection, ledger, 'validation', 'execution', { source: 'project_tests:passed:call-3' });
  assert.deepEqual(nextPipelineStages(selection, ledger, coordinate).map(stage => stage.id), ['delivery']);
});

test('repeated failure receipts stay bounded without evicting the current prerequisite evidence', () => {
  const selection = selected('Fix the Rust CLI');
  const ledger = createPipelineLedger();
  record(selection, ledger, 'discovery', 'inspection');
  record(selection, ledger, 'implementation', 'artifact');
  for (let i = 0; i < 300; i++) record(selection, ledger, 'validation', 'execution', { status: 'failed', source: `project_tests:failure:${i}` });
  const next = nextPipelineStages(selection, ledger, coordinate);
  assert.equal(next[0].id, 'validation');
  assert.equal(next[0].failures, 300);
  assert.equal(ledger.receipts.length, 3);
});

test('blocked evidence remains unresolved, context is bounded, and malformed receipts fail loudly', () => {
  const selection = selected('Improve UI/UX and remove design slop', { files: ['app.html'] });
  const ledger = createPipelineLedger();
  record(selection, ledger, 'discovery', 'assessment', { status: 'blocked', summary: 'The requested application is unavailable' });
  assert.equal(nextPipelineStages(selection, ledger, coordinate)[0].status, 'blocked');
  assert.throws(() => record(selection, ledger, 'unknown-stage', 'inspection'), /Unknown pipeline stage/);
  assert.throws(() => record(selection, ledger, 'discovery', 'inspection', { source: '' }), /native evidence source/);
  assert.throws(() => record(selection, ledger, 'discovery', 'inspection', { source: 2 }), /native evidence source/);
  assert.throws(() => record(selection, ledger, 'discovery', 'inspection', { revision: '' }), /content revision/);
  const context = buildPipelineContext(selection, ledger, { ...coordinate, maxChars: 300 });
  assert.ok(context.length <= 300);
  assert.equal(buildPipelineContext(selection, ledger, { ...coordinate, maxChars: 100 }), undefined);
  assert.match(selection.stages[0].check, /real content, tokens and components/);
  assert.match(selection.stages[0].check, /template identities, fake proof/);
});

test('a plain JavaScript function receives runtime discovery without mandatory UI review', () => {
  const selection = selected('Fix the JavaScript function', { files: ['src/math.js'] });
  assert.ok(selection.ids.includes('frontend-js'));
  assert.ok(!selection.ids.includes('ui-quality'));
  assert.ok(!selection.stages.some(stage => stage.id === 'ui-pixels'));
  assert.ok(selected('Implement this routine in Go').ids.includes('go'));
});

test('every selected skill and tool is actually shipped by the runtime', () => {
  const selection = selected('Build PHP8+ Node.js frontend vanilla React CDN Go service Rust Java Python Flask Bash C/C++ Linux-native local webapp AI/ML algorithm Colab LoRA fine-tuning UI and deploy through Git SSH on Namecheap');
  for (const name of selection.skills) assert.ok(fs.existsSync(path.join(agent, 'skills', name, 'SKILL.md')), name);
  const metadataPath = [path.join(root, 'docs/CAPABILITIES.json'), path.join(agent, 'public-template/docs/CAPABILITIES.json')].find(file => fs.existsSync(file));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const registered = new Set(Object.values(metadata.tools).flatMap(value => Array.isArray(value) ? value : []).map(value => typeof value === 'string' ? value : value.name));
  // Factory registration belongs to the checkpoints owner and can predate an
  // inventory refresh. Require its actual native registration in source.
  const projectTests = fs.readFileSync(path.join(agent, 'extensions/lib/project-tests.ts'), 'utf8');
  assert.match(projectTests, /name: 'project_tests'/);
  registered.add('project_tests');
  for (const name of selection.tools) assert.ok(registered.has(name), `No registered runtime tool named ${name}`);
});

test('backend-only website fixes do not force unrelated visual reviews', () => {
  const selection = selected('Fix the PHP API authentication on the website', { files: ['api/auth.php'] });
  assert.ok(selection.ids.includes('php'));
  assert.ok(!selection.ids.includes('ui-quality'));
  assert.ok(!selection.stages.some(stage => stage.id === 'ui-pixels'));
});

test('inspected training dependencies and notebooks activate local ML preparation without pretending Colab is connected', () => {
  const selection = selected('Fix checkpoint recovery', { files: ['experiments/train.ipynb'], dependencies: ['torch', 'peft'] });
  for (const id of ['python', 'ai-ml', 'finetuning']) assert.ok(selection.ids.includes(id));
  assert.ok(!selection.ids.includes('colab'));
  assert.ok(!selection.stages.some(stage => stage.id === 'training-smoke'), 'fixing training code does not require a full model-training run');
});

test('ordinary language fixes retain the complete catalog without eager optional schemas', () => {
  for (const prompt of ['Fix the Node.js parser bug', 'Fix the Python conversion bug', 'Fix the JavaScript function and merge two arrays']) {
    const selection = selected(prompt), names = automaticPipelineTools(selection, { prompt });
    assert.ok(selection.tools.includes('code_quality') && selection.tools.includes('git_info'), 'optional stage tools remain discoverable');
    assert.ok(names.includes('project_tests') && names.includes('read'));
    for (const name of ['code_quality', 'git_info', 'task_pipeline']) assert.ok(!names.includes(name), `${prompt}: ${name}`);
    assert.deepEqual(names, automaticPipelineTools(selection, { prompt, profile: classifyExecution({ task: prompt }) }), 'initial intent and the live initial profile share admission');
  }
});

test('source-quality intent and consequential or failed scopes activate quality without unrelated Git', () => {
  for (const prompt of ['Refactor the Node.js parser', 'Audit the Python source', 'Review Node.js architecture', 'Run code_quality on the Node.js parser']) {
    assert.ok(automatic(prompt).includes('code_quality'), prompt);
    assert.ok(!automatic(prompt).includes('git_info'), prompt);
  }
  for (const profile of [{ tier: 'complex', failures: 0 }, { tier: 'critical', failures: 0 }, { tier: 'standard', failures: 2 }]) {
    const names = automatic('Fix the Node.js parser', { profile });
    assert.ok(names.includes('code_quality'));
    assert.ok(!names.includes('git_info'));
    assert.equal(names.includes('task_pipeline'),profile.tier==='complex'||profile.tier==='critical');
  }
});

test('required UI and hosting tools are available immediately while explicit workflow and Git intents remain effective', () => {
  const ui = automatic('Fix a one-line vanilla frontend label typo');
  for (const name of ['browser_session', 'render_see', 'design_audit', 'quality_review']) assert.ok(ui.includes(name), name);
  assert.ok(!ui.includes('git_info'));
  const deploy = automatic('Deploy the PHP website through Git SSH to GoDaddy');
  for (const name of ['git_info', 'ssh_plan', 'env_audit', 'net_probe', 'browser_session']) assert.ok(deploy.includes(name), name);
  assert.ok(automatic('Prepare a Node.js workflow').includes('task_pipeline'));
  assert.ok(automatic('Fix the Node.js parser and inspect Git history').includes('git_info'));
  assert.ok(automatic('Fix the Node.js parser', { files: ['.git/config'] }).includes('git_info'), 'observed repository metadata is a concrete Git need');
  for (const prompt of ['Fix the Node.js parser without Git', 'Fix the Node.js parser. Do not use git.', 'Fix the Node.js parser; no-Git reporting is needed.'])
    assert.ok(!automatic(prompt, { files: ['.git/config'] }).includes('git_info'), prompt);
});

test('3D, SEO, LLM-application and API-automation work get their own evidence-staged pipelines', () => {
  const blender = selected('Model a low-poly lighthouse in Blender and export a glTF for the web');
  assert.ok(blender.ids.includes('blender-3d'));
  assert.deepEqual(blender.skills.filter(name => name.startsWith('blender') || name === 'gaussian-splatting'), ['blender-production', 'gaussian-splatting']);
  assert.ok(blender.tools.includes('blender_inspect') && blender.tools.includes('blender_render'));
  assert.ok(!blender.tools.includes('project_tests') && !blender.tools.includes('code_quality'), 'a render task is judged on frames, not on project tests');
  const ledger = createPipelineLedger();
  record(blender, ledger, 'discovery', 'inspection');
  record(blender, ledger, 'implementation', 'artifact');
  record(blender, ledger, 'validation', 'execution');
  assert.throws(() => record(blender, ledger, 'render-pixels', 'execution'), /requires pixels/, 'a script exit or inspection cannot settle appearance');
  assert.throws(() => record(blender, ledger, 'delivery', 'artifact'), /unresolved prerequisite/);
  record(blender, ledger, 'render-pixels', 'pixels');
  record(blender, ledger, 'delivery', 'artifact');
  assert.deepEqual(pendingPipelineStages(blender, ledger, coordinate), []);
  assert.ok(selected('Fix the exporter script', { files: ['assets/lighthouse.glb'] }).ids.includes('blender-3d'), 'observed 3D file evidence selects the pipeline');
  assert.deepEqual(selected('What is a glb file?').ids, [], 'a question without file evidence adds no overhead');

  const seo = selected('Fix our technical SEO: canonical tags, sitemap.xml and robots.txt are inconsistent');
  assert.ok(seo.ids.includes('seo'));
  assert.ok(seo.tools.includes('web_probe'));
  assert.ok(seo.stages.some(stage => stage.id === 'seo-raw' && /seo_toolkit/.test(stage.check)));
  assert.ok(seo.stages.some(stage => stage.id === 'validation' && /submitted\/crawled\/indexed differ/.test(stage.check)));
  assert.ok(automatic('Fix our technical SEO: canonical tags, sitemap.xml and robots.txt are inconsistent').includes('web_probe'));

  const llm = selected('Build an LLM agent with retrieval-augmented generation and prompt injection guardrails');
  assert.ok(llm.ids.includes('llm-app'));
  const llmLedger = createPipelineLedger();
  record(llm, llmLedger, 'discovery', 'inspection');
  record(llm, llmLedger, 'implementation', 'artifact');
  assert.throws(() => record(llm, llmLedger, 'llm-evaluation', 'execution'), /requires evaluation/, 'passing tests is not a frozen-set comparison against a baseline');
  record(llm, llmLedger, 'llm-evaluation', 'evaluation');

  const automation = selected('Build a workflow automation across several third-party APIs with webhooks, idempotency keys and retry with backoff');
  assert.ok(automation.ids.includes('api-automation'));
  assert.ok(automation.stages.some(stage => stage.id === 'validation' && /failure-injection/.test(stage.check) && /idempotent re-run/.test(stage.check)));
  assert.ok(automation.tools.includes('http_request'));
});

test('questions about the new domains and unrelated mentions add no pipeline overhead', () => {
  for (const prompt of ['What is SEO?', 'Explain how Gaussian splatting works', 'Who invented the webhook?', 'Why is Blender called Blender?']) {
    assert.deepEqual(selected(prompt).ids, [], prompt);
  }
  assert.deepEqual(selected('Rename the mesh variable in the geometry helper').ids.filter(id => ['blender-3d', 'seo', 'llm-app', 'api-automation'].includes(id)), []);
});

test('the new pipelines name only shipped skills and registered tools', () => {
  const selection = selected('Build a Blender scene, fix SEO canonical tags, build an LLM agent with RAG, and build an API integration workflow with webhooks');
  for (const id of ['blender-3d', 'seo', 'llm-app', 'api-automation']) assert.ok(selection.ids.includes(id), id);
  for (const name of selection.skills) assert.ok(fs.existsSync(path.join(agent, 'skills', name, 'SKILL.md')), name);
  const metadataPath = [path.join(root, 'docs/CAPABILITIES.json'), path.join(agent, 'public-template/docs/CAPABILITIES.json')].find(file => fs.existsSync(file));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const registered = new Set(Object.values(metadata.tools).flatMap(value => Array.isArray(value) ? value : []).map(value => typeof value === 'string' ? value : value.name));
  registered.add('project_tests');
  for (const name of selection.tools) assert.ok(registered.has(name), `No registered runtime tool named ${name}`);
});

test('ordinary imperative requests activate their pipeline even without a classic build/fix verb', () => {
  const requests = {
    'Generate a REST API in Go': 'go', 'Convert this Python script to Rust': 'rust', 'Export the Blender scene as glTF': 'blender-3d',
    'Model a lighthouse in Blender': 'blender-3d', 'Animate the logo in the video': 'video', 'Migrate the PHP app to Go': 'php',
    'Configure the Flask app for production': 'python-flask', 'Rewrite the Bash installer': 'bash', 'Cut the interview video': 'video',
    'Trim the audio track': 'audio', 'Schedule the Python job with cron': 'python', 'Scrape the pricing page with Python': 'python',
  };
  for (const [prompt, id] of Object.entries(requests)) assert.ok(selected(prompt).ids.includes(id), `${prompt} -> ${id}`);
  for (const prompt of ['Which port does the Go service use?', 'How do I configure Flask?', 'Who wrote the Python parser?', 'What model is this?', 'Tell me about the Java model', 'Describe how the audio narration works'])
    assert.deepEqual(selected(prompt).ids, [], prompt);
});

test('office documents and folder organization get their own pipelines, only for real requests', () => {
  const office = selected('Create an Excel workbook with a monthly budget and totals');
  assert.deepEqual(office.ids, ['office-docs']);
  assert.ok(office.tools.includes('office_doc') && office.tools.includes('deliverable_check'));
  assert.ok(!office.tools.includes('project_tests') && !office.tools.includes('code_quality'), 'a workbook is judged on the file, not on project tests');
  assert.ok(selected('Make a pitch deck pptx for our seed round').ids.includes('office-docs'));
  assert.ok(selected('Fill in the invoice template', { files: ['invoice.xlsx'] }).ids.includes('office-docs'));
  const folders = selected('Organize my Downloads folder by file type');
  assert.deepEqual(folders.ids, ['file-organization']);
  assert.ok(folders.tools.includes('fs_organize'));
  assert.match(folders.stages.find(stage => stage.id === 'discovery').check, /fs_organize scan/);
  for (const prompt of ['my desktop is a mess, tidy it up', 'Rename all the scanned invoices in ~/Documents/scans to include the date', 'Declutter the photos folder']) assert.ok(selected(prompt).ids.includes('file-organization'), prompt);
  for (const prompt of ['What is a spreadsheet?', 'Summarize the quarterly numbers in report.docx', 'Rename the files in the repo to kebab-case', 'Organize the functions in this module', 'Explain how a workbook differs from a worksheet'])
    assert.deepEqual(selected(prompt).ids.filter(id => ['office-docs', 'file-organization'].includes(id)), [], prompt);
  for (const selection of [office, folders]) {
    for (const name of selection.skills) assert.ok(fs.existsSync(path.join(agent, 'skills', name, 'SKILL.md')), name);
    const sources = ['deliverables.ts', 'fs-organize.ts'].map(file => fs.readFileSync(path.join(agent, 'extensions', file), 'utf8')).join('\n');
    for (const name of selection.tools.filter(name => ['office_doc', 'deliverable_check', 'fs_organize'].includes(name))) assert.match(sources, new RegExp(`name: "${name}"`), name);
  }
});

test('tabular data work gets a profile-then-reconcile checklist, and code work on parsers does not', () => {
  for (const prompt of ['Clean up the customers CSV: remove duplicate rows and fix the date formats', 'Merge the three sales CSV files into one and total the revenue by region', 'Convert the JSON files to CSV', 'Sort the rows in this table by date', 'Parse the log files and summarize the errors']) {
    const selection = selected(prompt);
    assert.ok(selection.ids.includes('data-wrangling'), prompt);
    assert.ok(!selection.tools.includes('project_tests'), `${prompt}: a data task is judged on reconciliation, not on project tests`);
  }
  const selection = selected('Merge the three sales CSV files into one and total the revenue by region');
  assert.match(selection.stages.find(stage => stage.id === 'discovery').check, /Profile every input/);
  assert.match(selection.stages.find(stage => stage.id === 'validation').check, /row counts in and out/);
  assert.ok(selection.tools.includes('deliverable_check'));
  for (const name of selection.skills) assert.ok(fs.existsSync(path.join(agent, 'skills', name, 'SKILL.md')), name);
  for (const prompt of ['What is a CSV file?', 'Fix the CSV parser in the codebase', 'Explain how to merge two tables in SQL', 'Who exported the data?'])
    assert.ok(!selected(prompt).ids.includes('data-wrangling'), prompt);
});

test('research, reinforcement learning and edge work stage executable evidence without confusing preparation with execution', () => {
  const research = selected('Research recent papers about embedding quality and write a report');
  assert.ok(research.ids.includes('research')); assert.ok(research.tools.includes('research_toolkit'));
  assert.ok(research.stages.some(stage => stage.id === 'research-evidence'));
  assert.ok(!selected('Research the codebase structure and explain auth').ids.includes('research'));
  assert.deepEqual(selected('What is reinforcement learning?').ids, []);
  const local = selected('Train my small neural model for an edge device with reinforcement learning');
  for (const id of ['ai-ml', 'reinforcement-learning', 'edge-ml']) assert.ok(local.ids.includes(id));
  assert.ok(local.tools.includes('ml_lab'));
  assert.ok(local.stages.some(stage => stage.id === 'training-smoke'));
  assert.ok(local.stages.some(stage => stage.id === 'model-evaluation'));
  assert.ok(!selected('Prepare a Colab notebook for training an embedding model').stages.some(stage => stage.id === 'training-smoke'));
  const code = selected('Refactor Python source to remove redundant classes and improve code quality');
  assert.ok(code.stages.some(stage => stage.id === 'source-quality'));
  const ledger = createPipelineLedger();
  record(code, ledger, 'discovery', 'inspection'); record(code, ledger, 'source-impact', 'inspection'); record(code, ledger, 'implementation', 'artifact'); record(code, ledger, 'validation', 'execution');
  assert.throws(() => record(code, ledger, 'delivery', 'artifact'), /unresolved/);
  record(code, ledger, 'source-quality', 'inspection'); record(code, ledger, 'delivery', 'artifact');
});

test('UI choreography, responsive coverage, consistency and web assets select distinct stage-aware capabilities', () => {
  const prompt = 'Build a responsive Three.js website with scroll-driven animations, consistent tokens and a Blender 3D hero; generate an image for its texture';
  const selection = selected(prompt);
  for (const id of ['ui-motion', 'ui-scroll', 'ui-responsive', 'ui-consistency', 'web-3d', 'blender-3d', 'image-media']) assert.ok(selection.ids.includes(id), id);
  assert.ok(!selection.ids.includes('video'), 'UI motion graphics do not ask for a finished video');
  const ledger = createPipelineLedger();
  const names = () => automaticPipelineTools(selection, { prompt, ledger, coordinate });
  for (const name of ['ui_recipe', 'creative_direct', 'blender_run', 'blender_export', 'image_generate']) assert.ok(names().includes(name), name);
  for (const name of ['motion_inspect', 'ui_explore', 'ui_consistency']) assert.ok(!names().includes(name), `${name} waits for source artifacts`);
  record(selection, ledger, 'discovery', 'inspection'); record(selection, ledger, 'implementation', 'artifact');
  for (const name of ['motion_inspect', 'ui_explore', 'ui_consistency', 'ui_recipe']) assert.ok(names().includes(name), name);
  assert.throws(() => record(selection, ledger, 'ui-interaction', 'inspection'), /requires interaction/);
  assert.throws(() => record(selection, ledger, 'ui-pixels', 'inspection'), /requires pixels/);
  const film = selected('Create motion graphics for a 30 second explainer video');
  assert.ok(film.ids.includes('video'));
});

test('inspected imports, manifests and CSS facts activate UI work without trusting prose or comments', () => {
  const metadata = inspectPipelineSource('src/Hero.tsx', 'import { WebGLRenderer } from "three";\nexport const Hero = () => <canvas/>;\nconst entrances = new IntersectionObserver(() => {});');
  const manifest = inspectPipelineSource('package.json', JSON.stringify({dependencies:{three:'0.180',gsap:'3',react:'19'}}));
  const selection = selected('Fix the affected owner', { files: ['src/Hero.tsx'], signals: metadata.signals, dependencies: manifest.dependencies });
  for (const id of ['react-node', 'web-3d', 'ui-motion', 'ui-scroll']) assert.ok(selection.ids.includes(id), id);
  const css = inspectPipelineSource('src/theme.css', ':root { --space: 1rem; } @media (width < 48rem) { .card { width: 100%; } }');
  const styled = selected('Fix its spacing', { files:['src/theme.css'],signals:css.signals });
  assert.ok(styled.ids.includes('ui-responsive') && styled.ids.includes('ui-consistency'));
  assert.deepEqual(inspectPipelineSource('README.md', 'Use THREE.WebGLRenderer and ScrollTrigger.').signals, []);
  assert.deepEqual(inspectPipelineSource('src/plain.js', '// new ScrollTrigger; THREE.WebGLRenderer\nconst n = 1; // new IntersectionObserver').signals, []);
  assert.deepEqual(inspectPipelineSource('package.json', '{invalid manifest}').dependencies, []);
});

test('authored exclusions defeat file and dependency cues, and later explicit corrections replace them', () => {
  const prompt = 'Build a responsive website without animation, Blender or 3D. Do not use ui_recipe or image generation.';
  const selection = selected(prompt, { files:['src/Hero.tsx','assets/hero.glb'],dependencies:['three','gsap'],signals:['motion','scroll','web3d'] });
  for (const id of ['ui-motion','ui-scroll','web-3d','blender-3d']) assert.ok(!selection.ids.includes(id), id);
  for (const name of ['ui_recipe','image_generate','blender_run','asset_register','motion_inspect']) assert.ok(!automaticPipelineTools(selection, {prompt}).includes(name), name);
  const first = 'Build an animated UI without Blender or Git.';
  const followup = resolveRoutingTask(first, 'Make its scroll choreography smoother');
  assert.ok(followup.continuing && followup.task.includes(first));
  assert.ok(pipelineToolExcluded(followup.task,'blender_run') && pipelineToolExcluded(followup.task,'git_info'));
  const corrected = resolveRoutingTask(followup.task, 'Use Blender now to model that same hero');
  assert.ok(!pipelineToolExcluded(corrected.task,'blender_run'));
  assert.ok(!resolveRoutingTask(first, 'New task: fix the Python parser').continuing);
  assert.ok(!resolveRoutingTask(first, 'What is the capital of France?').continuing);
  assert.ok(!selected('Explain scroll-driven Three.js UI animation').ids.length);
});

test('shared code owners require bounded impact discovery before artifact and delivery evidence', () => {
  const prompt = 'Refactor shared UI components and migrate their API contracts across multiple files';
  const selection = selected(prompt), ledger = createPipelineLedger();
  assert.ok(selection.ids.includes('codebase-control'));
  for (const name of ['project_report','module_report','symbol_search','context_slice','code_quality','code_audit','bulk_edit']) assert.ok(automaticPipelineTools(selection,{prompt}).includes(name), name);
  record(selection,ledger,'discovery','inspection');
  assert.throws(() => record(selection,ledger,'implementation','artifact'), /unresolved prerequisite/);
  record(selection,ledger,'source-impact','inspection'); record(selection,ledger,'implementation','artifact');
  assert.ok(nextPipelineStages(selection,ledger,coordinate).some(stage=>stage.id==='validation'));
  assert.ok(!selected('Fix the CSS color', {files:['src/theme.css']}).ids.includes('codebase-control'));
});

test('ordinary interface and plural scroll goal wording preserve UI intent while negative generation stays quiet', () => {
  const prompt = '/goal Build a responsive interface with layered scroll animations and a Three.js model. Keep shared tokens consistent across pages. No image generation.';
  const selection = selected(prompt);
  for (const id of ['ui-quality','ui-motion','ui-scroll','ui-responsive','ui-consistency','web-3d']) assert.ok(selection.ids.includes(id), id);
  assert.ok(!selection.ids.includes('image-media') && !selection.ids.includes('video'));
  assert.ok(!automaticPipelineTools(selection,{prompt}).includes('image_generate'));
  const images = selected('Inspect the image assets for the interface. No image generation.',{files:['assets/hero.png']});
  assert.ok(images.ids.includes('image-media') && images.tools.includes('image_analyze'));
  assert.ok(!automaticPipelineTools(images,{prompt:'Inspect the image assets for the interface. No image generation.'}).includes('image_generate'));
  for (const task of ['Fix the network interface','Build a command-line interface','Fix TypeScript interface contracts','Optimize memory layout']) assert.ok(!selected(task).ids.includes('ui-quality'),task);
});

test('upstream UI and hybrid media verification survive advanced routing without duplicate stages', () => {
  for (const [prompt,files] of [['Fix the UI typography',[]],['Fix header line-height',['src/theme.css']],['Build a responsive animated Three.js interface',[]]]) {
    const selection=selected(prompt,{files});
    assert.equal(selection.stages.filter(stage=>stage.id==='ui-responsive').length,1,prompt);
    assert.equal(new Set(selection.stages.map(stage=>stage.id)).size,selection.stages.length,prompt);
    for(const name of ['ui_explore','visual_review','image_understand','browser_session']) assert.ok(selection.tools.includes(name),name);
    assert.match(selection.stages.find(stage=>stage.id==='ui-responsive').check,/320px/);
    assert.match(selection.stages.find(stage=>stage.id==='ui-pixels').check,/runId/);
  }
  const film=selected('Create a hybrid Blender video with generated image backplates and motion graphics');
  for(const name of ['video_project','video_render','video_qa','video_generate','image_generate','image_understand','image_convert','blender_export','blender_setup']) assert.ok(film.tools.includes(name),name);
  assert.ok(film.stages.some(stage=>stage.id==='video-art'&&stage.evidenceKinds.includes('pixels')));
  assert.ok(film.stages.some(stage=>stage.id==='video-playback'&&stage.tools.includes('video_qa')));
  assert.ok(!selected('Build scroll animations for a Three.js website').ids.includes('video'));
});
