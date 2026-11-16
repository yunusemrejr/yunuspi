import type { Api, Model, Usage } from "../types.js";
export declare function isDirectDeepSeek(model: Model<Api>): boolean;
export declare function providerCreatedMs(value: unknown): number | undefined;
export declare function deepSeekPublishedPeakRate(id: string, at: number | undefined): Readonly<Pick<Usage["cost"], "input" | "output" | "cacheRead" | "cacheWrite">> | undefined;
export declare function applyDeepSeekPricing(model: Model<Api>, usage: Usage, reportedUsage: { server_tool_use?: unknown } | undefined, at: number | undefined, partial?: boolean): void;
