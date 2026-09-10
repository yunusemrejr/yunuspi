import { serveGzipStageWorker, } from "../gzip-stage-write.js";
// Streamed gzip stage write runs off the main thread via the shared core (see
// clients/gzip-stage-write.ts); this worker only echoes its routing fields.
serveGzipStageWorker((request) => ({
    id: request.id,
    cwd: request.cwd,
    generation: request.generation,
    stagePath: request.stagePath,
    elements: request.elements,
}));
