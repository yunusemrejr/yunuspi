/** Exact AST facts only. Reuses the installed WASM parser; never calls a model,
 * executes source, or infers architectural quality from naming conventions. */
import path from 'node:path';
import {parserFor} from '../pi-lens/semantic-radar/extract.mjs';
export const codeNoiseSupported = file => /\.(?:[cm]?[jt]sx?|py)$/i.test(file);
export async function inspectCodeNoise(filename, source) {
  const result = {status: 'checked', findings: [], truncated: false,
    scope: 'Advisory AST facts only; intentional repetition and documented best-effort catches are allowed.',
    limits: {bytes: 65536, nodes: 20000, findings: 3, scanMs: 20}};
  if (!codeNoiseSupported(filename)) return {...result, status: 'unsupported'};
  if (typeof source !== 'string' || Buffer.byteLength(source) > result.limits.bytes) return {...result, status: 'incomplete', truncated: true};
  let tree;
  try {
    const parser = await parserFor(path.extname(filename).toLowerCase());
    if (!parser) return {...result, status: 'unavailable'};
    const parseStarted = performance.now();
    tree = parser.parse(source);
    result.runtime = 'tree-sitter-wasm';
    result.durationMs = Math.round((performance.now() - parseStarted) * 100) / 100;
    if (!tree || tree.rootNode.hasError) return {...result, status: 'syntax-unavailable'};
    const started = performance.now(), pending = [tree.rootNode];
    let visited = 0;
    while (pending.length) {
      if (++visited > result.limits.nodes || performance.now() - started > result.limits.scanMs || result.findings.length >= result.limits.findings) {result.truncated = true; break;}
      const node = pending.pop();
      if (node.type === 'comment' && /^(?:\/\/|#)/.test(node.text)) {
        const exact = /^(?:\/\/|#)\s*return\s+([A-Za-z_$][\w$]*)\.?\s*$/i.exec(node.text);
        let next = node.nextNamedSibling;
        // Python's leading body comments belong to the function node before
        // its block; JS/TS comments and statements share their parent block.
        if (next?.type === 'block') next = next.firstNamedChild;
        if (exact && next?.type === 'return_statement' && next.startPosition.row === node.endPosition.row + 1 && new RegExp('^return\\s+' + exact[1].replace(/[$]/g, '\\$&') + '\\s*;?$').test(next.text.trim()))
          result.findings.push({kind: 'comment-restates-return', line: node.startPosition.row + 1, relatedLine: next.startPosition.row + 1});
      } else if (node.type === 'catch_clause') {
        const body = node.childForFieldName('body');
        const explanation = [node.previousNamedSibling,node.parent?.previousNamedSibling].some(comment =>
          comment?.type === 'comment' && (node.startPosition.row - comment.endPosition.row <= 1 || node.parent?.startPosition.row === comment.endPosition.row + 1));
        if (body && body.namedChildCount === 0 && /^\{\s*\}$/.test(body.text) && !explanation)
          result.findings.push({kind: 'undocumented-empty-catch', line: node.startPosition.row + 1});
      }
      for (let index = node.namedChildCount - 1; index >= 0; index--) pending.push(node.namedChild(index));
    }
    return result;
  } catch {return {...result, status: 'unavailable', findings: []};}
  finally {tree?.delete();}
}
