/** Bounded ZIP reading and writing for Office files. No dependencies beyond node:zlib.
 *
 * Reading is defensive because the input is whatever a model or a download produced:
 * entry counts, per-entry and total inflated sizes and the compression ratio are capped
 * before anything is inflated, names that escape the archive are rejected, and a stored
 * CRC-32 that disagrees with the data is reported instead of trusted. Writing is
 * deterministic (fixed timestamps, stable order) so a rebuilt file is byte-identical. */
import fs from "node:fs";
import zlib from "node:zlib";

export const ZIP_LIMITS = Object.freeze({
  maxFileBytes: 96 * 1024 * 1024,
  maxEntries: 5000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 400,
});

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; crc: number; offset: number; directory: boolean };
export type ZipReader = {
  entries: ZipEntry[];
  has(name: string): boolean;
  /** Inflated bytes of one entry; throws on a bad CRC, an oversized entry or an unsupported method. */
  read(name: string): Buffer;
  /** Text of one entry (UTF-8, BOM stripped). */
  text(name: string): string;
  /** Entries whose stored CRC does not match their data, or that cannot be inflated. Reads every entry once. */
  integrityProblems(): string[];
};

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/** Names are archive-relative paths; reject anything that could land outside a target directory. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 512 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  return !name.split("/").some(part => part === "..");
}

export function openZip(buffer: Buffer): ZipReader {
  if (buffer.length < 22) throw new Error("Not a ZIP archive (file is shorter than a ZIP end record)");
  if (buffer.length > ZIP_LIMITS.maxFileBytes) throw new Error(`Archive is larger than ${ZIP_LIMITS.maxFileBytes / 1048576} MiB`);
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at--) {
    if (buffer.readUInt32LE(at) === EOCD && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record; the file may be truncated or another format)");
  const total = buffer.readUInt16LE(eocd + 10), centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== total) throw new Error("Multi-disk ZIP archives are not supported");
  if (total === 0xffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (total > ZIP_LIMITS.maxEntries) throw new Error(`Archive lists ${total} entries; the limit is ${ZIP_LIMITS.maxEntries}`);
  if (centralOffset + centralSize > eocd) throw new Error("Corrupt ZIP: the central directory runs past its end record");
  const centralEnd = centralOffset + centralSize;
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let at = centralOffset, declared = 0;
  for (let index = 0; index < total; index++) {
    if (at + 46 > centralEnd || buffer.readUInt32LE(at) !== CENTRAL) throw new Error(`Corrupt ZIP: central directory entry ${index + 1} is malformed`);
    const method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    if (at + 46 + nameLength + extraLength + commentLength > centralEnd) throw new Error(`Corrupt ZIP: central directory entry ${index + 1} exceeds its declared bounds`);
    if (buffer.readUInt16LE(at + 8) & 1) throw new Error("Encrypted ZIP entries are not supported");
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const entry: ZipEntry = { name, method, compressedSize, size, crc, offset, directory: name.endsWith("/") };
    declared += size;
    if (!safeEntryName(name)) throw new Error(`Unsafe entry name in archive: ${JSON.stringify(name.slice(0, 80))}`);
    if (byName.has(name)) throw new Error(`Duplicate entry name in archive: ${JSON.stringify(name.slice(0, 80))}`);
    entries.push(entry);
    byName.set(name, entry);
  }
  if (declared > ZIP_LIMITS.maxTotalBytes) throw new Error(`Archive inflates to ${Math.round(declared / 1048576)} MiB; the limit is ${ZIP_LIMITS.maxTotalBytes / 1048576} MiB`);

  const read = (name: string): Buffer => {
    const entry = byName.get(name);
    if (!entry) throw new Error(`No entry named ${name}`);
    if (entry.size > ZIP_LIMITS.maxEntryBytes) throw new Error(`${name} inflates to ${Math.round(entry.size / 1048576)} MiB; the limit is ${ZIP_LIMITS.maxEntryBytes / 1048576} MiB`);
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > ZIP_LIMITS.maxRatio) throw new Error(`${name} has a suspicious compression ratio`);
    if (entry.offset + 30 > centralOffset || buffer.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`Corrupt ZIP: local header of ${name} is missing`);
    const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
    if (start + entry.compressedSize > centralOffset) throw new Error(`Corrupt ZIP: data of ${name} runs past the archive`);
    const raw = buffer.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(ZIP_LIMITS.maxEntryBytes, entry.size + 1)) });
    else throw new Error(`${name} uses unsupported compression method ${entry.method}`);
    if (data.length !== entry.size) throw new Error(`${name}: inflated size ${data.length} differs from the recorded ${entry.size}`);
    if (typeof zlib.crc32 === "function" && zlib.crc32(data) !== entry.crc) throw new Error(`${name}: CRC-32 mismatch (the entry is damaged)`);
    return data;
  };
  return {
    entries,
    has: (name) => byName.has(name),
    read,
    text: (name) => read(name).toString("utf8").replace(/^﻿/, ""),
    integrityProblems() {
      const problems: string[] = [];
      for (const entry of entries) {
        if (entry.directory) continue;
        try { read(entry.name); } catch (error: any) { problems.push(String(error?.message ?? error).slice(0, 200)); if (problems.length >= 20) break; }
      }
      return problems;
    },
  };
}

export function readZipFile(file: string): ZipReader {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  if (stat.size > ZIP_LIMITS.maxFileBytes) throw new Error(`${file} is larger than ${ZIP_LIMITS.maxFileBytes / 1048576} MiB`);
  return openZip(fs.readFileSync(file));
}

export type ZipSource = { name: string; data: Buffer | string };

/** Deterministic ZIP writer: entries in the given order, fixed 1980-01-01 timestamps, deflate when it helps. */
export function writeZip(sources: readonly ZipSource[]): Buffer {
  if (sources.length > ZIP_LIMITS.maxEntries) throw new Error("Too many entries for one archive");
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0, totalBytes = 0;
  const seen = new Set<string>();
  for (const source of sources) {
    if (!safeEntryName(source.name) || seen.has(source.name)) throw new Error(`Invalid or duplicate archive entry name: ${JSON.stringify(source.name)}`);
    seen.add(source.name);
    const data = typeof source.data === "string" ? Buffer.from(source.data, "utf8") : source.data;
    if (data.length > ZIP_LIMITS.maxEntryBytes) throw new Error(`${source.name} exceeds the archive entry size limit`);
    totalBytes += data.length;
    if (totalBytes > ZIP_LIMITS.maxTotalBytes) throw new Error("Archive exceeds the total inflated size limit");
    const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    // The reader's bomb limit applies to files we generate too. Store highly
    // repetitive entries instead of producing an archive we refuse to reopen.
    const method = deflated.length < data.length && data.length / deflated.length <= ZIP_LIMITS.maxRatio ? 8 : 0, stored = method === 8 ? deflated : data;
    const name = Buffer.from(source.name, "utf8"), crc = zlib.crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(stored.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, stored); centrals.push(central);
    offset += local.length + stored.length;
    if (offset > ZIP_LIMITS.maxFileBytes) throw new Error("Archive exceeds the file size limit");
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(sources.length, 8); end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  if (offset + centralBytes.length + end.length > ZIP_LIMITS.maxFileBytes) throw new Error("Archive exceeds the file size limit");
  return Buffer.concat([...locals, centralBytes, end]);
}
