import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { STEPFUN_AI_STEP_PLAN_MODELS } from "./stepfun-ai-step-plan.models.js";
export function stepfunAiStepPlanProvider() {
    return createProvider({
        id: "stepfun-ai-step-plan",
        name: "StepFun Step Plan (International)",
        baseUrl: "https://api.stepfun.ai/step_plan/v1",
        auth: { apiKey: envApiKeyAuth("StepFun Step Plan API key (International)", ["STEPFUN_AI_STEP_PLAN_API_KEY"]) },
        models: Object.values(STEPFUN_AI_STEP_PLAN_MODELS),
        api: openAICompletionsApi(),
    });
}
