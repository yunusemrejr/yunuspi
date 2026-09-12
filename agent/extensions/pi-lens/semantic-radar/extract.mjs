// PI_LENS_RADAR_STATE_V1: preserve bounded local fingerprint quality fixes.
// semantic-radar/extract.mjs — function extraction + feature vectors via web-tree-sitter.
// Zero LLM, zero deps beyond the wasm grammars pi-lens already ships.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fnv1a, fnv1a16, minhashSignature } from "./hash.mjs";
import { extractRankProfile } from "./rank-features.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAMMARS = path.join(HERE, "..", "grammars");
const LANGS = {
  ".ts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".py": "tree-sitter-python.wasm",
};
const FN_KINDS = new Set([
  "function_declaration", "generator_function_declaration", "function_expression",
  "arrow_function", "method_definition", "function_definition",
]);

let _wts = null;
async function loadWts() {
  if (_wts) return _wts;
  const req = createRequire(path.join(HERE, "..", "dist", "index.js"));
  _wts = await import(req.resolve("web-tree-sitter"));
  return _wts;
}

const _parsers = new Map();
export async function parserFor(ext) {
  const wasm = LANGS[ext];
  if (!wasm) return null;
  if (_parsers.has(ext)) return _parsers.get(ext);
  const wts = await loadWts();
  const { Parser, Language } = wts.Parser ? wts : wts.default;
  await Parser.init();
  const lang = await Language.load(path.join(GRAMMARS, wasm));
  const p = new Parser();
  p.setLanguage(lang);
  _parsers.set(ext, p);
  return p;
}

// --- feature vector -------------------------------------------------------
function calleeName(node) {
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression" || fn.type === "property_identifier") {
    const prop = fn.childForFieldName("property") ?? fn;
    return prop.text;
  }
  if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
  return null;
}

function litClass(node) {
  const t = node.type;
  if (t === "number" || t === "integer" || t === "float") return "num";
  if (t === "true" || t === "false" || t === "null" || t === "none") return "lit";
  if (t === "string" || t === "string_fragment" || t === "template_string") {
    const v = node.text.toLowerCase();
    if (v.includes("http://") || v.includes("https://")) return "str:url";
    if (/@|\.\*|\\d|\\w|\[a-z/.test(node.text)) return "str:regexish";
    if (v.length > 24) return "str:long";
    return "str:" + v;
  }
  return null;
}

// Weighted MinHash: a feature with weight w is emitted as w copy-indexed
// variants ("f#0".."f#(w-1)"). MinHash over that multiset approximates
// weighted Jaccard. Weights encode the task's confidence doctrine:
// shared domain entities/APIs (prop/call) are strong; raw structure is weak
// (two loops are not duplicates).
const W = { call: 3, prop: 3, lit: 2, type: 2, shape: 2, skel: 1 };
function expand(feats, prefix, value, weight) {
  for (let c = 0; c < weight; c++) feats.add(`${prefix}:${value}#${c}`);
}

function walk(node, visit) {
  visit(node);
  const kids = node.namedChildren;
  for (let i = 0; i < kids.length; i++) walk(kids[i], visit);
}

function featureVector(fnNode) {
  const skel = [];
  const calls = new Set();
  const props = new Set();
  const feats = new Set();
  walk(fnNode, (n) => {
    skel.push(n.type);
    const operator = n.childForFieldName("operator");
    if (operator) expand(feats, "operator", operator.text, 2);
    // Python comparisons/boolean operators have anonymous operator children,
    // unlike JS binary expressions with a single named operator field.
    if (!operator && ["comparison_operator", "boolean_operator", "not_operator"].includes(n.type)) {
      for (const child of n.children) if (!child.isNamed && /^(?:[<>=!]+|and|or|not|in|not in|is|is not)$/.test(child.text))
        expand(feats, "operator", child.text, 2);
    }
    if (n.type === "call_expression" || n.type === "call") {
      const c = calleeName(n);
      if (c) { calls.add(c.toLowerCase()); expand(feats, "call", c.toLowerCase(), W.call); }
    }
    if (n.type === "property_identifier" && n.parent?.type === "member_expression"
        && n.parent.childForFieldName("property")?.id === n.id) {
      // NB: web-tree-sitter JS nodes are NOT interned — compare by .id, never ===
      props.add(n.text.toLowerCase());
      expand(feats, "prop", n.text.toLowerCase(), W.prop);
    }
    if (n.type === "attribute") {
      const prop = n.childForFieldName("attribute");
      if (prop) { props.add(prop.text.toLowerCase()); expand(feats, "prop", prop.text.toLowerCase(), W.prop); }
    }
    if (["number", "integer", "float", "string", "template_string"].includes(n.type)) {
      const lc = litClass(n);
      if (lc) {
        expand(feats, "lit", lc, W.lit);
        // Preserve differences such as status codes/thresholds without persisting literal text.
        expand(feats, "literal-hash", n.text.length + ":" + fnv1a(n.text), 2);
      }
    }
    if (n.type === "type_annotation" || n.type === "predefined_type" || n.type === "generic_type") {
      expand(feats, "type", n.text.replace(/\s+/g, "").slice(0, 40), W.type);
    }
    if (n.type === "throw_statement") expand(feats, "side", "throw", W.shape);
    if (n.type === "await_expression") expand(feats, "side", "await", W.shape);
  });
  // return shape: object/array/primitive/void — a strong same-responsibility signal
  const ret = findReturnShape(fnNode);
  expand(feats, "shape", "ret:" + ret, W.shape);
  // parameter arity (names normalized away, count kept)
  const params = fnNode.childForFieldName("parameters");
  const arity = params ? params.namedChildren.filter((c) => c.type !== "comment").length : 0;
  expand(feats, "shape", "params:" + Math.min(arity, 6), W.shape);
  // structural bigrams: the shape of the code, name-independent (WEIGHT 1 — weak)
  for (let i = 0; i + 1 < skel.length; i++) expand(feats, "sk", skel[i] + "+" + skel[i + 1], W.skel);
  return { feats, calls, props, retShape: ret, arity, skelLen: skel.length };
}

function findReturnShape(fnNode) {
  let shape = "void";
  // Nested callbacks have their own return contract. Walking into one here
  // used to let an inner object/array return classify the enclosing function,
  // which polluted the shape signal used by duplicate detection.
  const stack = [fnNode];
  while (stack.length && shape === "void") {
    const n = stack.pop();
    if (n !== fnNode && FN_KINDS.has(n.type)) continue;
    if (n.type === "return_statement") {
      const v = n.namedChildren.find((c) => c.type !== "comment");
      if (v) {
        if (v.type === "object" || v.type === "array" || v.type === "new_expression") shape = v.type;
        else if (v.type === "await_expression") shape = "await";
        else shape = "value";
      }
      continue;
    }
    for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i]);
  }
  return shape;
}

// --- extraction -----------------------------------------------------------
function fnName(node) {
  const d = node.childForFieldName("name") ?? node.childForFieldName("declarator");
  if (d?.text) return d.text;
  if (node.parent?.type === "variable_declarator") return node.parent.childForFieldName("name")?.text ?? null;
  if (node.parent?.type === "export_statement") return fnName(node.parent.declaration ?? node);
  return null;
}

export function extractFunctions(rootNode, src) {
  const out = [];
  const seen = new Set();
  walk(rootNode, (n) => {
    if (!FN_KINDS.has(n.type)) return;
    // arrow/function_expression only when bound to a name (declarator/property)
    if ((n.type === "arrow_function" || n.type === "function_expression")
        && !(n.parent?.type === "variable_declarator" || n.parent?.type === "pair")) return;
    const name = fnName(n) ?? (n.parent?.type === "pair" ? n.parent.childForFieldName("key")?.text : null);
    if (!name) return;
    const key = name + "@" + n.startPosition.row;
    if (seen.has(key)) return;
    seen.add(key);
    const { feats, calls, props, retShape, arity, skelLen } = featureVector(n);
    if (skelLen < 12) return; // boilerplate/trivial guard (task: don't flag normal boilerplate)
    const id = n.startIndex + ":" + fnv1a16(name + ":" + n.startPosition.row + ":" + (src?.length ?? 0));
    const sortedFeatures = [...feats].sort();
    out.push({
      name, id, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
      skelLen, calls: [...calls].sort(), props: [...props].sort(), retShape, arity,
      feats: sortedFeatures,
      // Similarity features discard order and identifier binding. Only exact
      // function text can establish the stronger lexical tier.
      lexicalHash: createHash("sha256").update(n.text).digest("hex"),
      rankProfile: extractRankProfile(n),
      sig: minhashSignature(feats),
    });
  });
  return out;
}

export async function analyzeFile(filePath) {
  const ext = path.extname(filePath);
  if (!LANGS[ext]) return { supported: false, funcs: [] };
  const parser = await parserFor(ext);
  if (!parser) return { supported: false, funcs: [] };
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); } catch { return { supported: true, funcs: [], error: "unreadable" }; }
  if (src.length > 2_000_000) return { supported: true, funcs: [], error: "too-large" };
  const tree = parser.parse(src);
  try {
    const funcs = extractFunctions(tree.rootNode, src);
    return { supported: true, funcs, contentHash: createHash("sha256").update(src).digest("hex") };
  } finally { tree.delete?.(); }
}
