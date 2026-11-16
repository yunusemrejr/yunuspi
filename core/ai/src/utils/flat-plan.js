const FLAT_PLAN_PROVIDER = /(?:^|-)(?:token-plan|step-plan|coding-plan)(?:-|$)|^kimi-coding$|^streamlake-kat-coding(?:-|$)/;

export function isFlatPlanProvider(provider) {
    return typeof provider === "string" && FLAT_PLAN_PROVIDER.test(provider);
}
