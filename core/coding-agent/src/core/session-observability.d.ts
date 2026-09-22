/** Session-scoped optional observability taps; standalone callers use the process scope. */
export declare function sessionObservability(): Record<symbol, any>;
export declare function withSessionObservability<T>(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined, callback: () => T): T;
