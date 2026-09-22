// Compatibility re-export. Keep existing extension imports source-compatible
// while the sole implementation lives in the owned core package.
export {
  createInterventionSession,
  type InterventionSession,
  type InterventionSessionOptions,
  type ShadowAudit,
  type ShadowRecord,
} from "@yunuspi/coding-agent";
