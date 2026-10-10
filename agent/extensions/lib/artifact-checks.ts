/** Bounded, pure value conversions (JSON, Base64, URL encoding) for value_convert. */
import {Buffer} from 'node:buffer';
const MAX_TEXT_BYTES = 65536;
const MAX_POSITIONS = 16;
const encoder = new TextEncoder();

function boundedText(text: string) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > MAX_TEXT_BYTES || encoder.encode(text).length > MAX_TEXT_BYTES) throw new RangeError('text exceeds 64 KiB UTF-8 limit');
}
function invalidSurrogatePositions(text: string) {
  const positions: number[] = [];
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
    } else if (code < 0xdc00 || code > 0xdfff) continue;
    count++;
    if (positions.length < MAX_POSITIONS) positions.push(i);
  }
  return { count, positions };
}
export type ConversionOperation = 'json_format' | 'json_compact' | 'base64_encode' | 'base64_decode' | 'url_encode' | 'url_decode';
export function convertValue(input: { operation: ConversionOperation; text: string }) {
  if (!input || typeof input !== 'object') throw new TypeError('conversion input must be an object');
  const { operation, text } = input;
  boundedText(text);
  if (invalidSurrogatePositions(text).count) throw new Error('Input contains unpaired UTF-16 surrogates');
  let output: string;
  switch (operation) {
    // Validate grammar, then format original tokens to preserve large numbers and duplicate keys.
    case 'json_format': case 'json_compact': {
      let depth = 0, quoted = false, escaped = false;
      for (const char of text) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '[' || char === '{') {
          if (++depth > 32) throw new RangeError('JSON nesting exceeds 32 levels');
        } else if (char === ']' || char === '}') depth--;
      }
      try { JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
      const tokens = text.match(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\],:]/g)!;
      if (operation === 'json_compact') output = tokens.join('');
      else {
        const parts: string[] = [];
        let level = 0, units = 0;
        const append = (part: string) => {
          units += part.length;
          if (units > MAX_TEXT_BYTES) throw new RangeError('conversion output exceeds 64 KiB UTF-8 limit');
          parts.push(part);
        };
        const newline = () => append('\n' + '  '.repeat(level));
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          if (token === '{' || token === '[') {
            append(token); level++;
            if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') newline();
          } else if (token === '}' || token === ']') {
            level--;
            if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') newline();
            append(token);
          } else if (token === ',') { append(token); newline(); }
          else if (token === ':') append(': ');
          else append(token);
        }
        output = parts.join('');
      }
      break;
    }
    case 'base64_encode': output = Buffer.from(text, 'utf8').toString('base64'); break;
    case 'base64_decode': {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid canonical padded base64');
      const bytes = Buffer.from(text, 'base64');
      if (bytes.toString('base64') !== text) throw new Error('Invalid canonical base64 padding bits');
      try { output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('Decoded base64 is not valid UTF-8 text'); }
      break;
    }
    case 'url_encode': output = encodeURIComponent(text); break;
    case 'url_decode':
      try { output = decodeURIComponent(text); } catch { throw new Error('Invalid percent encoding or UTF-8'); }
      break;
    default: throw new Error('Unsupported conversion operation');
  }
  // Encodings can expand input by up to nine times. Bound output as well.
  if (encoder.encode(output).length > MAX_TEXT_BYTES) throw new RangeError('conversion output exceeds 64 KiB UTF-8 limit');
  return { operation, text: output };
}
