import type { ModelsRefreshResult } from "@yunuspi/ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;
/** Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent. */
export declare function refreshModelCatalogs(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult>;
export {};
