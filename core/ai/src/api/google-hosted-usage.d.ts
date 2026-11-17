import type { GenerateContentParameters, GenerateContentResponse, GoogleGenAI } from "@google/genai";
import type { Api, AssistantMessage, Model } from "../types.js";

export declare function createGoogleHostedUsage(model: Model<Api>, params: GenerateContentParameters, client: GoogleGenAI): {
    observe(chunk: GenerateContentResponse, output: AssistantMessage): boolean;
    finish(output: AssistantMessage, complete: boolean): void;
};
