import test from 'node:test';
import assert from 'node:assert/strict';
import { observableBackgroundExit } from '../agent/extensions/lib/bash-routing.ts';

test('a background command ending in a tail filter reports the real exit, not tail\'s', () => {
  const render = 'cd film && bash scripts/render.sh Film out/master.mp4 2>&1 | tail -60';
  assert.equal(observableBackgroundExit(render), `set -o pipefail; ${render}`);
  assert.equal(observableBackgroundExit('make 2>&1 | tail -n 40'), 'set -o pipefail; make 2>&1 | tail -n 40');
  assert.equal(observableBackgroundExit('make | tail'), 'set -o pipefail; make | tail');
  assert.equal(observableBackgroundExit('set -o pipefail; make | tail -5'), undefined, 'already observable');
  assert.equal(observableBackgroundExit('yes | head -5'), undefined, 'head can break the pipe, so it is left alone');
  assert.equal(observableBackgroundExit('npm run build'), undefined);
  assert.equal(observableBackgroundExit('tail -f log.txt'), undefined, 'tail as the command itself is not a filter');
  assert.equal(observableBackgroundExit(undefined), undefined);
});
