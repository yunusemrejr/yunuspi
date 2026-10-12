import { marked } from '../../node_modules/marked/lib/marked.esm.js';

export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true'); if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
export function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
const decodeText = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);

// Use Markdown's token parser, never its generated HTML. All model/user text
// enters through text nodes; HTML, handlers and arbitrary image URLs cannot run.
export function markdown(text, openLink) {
  const fragment = document.createDocumentFragment();
  const render = (tokens, parent) => {
    for (const token of tokens ?? []) {
      let node;
      switch (token.type) {
        case 'space': continue;
        case 'heading': node = element(`h${Math.min(4, token.depth)}`); render(token.tokens, node); break;
        case 'paragraph': node = element('p'); render(token.tokens, node); break;
        case 'text':
          if (token.tokens) { render(token.tokens, parent); continue; }
          node = document.createTextNode(decodeText(token.text)); break;
        case 'escape': node = document.createTextNode(token.text); break;
        case 'strong': case 'em': case 'del': node = element(token.type); render(token.tokens, node); break;
        case 'codespan': node = element('code', '', decodeText(token.text)); break;
        case 'br': node = element('br'); break;
        case 'hr': node = element('hr'); break;
        case 'blockquote': node = element('blockquote'); render(token.tokens, node); break;
        case 'list':
          node = element(token.ordered ? 'ol' : 'ul');
          if (token.ordered && token.start !== 1) node.start = token.start;
          for (const item of token.items) { const li = element('li'); if (item.task) li.append(document.createTextNode(item.checked ? '✓ ' : '○ ')); render(item.tokens, li); node.append(li); }
          break;
        case 'code': {
          node = element('div', 'code-block');
          const bar = element('div', 'code-bar'); bar.append(element('span', '', (token.lang || 'code').slice(0, 30)));
          const copy = element('button', 'icon-button'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code'); copy.append(icon('copy'));
          copy.onclick = async () => { try { if (window.yunuspi?.copyText) await window.yunuspi.copyText(token.text); else await navigator.clipboard.writeText(token.text); copy.replaceChildren(icon('check')); setTimeout(() => { if (copy.isConnected) copy.replaceChildren(icon('copy')); }, 1500); } catch { copy.setAttribute('aria-label', 'Copy unavailable'); } };
          bar.append(copy); const pre = element('pre'); pre.append(element('code', '', token.text)); node.append(bar, pre); break;
        }
        case 'link': case 'image': {
          const safe = /^(https?:\/\/)/i.test(token.href);
          if (!safe) { node = element('span', '', token.type === 'image' ? token.text : token.text || token.href); break; }
          node = element('a'); node.href = token.href; node.rel = 'noopener noreferrer';
          if (token.type === 'image') node.textContent = `Image: ${token.text || 'view source'}`; else render(token.tokens, node);
          node.onclick = event => { event.preventDefault(); openLink(token.href); }; break;
        }
        case 'table': {
          node = element('div', 'table-wrap'); const table = element('table'), head = element('thead'), row = element('tr');
          for (const cell of token.header) { const th = element('th'); render(cell.tokens, th); row.append(th); } head.append(row); table.append(head);
          const body = element('tbody'); for (const cells of token.rows) { const tr = element('tr'); for (const cell of cells) { const td = element('td'); render(cell.tokens, td); tr.append(td); } body.append(tr); }
          table.append(body); node.append(table); break;
        }
        default: node = document.createTextNode(token.text ?? token.raw ?? '');
      }
      if (node) parent.append(node);
    }
  };
  try { render(marked.lexer(text, { gfm: true }), fragment); }
  catch { fragment.append(document.createTextNode(text)); }
  return fragment;
}
