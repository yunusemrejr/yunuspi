import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Api, Model, Usage } from "../types.js";

export declare function isDirectAnthropicBilling(model: Pick<Model<Api>, "provider" | "baseUrl">, response: Pick<Response, "url" | "redirected">): boolean;
export declare function createAnthropicHostedUsage(options: {
    direct: boolean;
    subscription: boolean;
    requestedGeo?: string | null;
    tools?: readonly {type?: string}[];
}): {
    observe(event: BetaRawMessageStreamEvent): void;
    finish(usage: Usage): void;
};
