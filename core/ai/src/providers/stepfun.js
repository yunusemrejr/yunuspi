import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { STEPFUN_MODELS } from "./stepfun.models.js";
export function stepfunProvider() {
    return createProvider({
        id: "stepfun",
        name: "StepFun",
        baseUrl: "https://api.stepfun.com/v1",
        auth: { apiKey: envApiKeyAuth("StepFun API key", ["STEPFUN_API_KEY"]) },
        models: Object.values(STEPFUN_MODELS),
        api: openAICompletionsApi(),
    });
}
