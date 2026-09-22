const sessionResourceCleanups = new Set();
export function registerSessionResourceCleanup(cleanup) {
    sessionResourceCleanups.add(cleanup);
    return () => {
        sessionResourceCleanups.delete(cleanup);
    };
}
export function cleanupSessionResources(sessionId) {
    const errors = [];
    // Invoke each registered cleanup once and drop it, so a session dispose
    // cannot re-run foreign cleanups or accumulate closures for the process
    // lifetime. Errors are aggregated after every cleanup had its chance.
    for (const cleanup of [...sessionResourceCleanups]) {
        sessionResourceCleanups.delete(cleanup);
        try {
            cleanup(sessionId);
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to cleanup session resources");
    }
}
