import test from 'node:test';
import assert from 'node:assert/strict';
import { electronSandboxArgs } from '../desktop/launch.mjs';

const ELECTRON = '/nonexistent/electron/dist/electron';

test('sandbox fallback is explicitly controllable', () => {
  const previous = process.env.YUNUSPI_ELECTRON_SANDBOX;
  try {
    process.env.YUNUSPI_ELECTRON_SANDBOX = 'off';
    assert.deepEqual(electronSandboxArgs(ELECTRON), ['--no-sandbox']);
    process.env.YUNUSPI_ELECTRON_SANDBOX = 'on';
    assert.deepEqual(electronSandboxArgs(ELECTRON), []);
  } finally {
    if (previous === undefined) delete process.env.YUNUSPI_ELECTRON_SANDBOX;
    else process.env.YUNUSPI_ELECTRON_SANDBOX = previous;
  }
});

test('auto detection never invents a sandbox flag off Linux', () => {
  if (process.platform !== 'linux') assert.deepEqual(electronSandboxArgs(ELECTRON), []);
});
