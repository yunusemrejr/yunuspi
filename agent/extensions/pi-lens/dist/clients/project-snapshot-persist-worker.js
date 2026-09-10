import { serveGzipStageWorker, } from "./gzip-stage-write.js";
import { fingerprintProjectSnapshotJson } from "./project-snapshot-fingerprint.js";
/**
 * Hash the serialized body while replacing only the top-level volatile
 * `generatedAt` value with a stable sentinel. This runs after the worker has
 * already paid the unavoidable stringify cost. It never walks the snapshot on
 * the extension host's event loop.
 */
function semanticSnapshotFingerprint(request, json) {
    const generatedAt = request.data.generatedAt;
    return fingerprintProjectSnapshotJson(json, typeof generatedAt === "string" ? generatedAt : "");
}
serveGzipStageWorker((request) => ({
    id: request.id,
    generation: request.generation,
    stagePath: request.stagePath,
}), {
    semanticFingerprint: semanticSnapshotFingerprint,
    skipIfFingerprints: (request) => request.priorFingerprints,
});
