import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_RECORDS = 128;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST = 192 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isDesktopInputId(id) {
    return typeof id === "string" && UUID.test(id);
}

function checkId(id) {
    if (!isDesktopInputId(id)) throw new Error("Invalid desktop input recovery ID.");
}

function statIfPresent(path) {
    try { return lstatSync(path); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
}

const isPrivate = stat => (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());

function privateDirectory(path, create) {
    let stat = statIfPresent(path);
    if (!stat && create) {
        mkdirSync(path, { mode: 0o700 });
        stat = lstatSync(path);
    }
    if (stat && (!stat.isDirectory() || !isPrivate(stat))) throw new Error("Unsafe desktop input recovery directory.");
    return stat ? path : undefined;
}

function syncDirectory(path) {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
}

function recoveryRoot(manager, create) {
    const dir = manager.getSessionDir();
    if (!manager.isPersisted() || !isAbsolute(dir) || !lstatSync(dir).isDirectory()) throw new Error("Desktop input recovery requires a persisted desktop session.");
    const root = privateDirectory(join(dir, ".queue-recovery"), create);
    if (root && create) syncDirectory(dir);
    return root;
}

export function existingDesktopQueueRecovery(manager, id) {
    checkId(id);
    const root = recoveryRoot(manager, false);
    const batch = root && privateDirectory(join(root, id), false);
    if (!batch) return undefined;
    const fd = openSync(join(batch, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let manifest;
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || !isPrivate(stat) || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_MANIFEST)
            throw new Error("Invalid desktop input recovery manifest.");
        const bytes = Buffer.allocUnsafe(stat.size);
        for (let offset = 0; offset < bytes.length;) {
            const used = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!used) throw new Error("Desktop input recovery manifest changed during read.");
            offset += used;
        }
        manifest = JSON.parse(bytes.toString("utf8"));
    }
    finally { closeSync(fd); }
    if (manifest.version !== 1 || manifest.sessionId !== manager.getSessionId() || manifest.id !== id || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_RECORDS)
        throw new Error("Invalid desktop input recovery manifest.");
    return { id, count: manifest.entries.length };
}

export function desktopInputPayload(text, images) {
    if (images === undefined) images = [];
    if (typeof text !== "string" || text.length > 100000 || !Array.isArray(images) || images.length > 6)
        throw new Error("Desktop input exceeds recovery limits.");
    let chars = 0;
    const parts = images.map(image => {
        const { type, mimeType, data } = image ?? {};
        if (type !== "image" || !MIME_TYPES.has(mimeType) || typeof data !== "string" || data.length > 14000000 - chars || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
            throw new Error("Invalid desktop image attachment.");
        chars += data.length;
        return { type, mimeType, data };
    });
    return { text, images: parts };
}

/** The queue owner calls this synchronously before removing any pending messages. */
export function writeDesktopQueueRecovery(manager, id, entries) {
    const previous = existingDesktopQueueRecovery(manager, id);
    if (previous) throw new Error("Desktop input recovery already exists for this ID.");
    if (entries.length === 0) return { id, count: 0 };
    if (entries.length > MAX_RECORDS) throw new Error("Too many pending messages to recover in one close. The pending messages remain in the session.");
    const root = recoveryRoot(manager, true);
    const staging = mkdtempSync(join(root, ".pending-"));
    const target = join(root, id);
    let published = false;
    try {
        const manifest = { version: 1, sessionId: manager.getSessionId(), id, entries: [] };
        let bytes = 0;
        for (const entry of entries) {
            checkId(entry.id);
            const json = JSON.stringify(entry);
            bytes += Buffer.byteLength(json);
            if (bytes > MAX_BYTES) throw new Error("Pending messages exceed the desktop recovery size limit. The pending messages remain in the session.");
            writeFileSync(join(staging, `${entry.id}.json`), json, { flag: "wx", mode: 0o600, flush: true });
            manifest.entries.push({ id: entry.id, kind: entry.kind, preview: entry.text.slice(0, 160).toWellFormed(), imageCount: entry.images.length });
        }
        writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600, flush: true });
        syncDirectory(staging);
        renameSync(staging, target);
        published = true;
        syncDirectory(root);
        return { id, count: entries.length };
    }
    catch (error) {
        try {
            rmSync(published ? target : staging, { recursive: true, force: true });
            if (published) syncDirectory(root);
        }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Desktop input recovery could not confirm or roll back its write."); }
        throw error;
    }
}

export function desktopInputDelivered(manager, id) {
    checkId(id);
    const root = recoveryRoot(manager, false);
    const directory = root && privateDirectory(join(root, ".delivered"), false);
    const marker = directory && statIfPresent(join(directory, id));
    if (marker && (!marker.isFile() || !isPrivate(marker))) throw new Error("Invalid desktop input delivery receipt.");
    return Boolean(marker);
}

export function markDesktopInputDelivered(manager, id) {
    checkId(id);
    const root = recoveryRoot(manager, true);
    const dir = privateDirectory(join(root, ".delivered"), true);
    const marker = join(dir, id);
    try { writeFileSync(marker, "", { flag: "wx", mode: 0o600, flush: true }); }
    catch (error) { if (error?.code !== "EEXIST" || !lstatSync(marker).isFile()) throw error; }
    syncDirectory(dir);
    syncDirectory(root);
}
