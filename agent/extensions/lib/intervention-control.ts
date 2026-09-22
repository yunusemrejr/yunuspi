// Compatibility re-export. The pure arbitration implementation is owned by
// coding-agent core so extension-enabled and --no-extensions sessions use the
// same bounded control semantics.
export {
  DEFAULT_BUDGETS,
  InterventionControl,
  isActionable,
  isNoOpIntent,
  noopReceipt,
  type DecisionOutcome,
  type InterventionBudgets,
  type InterventionCategory,
  type InterventionControlOptions,
  type InterventionDecision,
  type InterventionEvidenceRef,
  type InterventionIntent,
  type SlotClaim,
} from "@yunuspi/coding-agent";
