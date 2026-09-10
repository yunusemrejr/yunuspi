// Compact, bounded ranker features. These are similarity evidence, never a
// proof of semantic equivalence. Training and serving import this same owner.
import { createHash } from "node:crypto";
import { fnv1a } from "./hash.mjs";

export const RANK_FEATURE_VERSION = 1;
const SIGNATURE_SIZE = 32;
const MAX_TOKENS = 2048;
const MAX_SET = 64;
const FUNCTION_NODES = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "function_definition"]);
const LITERALS = new Set(["number", "integer", "float", "string", "template_string", "true", "false", "null", "none"]);
const OPERATORS = /^(?:[+*/%<>=!&|?^-]+|and|or|not|in|is|await|throw|raise|return|yield|delete)$/;
const digest = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");

function sequenceSignature(tokens) {
  const signature = new Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens.slice(i, i + 3).join("\x1f");
    const h = fnv1a(token);
    for (let j = 0; j < SIGNATURE_SIZE; j++) {
      let z = (h + Math.imul(j + 1, 0x9e3779b1)) >>> 0;
      z = Math.imul(z ^ (z >>> 16), 0x7feb352d) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x846ca68b) >>> 0;
      z = (z ^ (z >>> 16)) >>> 0;
      if (z < signature[j]) signature[j] = z;
    }
  }
  return signature;
}

export function extractRankProfile(fnNode) {
  if (!fnNode || fnNode.hasError || fnNode.endIndex - fnNode.startIndex > 64_000) return null;
  const tokens = [], literals = [], operators = [], names = new Map();
  const stack = [fnNode];
  let nested = 0, visits = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++visits > MAX_TOKENS * 4 || tokens.length > MAX_TOKENS) return null;
    if (node.type === "comment") continue;
    if (node !== fnNode && FUNCTION_NODES.has(node.type)) nested++;
    if (LITERALS.has(node.type)) {
      const hash = fnv1a(node.type + ":" + node.text);
      literals.push(hash);
      tokens.push("literal:" + hash);
      continue;
    }
    const children = node.children;
    if (children.length) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      continue;
    }
    const text = node.text;
    if (!text.trim()) continue;
    const property = node.type === "property_identifier" || node.parent?.type === "attribute" && node.parent.childForFieldName("attribute")?.id === node.id;
    if (node.type === "identifier" && !property) {
      // First occurrence includes parameter declaration order. Consistent
      // renames match, while swapping uses of declared a/b retains evidence.
      if (!names.has(text)) names.set(text, names.size);
      tokens.push("id:" + names.get(text));
    } else tokens.push(node.type + ":" + text);
    if (OPERATORS.test(text)) operators.push(fnv1a(text));
  }
  if (tokens.length < 8 || tokens.length > MAX_TOKENS || literals.length > MAX_SET || operators.length > MAX_SET || nested > 8) return null;
  return {
    version: RANK_FEATURE_VERSION,
    tokenSig: sequenceSignature(tokens),
    canonicalHash: digest(tokens),
    literalHashes: [...new Set(literals)].sort((a, b) => a - b),
    operatorHashes: [...new Set(operators)].sort((a, b) => a - b),
    literalSequenceHash: digest(literals), operatorSequenceHash: digest(operators),
    tokenCount: tokens.length, identifierCount: names.size, nested,
  };
}

export const RANK_FEATURE_NAMES = Object.freeze([
  "astJaccard", "callOverlap", "propertyOverlap", "returnMatch", "arityMatch",
  "sizeRatio", "arityRatio", "callJaccard", "propertyJaccard", "callCountRatio",
  "propertyCountRatio", "orderedTokenJaccard", "canonicalMatch", "literalJaccard",
  "literalSequenceMatch", "operatorJaccard", "operatorSequenceMatch", "tokenCountRatio",
  "identifierCountRatio", "nestedCountRatio", "literalCountRatio", "operatorCountRatio",
]);

const ratio = (a, b) => (Math.min(a, b) + 1) / (Math.max(a, b) + 1);
function overlap(a, b) {
  const left = new Set(a), right = new Set(b);
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const x of left) if (right.has(x)) common++;
  return common / (left.size + right.size - common);
}
function validProfile(p) {
  const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const values = (v, max) => Array.isArray(v) && v.length <= max && v.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff);
  return p?.version === RANK_FEATURE_VERSION && values(p.tokenSig, SIGNATURE_SIZE) && p.tokenSig.length === SIGNATURE_SIZE
    && p.tokenSig.some(x => x !== 0xffffffff) && values(p.literalHashes, MAX_SET) && values(p.operatorHashes, MAX_SET)
    && [p.canonicalHash, p.literalSequenceHash, p.operatorSequenceHash].every(hash)
    && Number.isInteger(p.tokenCount) && p.tokenCount >= 8 && p.tokenCount <= MAX_TOKENS
    && Number.isInteger(p.identifierCount) && p.identifierCount >= 0 && p.identifierCount <= p.tokenCount
    && Number.isInteger(p.nested) && p.nested >= 0 && p.nested <= 8;
}

export function pairRankFeatures(a, b, base) {
  const p = a?.rankProfile, q = b?.rankProfile;
  if (!validProfile(p) || !validProfile(q)) return null;
  for (const f of [a, b]) {
    if (!Number.isSafeInteger(f.skelLen) || f.skelLen < 0 || !Number.isSafeInteger(f.arity) || f.arity < 0) return null;
    if (![f.calls, f.props].every(v => Array.isArray(v) && v.length <= 256 && v.every(x => typeof x === "string" && x.length <= 512))) return null;
  }
  const values = [
    base?.jaccard, base?.callOverlap, base?.propOverlap, +(a.retShape === b.retShape), +(a.arity === b.arity),
    ratio(a.skelLen, b.skelLen), ratio(a.arity, b.arity), overlap(a.calls, b.calls), overlap(a.props, b.props),
    ratio(a.calls.length, b.calls.length), ratio(a.props.length, b.props.length),
    p.tokenSig.reduce((n, v, i) => n + +(v === q.tokenSig[i]), 0) / SIGNATURE_SIZE,
    +(p.canonicalHash === q.canonicalHash), overlap(p.literalHashes, q.literalHashes),
    +(p.literalSequenceHash === q.literalSequenceHash), overlap(p.operatorHashes, q.operatorHashes),
    +(p.operatorSequenceHash === q.operatorSequenceHash), ratio(p.tokenCount, q.tokenCount),
    ratio(p.identifierCount, q.identifierCount), ratio(p.nested, q.nested),
    ratio(p.literalHashes.length, q.literalHashes.length), ratio(p.operatorHashes.length, q.operatorHashes.length),
  ];
  return values.every(v => Number.isFinite(v) && v >= 0 && v <= 1) ? values : null;
}
