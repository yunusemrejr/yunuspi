import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditsToNormalizedContent } from '../core/coding-agent/dist/core/tools/edit-diff.js';

const file = [
 '    function setPlaying(on) {',
 '      playing = !!on;',
 '      if (cinePlay) {',
 '        cinePlay.textContent = playing ? "⏸" : "▶";',
 '      }',
 '    }',
 '',
].join('\n');

test('an inner edit the outer edit already applies is dropped instead of rejecting the batch', () => {
 const outer = { oldText: '      if (cinePlay) {\n        cinePlay.textContent = playing ? "⏸" : "▶";\n      }', newText: '      if (cinePlay) {\n        cinePlay.textContent = playing ? "Pause" : "Play";\n      }' };
 const inner = { oldText: '        cinePlay.textContent = playing ? "⏸" : "▶";', newText: '        cinePlay.textContent = playing ? "Pause" : "Play";' };
 const { newContent } = applyEditsToNormalizedContent(file, [outer, inner], 'motion.js');
 assert.match(newContent, /"Pause" : "Play"/);
 assert.equal(newContent.split('Pause').length, 2);
});

test('a partial overlap on unchanged seam text merges', () => {
 const a = { oldText: '    function setPlaying(on) {\n      playing = !!on;', newText: '    function setPlaying(next) {\n      playing = !!on;' };
 const b = { oldText: '      playing = !!on;\n      if (cinePlay) {', newText: '      playing = !!on;\n      if (cinePlay && on) {' };
 const { newContent } = applyEditsToNormalizedContent(file, [a, b], 'motion.js');
 assert.match(newContent, /setPlaying\(next\)[\s\S]*if \(cinePlay && on\)/);
});

test('conflicting overlaps are rejected with exact line ranges', () => {
 const a = { oldText: '      playing = !!on;\n      if (cinePlay) {', newText: '      playing = Boolean(on);\n      if (cinePlay) {' };
 const b = { oldText: '      if (cinePlay) {\n        cinePlay', newText: '      if (!cinePlay) return;\n        cinePlay' };
 assert.throws(() => applyEditsToNormalizedContent(file, [a, b], 'motion.js'), /edits\[0\] \(lines 2-3\) and edits\[1\] \(lines 3-4\) overlap on line 3 in motion\.js/);
});
