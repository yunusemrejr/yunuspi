import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const finite = (...xs) => { if (!xs.every(Number.isFinite)) throw new RangeError('Expected finite numbers'); };
export function springParameters(mass, frequency, dampingRatio) {
  finite(mass, frequency, dampingRatio);
  if (mass <= 0 || frequency <= 0 || dampingRatio < 0) throw new RangeError('Positive mass/frequency and nonnegative damping required');
  const omega = 2 * Math.PI * frequency;
  const result = { omega, stiffness: mass * omega ** 2, damping: 2 * dampingRatio * mass * omega };
  finite(...Object.values(result)); return result;
}
export function criticalSpring(y, velocity, omega, dt) {
  finite(y, velocity, omega, dt);
  if (omega <= 0 || dt < 0) throw new RangeError('Positive omega and nonnegative dt required');
  if (dt === 0) return { y, velocity };
  const b = velocity + omega * y, exponential = Math.exp(-omega * dt);
  if (exponential === 0) return { y: 0, velocity: 0 };
  const result = { y: (y + b * dt) * exponential, velocity: (velocity - omega * b * dt) * exponential };
  finite(...Object.values(result)); return result;
}
export function xpbdDelta(constraint, lambda, inverseMassGradientSum, compliance, dt) {
  finite(constraint, lambda, inverseMassGradientSum, compliance, dt);
  if (inverseMassGradientSum < 0 || compliance < 0 || dt <= 0) throw new RangeError('Invalid XPBD parameters');
  const scaled = compliance / dt ** 2;
  finite(scaled);
  const denominator = inverseMassGradientSum + scaled;
  if (denominator === 0) return 0;
  const delta = (-constraint - scaled * lambda) / denominator;
  finite(delta); return delta;
}
export function selfTest() {
  const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
  const spring = springParameters(2, 3, 0.7); close(spring.stiffness, 710.6115168784338);
  const full = criticalSpring(1, 0, 10, 0.1), half = criticalSpring(1, 0, 10, 0.05);
  const split = criticalSpring(half.y, half.velocity, 10, 0.05);
  close(full.y, 2 / Math.E); close(full.velocity, -10 / Math.E);
  close(full.y, split.y); close(full.velocity, split.velocity);
  let state = { y: 1, velocity: 0 }, energy = 50;
  for (let i = 0; i < 100; i++) {
    state = criticalSpring(state.y, state.velocity, 10, 0.01);
    const next = 0.5 * state.velocity ** 2 + 50 * state.y ** 2;
    assert.ok(next <= energy + 1e-12); energy = next;
  }
  close(xpbdDelta(0.1, 0, 2, 0.0001, 1 / 60), -0.1 / 2.36);
  const dl = xpbdDelta(0.1, 0, 2, 0.0001, 1 / 60);
  close(xpbdDelta(0.1 + 2 * dl, dl, 2, 0.0001, 1 / 60), 0);
  assert.equal(xpbdDelta(1, 0, 0, 0, 0.01), 0);
  for (const invalid of [NaN, Infinity, -1]) assert.throws(() => springParameters(1, invalid, 0.5));
  assert.throws(() => xpbdDelta(1, 0, 1, 0, 0));
  return 'physics-check: exact evolution, dissipation, XPBD residual and input invariants passed';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--self-test') { console.error('Usage: node physics-check.mjs --self-test; import exports for calculations'); process.exitCode = 2; }
  else console.log(selfTest());
}
