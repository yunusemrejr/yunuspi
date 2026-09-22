/** Read the owned runtime's async session scope without importing the SDK into
 * small helper modules. The core is the sole scope owner. Standalone helpers
 * retain the existing process-local taps when no runtime is hosting them. */
export function sessionObservability(): Record<symbol, any> {
  return (globalThis as any)[Symbol.for('yunus-pi.observability-context.v1')]?.storage.getStore()?.values ?? globalThis;
}
