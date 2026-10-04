/** A small, strict-enough XML reader for Office parts (OOXML and OpenDocument).
 *
 * It builds an element tree in document order, decodes the five predefined entities and
 * numeric references, rejects entity declarations (nothing here expands them), and reports
 * the line and column of the first well-formedness error so a damaged part can be named
 * precisely. Depth, node count and input size are bounded. It is not a validating parser:
 * namespaces stay as written (`w:p`) because Office writers are consistent about prefixes. */

export type XmlNode = { name: string; attrs: Record<string, string>; children: Array<XmlNode | string> };
export class XmlError extends Error {
  line: number; column: number;
  constructor(message: string, line: number, column: number) { super(`${message} (line ${line}, column ${column})`); this.line = line; this.column = column; }
}

const MAX_DEPTH = 200, MAX_NODES = 1_500_000, MAX_INPUT = 32 * 1024 * 1024;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

export function parseXml(source: string): XmlNode {
  if (source.length > MAX_INPUT) throw new XmlError("XML part is larger than 32 MiB", 1, 1);
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const position = (at: number) => {
    let line = 1, last = -1;
    for (let index = text.indexOf("\n"); index >= 0 && index < at; index = text.indexOf("\n", index + 1)) { line++; last = index; }
    return { line, column: at - last };
  };
  const fail = (message: string, at: number): never => { const { line, column } = position(at); throw new XmlError(message, line, column); };
  const root: XmlNode = { name: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let at = 0, nodes = 0;
  const attributePattern = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open < 0) { const rest = text.slice(at); if (rest.trim()) { if (stack.length === 1) fail("Text outside the root element", at); stack[stack.length - 1].children.push(decodeEntities(rest)); } at = text.length; break; }
    if (open > at) {
      const chunk = text.slice(at, open);
      if (stack.length > 1) stack[stack.length - 1].children.push(decodeEntities(chunk));
      else if (chunk.trim()) fail("Text outside the root element", at);
    }
    if (text.startsWith("<!--", open)) { const end = text.indexOf("-->", open + 4); if (end < 0) fail("Unterminated comment", open); at = end + 3; continue; }
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9); if (end < 0) fail("Unterminated CDATA section", open);
      if (stack.length === 1) fail("CDATA outside the root element", open);
      stack[stack.length - 1].children.push(text.slice(open + 9, end)); at = end + 3; continue;
    }
    if (text.startsWith("<?", open)) { const end = text.indexOf("?>", open + 2); if (end < 0) fail("Unterminated processing instruction", open); at = end + 2; continue; }
    if (text.startsWith("<!", open)) {
      const end = text.indexOf(">", open); if (end < 0) fail("Unterminated declaration", open);
      if (/<!ENTITY/i.test(text.slice(open, Math.min(text.length, open + 4096)))) fail("Entity declarations are not supported", open);
      // A DOCTYPE with an internal subset ends at "]>"; skip to it.
      if (/^<!DOCTYPE[^>]*\[/i.test(text.slice(open, end + 1))) { const subsetEnd = text.indexOf("]>", open); if (subsetEnd < 0) fail("Unterminated DOCTYPE", open); at = subsetEnd + 2; } else at = end + 1;
      continue;
    }
    if (text[open + 1] === "/") {
      const end = text.indexOf(">", open); if (end < 0) fail("Unterminated closing tag", open);
      const name = text.slice(open + 2, end).trim();
      const current = stack[stack.length - 1];
      if (stack.length === 1 || current.name !== name) fail(`Closing tag </${name}> does not match ${stack.length === 1 ? "any open element" : `<${current.name}>`}`, open);
      stack.pop(); at = end + 1; continue;
    }
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(text.slice(open + 1, open + 256));
    if (!nameMatch) fail("Malformed tag", open);
    const name = nameMatch![0];
    let cursor = open + 1 + name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] === ">" || (text[cursor] === "/" && text[cursor + 1] === ">") || cursor >= text.length) break;
      attributePattern.lastIndex = cursor;
      const attr = attributePattern.exec(text);
      if (!attr) fail(`Malformed attribute in <${name}>`, cursor);
      const key = attr![1];
      if (Object.prototype.hasOwnProperty.call(attrs, key)) fail(`Duplicate attribute ${key} in <${name}>`, cursor);
      attrs[key] = decodeEntities(attr![2] ?? attr![3] ?? "");
      cursor = attributePattern.lastIndex;
    }
    if (cursor >= text.length) fail(`Unterminated tag <${name}>`, open);
    const selfClosing = text[cursor] === "/";
    const node: XmlNode = { name, attrs, children: [] };
    if (stack.length === 1 && root.children.length > 0) fail("More than one root element", open);
    if (++nodes > MAX_NODES) fail("XML part has too many elements", open);
    stack[stack.length - 1].children.push(node);
    at = cursor + (selfClosing ? 2 : 1);
    if (!selfClosing) { if (stack.length >= MAX_DEPTH) fail("XML nesting is too deep", open); stack.push(node); }
  }
  if (stack.length > 1) fail(`Element <${stack[stack.length - 1].name}> is never closed`, text.length);
  const first = root.children.find((child): child is XmlNode => typeof child !== "string");
  if (!first) fail("No root element", 0);
  return first!;
}

export const elementsOf = (node: XmlNode): XmlNode[] => node.children.filter((child): child is XmlNode => typeof child !== "string");
/** First direct child with this name. */
export const childOf = (node: XmlNode | undefined, name: string): XmlNode | undefined => node ? elementsOf(node).find(child => child.name === name) : undefined;
export const childrenOf = (node: XmlNode | undefined, name: string): XmlNode[] => node ? elementsOf(node).filter(child => child.name === name) : [];
export const textOf = (node: XmlNode | string | undefined): string => node === undefined ? "" : typeof node === "string" ? node : node.children.map(textOf).join("");

/** Every descendant element with one of these names, in document order. Iterative, so depth cannot overflow the stack. */
export function descendantsOf(node: XmlNode | undefined, ...names: string[]): XmlNode[] {
  if (!node) return [];
  const wanted = new Set(names), found: XmlNode[] = [], pending: Array<XmlNode | string>[] = [node.children];
  const positions = [0];
  while (pending.length) {
    const level = pending.length - 1, list = pending[level];
    if (positions[level] >= list.length) { pending.pop(); positions.pop(); continue; }
    const child = list[positions[level]++];
    if (typeof child === "string") continue;
    if (wanted.has(child.name)) found.push(child);
    pending.push(child.children); positions.push(0);
  }
  return found;
}

/** Escape text for an XML text node or a double-quoted attribute value; control characters XML forbids are dropped. */
export function escapeXml(value: string): string {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
