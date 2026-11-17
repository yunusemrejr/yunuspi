import type { Api, Model, Usage } from "../types.ts";

interface OpenRouterUsageReceipt {
    routerCost?: number;
    byok?: boolean;
    upstreamCost?: number;
}

export declare function isOpenRouterBillingEndpoint(model: Model<Api>, response: Response, endpoint: "chat/completions" | "responses"): boolean;
export declare function applyOpenRouterUsage(usage: Usage, raw: { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } }, previous?: OpenRouterUsageReceipt): OpenRouterUsageReceipt;
