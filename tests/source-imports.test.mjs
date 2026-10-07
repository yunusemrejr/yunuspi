import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCode, parseImports, resolveCodeImports } from '../agent/extensions/lib/project-intelligence/discovery-parsers.mjs';
import { discoverProject } from '../agent/extensions/lib/project-intelligence/discovery.mjs';

test('JS lexical imports support module variants, escaped literals and executable template expressions', () => {
  const source = '/* require("fake") */\nconst fake = `import "phantom"`;\nconst regex = /import("regex-only")/;\nimport type { T } from "./types.js";\nimport { T } from "./types.js";\nconst value = `${import("./live.js")}`;\nobj.require("method");\nrequire("./\\x6dodule.cjs");\nimport("./computed" + suffix);';
  for (const ext of ['.js', '.ts', '.cjs', '.cts', '.mjs', '.mts']) {
    const scanned = parseImports(source, ext);
    assert.equal(scanned.complete, true);
    assert.deepEqual(scanned.imports.map(row => row.specifier), ['./types.js', './live.js', './module.cjs']);
    assert.equal(scanned.imports[0].typeOnly, undefined, 'a later runtime import keeps the runtime dependency');
  }
});

test('Vue and Svelte scan script blocks; incomplete lexical input is explicit and bounded', () => {
  for (const ext of ['.vue', '.svelte']) {
    assert.deepEqual(parseImports('<template>import "fake"</template><!-- <script>import "comment"</script> --><script lang="ts">import "./live.js";</script>', ext).imports.map(row => row.specifier), ['./live.js']);
  }
  const invalid = parseImports('import "./first.js"; const text = "unfinished', '.tsx');
  assert.equal(invalid.complete, false);
  assert.deepEqual(invalid.imports.map(row => row.specifier), ['./first.js']);
  const capped = parseImports(Array.from({ length: 150 }, (_, i) => `import "pkg-${i}";`).join('\n'), '.js');
  assert.equal(capped.imports.length, 128);
  assert.equal(capped.complete, false);
  const jsx = parseImports('import "./real.js"; const view = <div> ; import "markup-only"; </div>;', '.tsx');
  assert.equal(jsx.complete, false);
  assert.deepEqual(jsx.imports.map(row => row.specifier), ['./real.js']);
});

test('both graph consumers share exact JS-to-TS conventions and Python package resolution', () => {
  const known = new Set(['src/a.ts', 'src/a.mts', 'src/a.cts', 'src/widgets/index.cts', 'src/pkg/__init__.py', 'src/pkg/a.py', 'src/pkg/b.py']);
  assert.deepEqual(resolveCodeImports('src/main.ts', { specifier: './a.mjs' }, known), ['src/a.mts']);
  assert.deepEqual(resolveCodeImports('src/main.ts', { specifier: './a.cjs' }, known), ['src/a.cts']);
  assert.deepEqual(resolveCodeImports('src/main.ts', { specifier: './widgets' }, known), ['src/widgets/index.cts']);
  assert.deepEqual(resolveCodeImports('src/pkg/a.py', { specifier: '.', kind: 'python import', members: ['b', 'anAttribute'] }, known), ['src/pkg/__init__.py', 'src/pkg/b.py']);
  assert.deepEqual(resolveCodeImports('src/main.ts', { specifier: '../../outside' }, known), []);
  assert.deepEqual(parseCode('src/a.cjs', 'require("./b.cjs")').imports.map(row => row.specifier), ['./b.cjs']);
});

test('empty named clauses and a value named type still retain runtime imports', () => {
  const result = parseImports('import {} from "empty"; export {} from "reexport"; import type from "default-type"; import {type as value} from "value-type"; import { type T, type U as V } from "only-types";', '.ts');
  assert.deepEqual(result.imports.filter(row => !row.typeOnly).map(row => row.specifier), ['empty', 'reexport', 'default-type', 'value-type']);
  assert.equal(result.imports.at(-1).typeOnly, true);
});

test('cold and returning project discovery agree with source resolution without phantom dependencies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'a.cts': 'import {b} from "./b.cjs"; const fixture = `import "phantom"`; ',
    'b.cts': 'export const b = 1;',
    'main.cjs': 'require("./a.cjs");',
    'pkg/__init__.py': '',
    'pkg/a.py': 'from . import b',
    'pkg/b.py': 'from . import a',
  };
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  }
  const identity = { id: 'fixture', root, checkoutId: 'fixture-checkout', name: 'fixture' };
  const cold = await discoverProject(identity);
  const nodes = new Map(cold.sources.flatMap(row => row.nodes).map(node => [node.id, node.label]));
  const edges = cold.sources.flatMap(row => row.claims).filter(row => row.predicate === 'imports').map(row => `${nodes.get(row.subject)} -> ${nodes.get(row.object)}`);
  assert.ok(edges.includes('a.cts -> b.cts'));
  assert.ok(edges.includes('main.cjs -> a.cts'));
  assert.ok(edges.includes('pkg/a.py -> pkg/b.py'));
  assert.ok(edges.includes('pkg/b.py -> pkg/a.py'));
  assert.ok(!JSON.stringify(cold.sources).includes('phantom'));
  const warm = await discoverProject(identity, { metadata: cold.metadata, previousSources: cold.sources });
  assert.equal(warm.stats.filesParsed, 0);
  const staleParser = await discoverProject(identity, { metadata: { ...cold.metadata, parserSchemaVersion: 2 }, previousSources: cold.sources });
  assert.ok(staleParser.stats.filesParsed > 0, 'a scanner correction invalidates the older cached graph');
});
