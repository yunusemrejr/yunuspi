import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
test('offline tiny embedding and causal LoRA train, resume identical weights, and export complete artifacts', {
  skip: !process.env.PI_ML_TEST_PYTHON && 'Select the isolated optional dependency environment with PI_ML_TEST_PYTHON',
  timeout: 480000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-transformer-live-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PI_ML_TEST_PYTHON, ['-I', path.join(root, 'tests/fixtures/ml-transformer-smoke.py'), path.join(dir, 'models'), path.join(root, 'agent/scripts/ml-transformer-train.py')], {
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', CUDA_VISIBLE_DEVICES: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-20000); });
      const deadline = setTimeout(() => child.kill('SIGTERM'), 460000);
      child.on('error', reject);
      child.on('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.equal((result.output.match(/"resumeWeightsEqual": true/g) ?? []).length, 2, result.output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
