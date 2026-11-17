import type { ResponseStreamEvent, Tool } from "openai/resources/responses/responses.js";
import type { Api, AssistantMessage, Model } from "../types.js";

export interface ResponsesHostedToolRates {
    webSearch?: number;
    fileSearch?: number;
    imageModel?: string;
}

export declare function responsesHostedToolRates(model: Pick<Model<Api>, "provider" | "baseUrl">, tools?: readonly Tool[],
    response?: Pick<Response, "url" | "redirected">, serviceTier?: string | null): ResponsesHostedToolRates | undefined;
export declare function createResponsesHostedUsageMeter(provider: string, rates?: ResponsesHostedToolRates): {
    observe(event: ResponseStreamEvent): void;
    finish(output: AssistantMessage): void;
};
