import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { STEPFUN_STEP_PLAN_MODELS } from "./stepfun-step-plan.models.js";
export function stepfunStepPlanProvider() {
    return createProvider({
        id: "stepfun-step-plan",
        name: "StepFun Step Plan",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        auth: { apiKey: envApiKeyAuth("StepFun Step Plan API key", ["STEPFUN_STEP_PLAN_API_KEY"]) },
        models: Object.values(STEPFUN_STEP_PLAN_MODELS),
        api: openAICompletionsApi(),
    });
}
