const sessionResourceCleanups = new Set();
export function registerSessionResourceCleanup(cleanup) {
    sessionResourceCleanups.add(cleanup);
    return () => {
        sessionResourceCleanups.delete(cleanup);
    };
}
export function cleanupSessionResources(sessionId) {
    const errors = [];
    // Registrations belong to the loaded module, not to one session, so only the
    // disposer returned by registerSessionResourceCleanup removes an entry.
    // Draining the registry here left every later session in the same process
    // without cleanup at all. Errors are aggregated after every cleanup had its
    // chance.
    for (const cleanup of [...sessionResourceCleanups]) {
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
