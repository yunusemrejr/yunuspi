import { uuidv7 } from "@yunuspi/ai/utils/uuid";
import { createForkSnapshot } from "../fork.js";
import { StorageBackedSession } from "../session.js";
import { parseJsonlSessionHeader } from "./codec.js";
import { metadataFromLegacyV3Header } from "./legacy-v3.js";
import { JsonlStorage } from "./storage.js";
import { JSONL_FORMAT_VERSION, JSONL_STORAGE_VERSION, } from "./types.js";
const openSessionLeases = new Map();
const pendingSessionCreations = new Map();
function acquireSessionLease(path, id) {
    const token = {};
    if (openSessionLeases.has(path))
        throw new Error(`Session is already open: ${id}`);
    openSessionLeases.set(path, token);
    return () => {
        if (openSessionLeases.get(path) === token)
            openSessionLeases.delete(path);
    };
}
function acquireSessionCreation(key, id) {
    const token = {};
    if (pendingSessionCreations.has(key))
        throw new Error(`Session already exists: ${id}`);
    pendingSessionCreations.set(key, token);
    return () => {
        if (pendingSessionCreations.get(key) === token)
            pendingSessionCreations.delete(key);
    };
}
function fileValue(result, action) {
    if (!result.ok)
        throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
    return result.value;
}
function metadataFromHeader(header, path, modifiedAt) {
    return {
        id: header.id,
        createdAt: header.createdAt,
        storageVersion: header.storageVersion,
        cwd: header.cwd,
        path,
        modifiedAt,
        ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
        ...(header.legacyParentSessionPath === undefined
            ? {}
            : { legacyParentSessionPath: header.legacyParentSessionPath }),
    };
}
function sessionDirectoryName(cwd) {
    return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
function sessionFileName(createdAt, id) {
    const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
    return `${timestamp}_${encodeURIComponent(id)}.jsonl`;
}
/** File-backed format-4 session repository lifecycle. */
export class JsonlSessionRepo {
    fileSystem;
    sessionsRootInput;
    now;
    openSessions = new Map();
    pendingCreates = new Set();
    admitted = new Set();
    closed = false;
    closePromise;
    constructor(options) {
        this.fileSystem = options.fileSystem;
        this.sessionsRootInput = options.sessionsRoot;
        this.now = options.now ?? Date.now;
    }
    async create(options, context) {
        const finishOperation = this.admit();
        try {
            const createdAt = this.now();
            const { cwd, id } = await this.resolveCreateDestination(options.cwd, options.id, createdAt, context);
            const key = this.sessionKey(cwd, id);
            if (this.openSessions.has(key) || this.pendingCreates.has(key))
                throw new Error(`Session already exists: ${id}`);
            this.pendingCreates.add(key);
            let path;
            let storage;
            let releaseLease;
            let releaseCreation;
            let removeOnFailure = false;
            try {
                const destination = await this.resolveNewSessionPath(cwd, createdAt, id, context);
                path = destination.path;
                releaseCreation = acquireSessionCreation(destination.creationKey, id);
                await this.assertSessionIdAvailable(destination.directory, id, context);
                releaseLease = acquireSessionLease(destination.leasePath, id);
                const header = {
                    v: JSONL_FORMAT_VERSION,
                    kind: "header",
                    id,
                    storageVersion: JSONL_STORAGE_VERSION,
                    createdAt,
                    cwd,
                    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
                };
                storage = await JsonlStorage.create({ fileSystem: this.fileSystem, path, now: this.now }, header, [], context);
                removeOnFailure = true;
                const info = fileValue(await this.fileSystem.fileInfo(path, context), `Failed to read session ${path}`);
                return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, key, releaseLease);
            }
            catch (error) {
                await storage?.close(context).catch(() => undefined);
                releaseLease?.();
                if (removeOnFailure && path !== undefined)
                    await this.fileSystem.remove(path, { force: true }, context);
                throw error;
            }
            finally {
                releaseCreation?.();
                this.pendingCreates.delete(key);
            }
        }
        finally {
            finishOperation();
        }
    }
    async open(metadata, context) {
        const finishOperation = this.admit();
        try {
            const key = this.sessionKey(metadata.cwd, metadata.id);
            if (this.openSessions.has(key))
                throw new Error(`Session is already open: ${metadata.id}`);
            let storage;
            let releaseLease;
            try {
                const leasePath = fileValue(await this.fileSystem.canonicalPath(metadata.path, context), `Failed to resolve session ${metadata.path}`);
                releaseLease = acquireSessionLease(leasePath, metadata.id);
                storage = await this.loadStorage(metadata, context);
                return this.publishOpenSession(metadata, storage, key, releaseLease);
            }
            catch (error) {
                await storage?.close(context);
                releaseLease?.();
                throw error;
            }
        }
        finally {
            finishOperation();
        }
    }
    async list(options, context) {
        const finishOperation = this.admit();
        try {
            options ??= {};
            const cwd = options.cwd === undefined
                ? undefined
                : fileValue(await this.fileSystem.absolutePath(options.cwd, context), `Failed to resolve session cwd ${options.cwd}`);
            const root = await this.root(context);
            if (!fileValue(await this.fileSystem.exists(root, context), `Failed to check sessions root ${root}`))
                return [];
            const directories = cwd === undefined ? await this.sessionDirectories(root, context) : [await this.sessionDirectory(cwd, context)];
            const metadata = [];
            for (const directory of directories)
                metadata.push(...(await this.listDirectory(directory, cwd, context)));
            return metadata.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id) || left.cwd.localeCompare(right.cwd));
        }
        finally {
            finishOperation();
        }
    }
    async delete(metadata, context) {
        const finishOperation = this.admit();
        let releaseLease;
        try {
            const key = this.sessionKey(metadata.cwd, metadata.id);
            if (this.openSessions.has(key))
                throw new Error(`Session is open: ${metadata.id}`);
            if (!fileValue(await this.fileSystem.exists(metadata.path, context), `Failed to check session ${metadata.path}`)) {
                throw new Error(`Session file does not exist: ${metadata.path}`);
            }
            const leasePath = fileValue(await this.fileSystem.canonicalPath(metadata.path, context), `Failed to resolve session ${metadata.path}`);
            releaseLease = acquireSessionLease(leasePath, metadata.id);
            fileValue(await this.fileSystem.remove(metadata.path, undefined, context), `Failed to delete session ${metadata.path}`);
        }
        finally {
            releaseLease?.();
            finishOperation();
        }
    }
    async fork(source, options, context) {
        const finishOperation = this.admit();
        try {
            const createdAt = this.now();
            const sourceRecord = this.openSessions.get(this.sessionKey(source.cwd, source.id));
            const sourceSnapshot = await (sourceRecord === undefined
                ? this.loadClosedForkSourceSnapshot(source, context)
                : sourceRecord.storage.captureForkSource(context));
            const { cwd, id } = await this.resolveCreateDestination(source.cwd, options.id, createdAt, context);
            const destinationKey = this.sessionKey(cwd, id);
            if (this.openSessions.has(destinationKey) || this.pendingCreates.has(destinationKey)) {
                throw new Error(`Session already exists: ${id}`);
            }
            this.pendingCreates.add(destinationKey);
            let path;
            let storage;
            let releaseLease;
            let releaseCreation;
            let removeOnFailure = false;
            try {
                const destination = await this.resolveNewSessionPath(cwd, createdAt, id, context);
                path = destination.path;
                releaseCreation = acquireSessionCreation(destination.creationKey, id);
                await this.assertSessionIdAvailable(destination.directory, id, context);
                releaseLease = acquireSessionLease(destination.leasePath, id);
                const snapshot = createForkSnapshot(sourceSnapshot, options);
                const header = {
                    v: JSONL_FORMAT_VERSION,
                    kind: "header",
                    id,
                    storageVersion: JSONL_STORAGE_VERSION,
                    createdAt,
                    cwd,
                    parentSessionId: source.id,
                };
                storage = await JsonlStorage.createFromForkSnapshot({ fileSystem: this.fileSystem, path, now: this.now }, header, snapshot, context);
                removeOnFailure = true;
                const info = fileValue(await this.fileSystem.fileInfo(path, context), `Failed to read session ${path}`);
                return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, destinationKey, releaseLease);
            }
            catch (error) {
                await storage?.close(context).catch(() => undefined);
                releaseLease?.();
                if (removeOnFailure && path !== undefined)
                    await this.fileSystem.remove(path, { force: true }, context);
                throw error;
            }
            finally {
                releaseCreation?.();
                this.pendingCreates.delete(destinationKey);
            }
        }
        finally {
            finishOperation();
        }
    }
    close(context) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.closed = true;
        this.closePromise = (async () => {
            await Promise.allSettled([...this.admitted]);
            await Promise.all([...this.openSessions.values()].map(({ session }) => session.close(context)));
        })();
        return this.closePromise;
    }
    async resolveCreateDestination(cwdInput, id, createdAt, context) {
        const destinationId = id ?? uuidv7(createdAt);
        const cwd = fileValue(await this.fileSystem.absolutePath(cwdInput, context), `Failed to resolve session cwd ${cwdInput}`);
        return { cwd, id: destinationId };
    }
    async listDirectory(directory, cwd, context) {
        if (!fileValue(await this.fileSystem.exists(directory, context), `Failed to check sessions directory ${directory}`)) {
            return [];
        }
        const files = fileValue(await this.fileSystem.listDir(directory, context), `Failed to list sessions directory ${directory}`).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
        const metadata = [];
        for (const file of files) {
            const discovered = await this.readSessionMetadata(file, context);
            if (discovered === undefined)
                continue;
            // Directory encoding is lossy: /a/b and /a-b both map to --a-b--.
            if (cwd === undefined || discovered.cwd === cwd)
                metadata.push(discovered);
        }
        return metadata;
    }
    async readSessionMetadata(file, context) {
        const lines = fileValue(await this.fileSystem.readTextLines(file.path, { maxLines: 1 }, context), `Failed to read session header ${file.path}`);
        if (lines[0] === undefined)
            return undefined;
        const parsedHeader = parseJsonlSessionHeader(lines[0]);
        if (!parsedHeader.ok)
            return undefined;
        if (parsedHeader.value.format === "v3-legacy") {
            const metadata = await metadataFromLegacyV3Header(this.fileSystem, parsedHeader.value.header, context);
            return { ...metadata, path: file.path, modifiedAt: file.mtimeMs };
        }
        return metadataFromHeader(parsedHeader.value.header, file.path, file.mtimeMs);
    }
    async sessionDirectories(root, context) {
        return fileValue(await this.fileSystem.listDir(root, context), `Failed to list sessions root ${root}`)
            .filter((entry) => entry.kind === "directory")
            .map((entry) => entry.path);
    }
    async sessionDirectory(cwd, context) {
        return fileValue(await this.fileSystem.joinPath([await this.root(context), sessionDirectoryName(cwd)], context), `Failed to resolve sessions directory for ${cwd}`);
    }
    async resolveNewSessionPath(cwd, createdAt, id, context) {
        const directory = await this.sessionDirectory(cwd, context);
        fileValue(await this.fileSystem.createDir(directory, undefined, context), `Failed to create sessions directory ${directory}`);
        const canonicalDirectory = fileValue(await this.fileSystem.canonicalPath(directory, context), `Failed to resolve sessions directory ${directory}`);
        const fileName = sessionFileName(createdAt, id);
        return {
            directory,
            path: fileValue(await this.fileSystem.joinPath([directory, fileName], context), `Failed to resolve path for session ${id}`),
            leasePath: fileValue(await this.fileSystem.joinPath([canonicalDirectory, fileName], context), `Failed to resolve lease path for session ${id}`),
            creationKey: `${canonicalDirectory}\0${id}`,
        };
    }
    async assertSessionIdAvailable(directory, id, context) {
        if (!fileValue(await this.fileSystem.exists(directory, context), `Failed to check sessions directory ${directory}`))
            return;
        const suffix = `_${encodeURIComponent(id)}.jsonl`;
        const idExists = fileValue(await this.fileSystem.listDir(directory, context), `Failed to list sessions directory ${directory}`).some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
        if (idExists)
            throw new Error(`Session already exists: ${id}`);
    }
    async loadClosedForkSourceSnapshot(source, context) {
        const leasePath = fileValue(await this.fileSystem.canonicalPath(source.path, context), `Failed to resolve session ${source.path}`);
        const releaseLease = acquireSessionLease(leasePath, source.id);
        let storage;
        try {
            storage = await this.loadStorage(source, context);
            return await storage.captureForkSource(context);
        }
        finally {
            await storage?.close(context);
            releaseLease();
        }
    }
    publishOpenSession(metadata, storage, key, releaseLease) {
        if (this.openSessions.has(key)) {
            releaseLease();
            throw new Error(`Session is already open: ${metadata.id}`);
        }
        let record;
        const session = new StorageBackedSession(metadata, storage, {
            onClose: () => {
                if (this.openSessions.get(key) === record)
                    this.openSessions.delete(key);
                releaseLease();
            },
        });
        record = { session, storage };
        this.openSessions.set(key, record);
        return session;
    }
    sessionKey(cwd, id) {
        return `${cwd}\0${id}`;
    }
    async loadStorage(metadata, context) {
        if (!fileValue(await this.fileSystem.exists(metadata.path, context), `Failed to check session ${metadata.path}`)) {
            throw new Error(`Session file does not exist: ${metadata.path}`);
        }
        const storage = await JsonlStorage.open({
            fileSystem: this.fileSystem,
            path: metadata.path,
            now: this.now,
        }, context);
        try {
            if (storage.header.id !== metadata.id || storage.header.cwd !== metadata.cwd) {
                throw new Error(`Session identity does not match header: ${metadata.id}`);
            }
            if (storage.header.storageVersion !== JSONL_STORAGE_VERSION) {
                throw new Error(`Session ${metadata.id} uses unsupported storage version ${storage.header.storageVersion}`);
            }
            return storage;
        }
        catch (error) {
            await storage.close(context);
            throw error;
        }
    }
    root(context) {
        return this.fileSystem
            .absolutePath(this.sessionsRootInput, context)
            .then((result) => fileValue(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
    }
    assertOpen() {
        if (this.closed)
            throw new Error("JsonlSessionRepo is closed");
    }
    admit() {
        this.assertOpen();
        let finish;
        const completion = new Promise((resolve) => {
            finish = resolve;
        });
        this.admitted.add(completion);
        return () => {
            this.admitted.delete(completion);
            finish();
        };
    }
}
