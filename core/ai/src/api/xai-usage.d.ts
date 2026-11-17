import type { Api, Model, Usage } from "../types.ts";

export declare function isXaiBillingEndpoint(model: Model<Api>, response: Response, endpoint: "chat/completions" | "responses"): boolean;
export declare function applyXaiUsage(usage: Usage, raw: {cost_in_usd_ticks?: unknown}, previous?: number): number | undefined;
