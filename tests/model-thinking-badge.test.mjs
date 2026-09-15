import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/shared/formatters.ts')));
const {formatModelThinking}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/shared/formatters.ts')));
test('short rows keep gateway provider plus leaf model',()=>{
 assert.equal(formatModelThinking('deepseek/deepseek-chat'),'deepseek/deepseek-chat');
 assert.equal(formatModelThinking('nim/meta/llama-3.1-70b-instruct'),'nim/llama-3.1-70b-instruct');
 assert.equal(formatModelThinking('gpt-4o'),'gpt-4o');
 assert.equal(formatModelThinking('openrouter/qwen/qwen3:high'),'openrouter/qwen3 · thinking high');
 assert.equal(formatModelThinking('a/b','low'),'a/b · thinking low');
});
test('full style keeps the whole nested route for detail lines',()=>{
 assert.equal(formatModelThinking('nim/meta/llama-3.1-70b-instruct',undefined,'full'),'nim/meta/llama-3.1-70b-instruct');
 assert.equal(formatModelThinking('openrouter/qwen/qwen3:high',undefined,'full'),'openrouter/qwen/qwen3 · thinking high');
 assert.equal(formatModelThinking('deepseek/deepseek-chat',undefined,'full'),'deepseek/deepseek-chat');
});
test('empty and degenerate inputs never crash the badge',()=>{
 assert.equal(formatModelThinking(undefined),'');
 assert.equal(formatModelThinking('/'),'');
 assert.equal(formatModelThinking('a/'),'a');
 assert.equal(formatModelThinking(undefined,'high'),'thinking high');
});
