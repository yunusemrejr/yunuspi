import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Compare binary data without assert.deepEqual: when two large buffers differ, deepEqual
 * builds a diff that needs gigabytes of memory and has taken the whole machine down. */
export function assertSameBytes(actual, expected, message = "bytes differ") {
  assert.ok(same(actual, expected), `${message} (${actual.length} vs ${expected.length} bytes, sha256 ${digest(actual)} vs ${digest(expected)})`);
}

export function assertDifferentBytes(actual, expected, message = "bytes are identical") {
  assert.ok(!same(actual, expected), `${message} (${actual.length} bytes, sha256 ${digest(actual)})`);
}
