import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {emitSessionShutdownEvent} from '../core/coding-agent/src/core/extensions/runner.js';
import {registerToolDiscovery} from '../agent/extensions/lib/tool-discovery.ts';

const root = path.resolve(import.meta.dirname, '..');

// Only the model transport is simulated: real extensions, SDK, discovery and
// prompt hooks decide which tool schemas the first model turn receives.
async function firstTurnTools(prompt) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-sdk-'));
  const envNames = ['PI_CODING_AGENT_DIR', 'PI_JEV', 'PI_NEEDLE', 'PI_TOOL_DISCOVERY', 'PI_SUBAGENT_CHILD'];
  const previous = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = cwd; process.env.PI_JEV = 'off'; process.env.PI_NEEDLE = 'off'; process.env.PI_TOOL_DISCOVERY = 'on'; delete process.env.PI_SUBAGENT_CHILD;
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}});
    const loader = new DefaultResourceLoader({cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: ['design-studio.ts', 'video-studio.ts', 'code-quality.ts', 'git-tools.ts', 'desktop-session.ts', 'render-and-wait.ts'].map(file => path.join(root, 'agent/extensions', file)), extensionFactories: [registerToolDiscovery]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const model = {id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 131072, maxTokens: 8192};
    const contexts = [];
    const modelRuntime = {getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false, getAuth: async () => ({auth: {apiKey: ['synthetic', 'fixture'].join('-')}}),
      streamSimple(_model, context) {
        contexts.push(context.tools.map(tool => tool.name));
        const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{type: 'text', text: 'ok'}], stopReason: 'stop', usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {total: 0}}};
        return {async *[Symbol.asyncIterator]() { yield {type: 'done', reason: 'stop', message}; }, result: async () => message};
      }};
    ({session} = await createAgentSession({cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'off'}));
    await session.bindExtensions({onError: () => {}});
    await session.prompt(prompt, {source: 'rpc'});
    return contexts[0];
  } finally {
    if (session) { await emitSessionShutdownEvent(session.extensionRunner, {type: 'session_shutdown', reason: 'exit'}); session.dispose(); }
    for (const key of envNames) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(cwd, {recursive: true, force: true});
  }
}

test('image-to-code, video, quality and desktop prompts put their tools on the first model turn; plain prompts stay lean', {timeout: 120_000}, async () => {
  const design = await firstTurnTools('Turn this mockup into a website: https://example.com/landing.png');
  for (const name of ['image_analyze', 'image_crop', 'image_trace', 'visual_diff', 'render_see']) assert.ok(design.includes(name), `${name} staged for image-to-code`);
  const video = await firstTurnTools('Make a 60 second explainer video about how attention works');
  assert.ok(video.includes('video_project') && video.includes('narration_tts'));
  const quality = await firstTurnTools('Refactor the billing module and remove duplicated logic, then commit it');
  assert.ok(quality.includes('code_quality') && quality.includes('git_info'));
  const desktop = await firstTurnTools('Test the Electron app: click through the settings window');
  assert.ok(desktop.includes('desktop_session'));
  const plain = await firstTurnTools('Fix the off-by-one error in the pagination helper');
  for (const name of ['image_analyze', 'video_project', 'code_quality', 'desktop_session']) assert.ok(!plain.includes(name), `${name} stays off the wire`);
});
