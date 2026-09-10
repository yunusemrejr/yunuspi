/** Bounded, pure metadata checks. These do not render fonts or decode image pixels. */
import {Buffer} from 'node:buffer';
const MAX_TEXT_BYTES = 65536;
const MAX_HEADER_BYTES = 1048576;
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
export function inspectText(text: string) {
  boundedText(text);
  const issue = () => ({ count: 0, positions: [] as number[] });
  const issues = { replacementCharacters: issue(), bidiControls: issue(), zeroWidthCharacters: issue(), controlCharacters: issue(), unpairedSurrogates: invalidSurrogatePositions(text) };
  const note = (item: { count: number; positions: number[] }, offset: number) => {
    item.count++;
    if (item.positions.length < MAX_POSITIONS) item.positions.push(offset);
  };
  let tabs = 0, crlf = 0, lf = 0, cr = 0, codePoints = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i)!;
    codePoints++;
    if (c === 0xfffd) note(issues.replacementCharacters, i);
    if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) note(issues.bidiControls, i);
    if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff) note(issues.zeroWidthCharacters, i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 127 && c <= 159)) note(issues.controlCharacters, i);
    if (c === 9) tabs++;
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) crlf++; else cr++; }
    if (c === 10 && text.charCodeAt(i - 1) !== 13) lf++;
    if (c > 0xffff) i++;
  }
  return {
    utf8Bytes: encoder.encode(text).length, utf16Units: text.length, codePoints,
    isNFC: text.normalize('NFC') === text, tabs,
    lineEndings: { crlf, lf, cr, mixed: [crlf, lf, cr].filter(Boolean).length > 1 },
    issues, positionUnit: 'zero-based UTF-16 offset', maxPositionsPerIssue: MAX_POSITIONS,
    scope: 'Unicode text metadata; not font rendering or original byte-encoding detection',
  };
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

export function inspectImage(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('image must be Uint8Array');
  if (bytes.length > MAX_HEADER_BYTES) throw new RangeError('image header exceeds 1 MiB limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (offset: number, count: number) => {
    if (offset < 0 || count < 0 || offset + count > bytes.length) throw new Error('Truncated image header');
  };
  const u16 = (o: number, le = false) => { need(o, 2); return view.getUint16(o, le); };
  const u32 = (o: number, le = false) => { need(o, 4); return view.getUint32(o, le); };
  const ascii = (o: number, text: string) => o + text.length <= bytes.length && [...text].every((c, i) => bytes[o + i] === c.charCodeAt(0));
  const dimensions = (format: string, width: number, height: number) => {
    if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new Error('Invalid image dimensions');
    return { format, width, height, aspectRatio: width / height, scope: 'header-only', orientationApplied: false, caveat: 'Stored dimensions only; EXIF orientation is not applied. Pixel data, checksums, and full image validity are not verified.' };
  };
  if (bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n')) {
    need(0, 33);
    if (u32(8) !== 13 || !ascii(12, 'IHDR')) throw new Error('Invalid PNG IHDR');
    const depth = bytes[24], color = bytes[25];
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) throw new Error('Invalid PNG IHDR fields');
    return dimensions('png', u32(16), u32(20));
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    need(0, 13);
    return dimensions('gif', u16(6, true), u16(8, true));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker');
      while (bytes[offset] === 0xff) offset++;
      need(offset, 1);
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) throw new Error('JPEG has no dimensions before scan/end');
      if (marker === 0 || marker === 0xd8) throw new Error('Invalid JPEG marker');
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = u16(offset);
      if (length < 2) throw new Error('Invalid JPEG segment length');
      need(offset, length);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 11 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]) throw new Error('Invalid JPEG frame header');
        return dimensions('jpeg', u16(offset + 5), u16(offset + 3));
      }
      offset += length;
    }
    throw new Error('JPEG dimensions not found within header limit');
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    need(0, 20);
    const riffEnd = u32(4, true) + 8;
    if (riffEnd < 20) throw new Error('Invalid WebP RIFF length');
    let offset = 12;
    while (offset + 8 <= bytes.length && offset + 8 <= riffEnd) {
      const size = u32(offset + 4, true), start = offset + 8;
      if (start + size + (size % 2) > riffEnd) throw new Error('WebP chunk exceeds RIFF length');
      if (ascii(offset, 'VP8X')) {
        if (size !== 10) throw new Error('Invalid WebP VP8X length');
        need(start, 10);
        if ((bytes[start] & 0xc1) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) throw new Error('Invalid WebP VP8X reserved bits');
        const u24 = (o: number) => bytes[o] + bytes[o + 1] * 256 + bytes[o + 2] * 65536;
        return dimensions('webp', u24(start + 4) + 1, u24(start + 7) + 1);
      }
      if (ascii(offset, 'VP8L')) {
        if (size < 5) throw new Error('Invalid WebP VP8L length');
        need(start, 5);
        if (bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) throw new Error('Invalid WebP lossless header');
        const bits = u32(start + 1, true);
        return dimensions('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (ascii(offset, 'VP8 ')) {
        if (size < 10) throw new Error('Invalid WebP VP8 length');
        need(start, 10);
        if ((bytes[start] & 1) || !ascii(start + 3, '\x9d\x01\x2a')) throw new Error('Invalid WebP key frame');
        return dimensions('webp', u16(start + 6, true) & 0x3fff, u16(start + 8, true) & 0x3fff);
      }
      need(start, size + size % 2);
      offset = start + size + size % 2;
    }
    throw new Error('WebP dimensions not found within header limit');
  }
  throw new Error('Unsupported or truncated image signature (PNG, JPEG, GIF, WebP supported)');
}
