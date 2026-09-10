import registerReasoning from "./pi-subagents/src/extension/reasoning-aids.ts";
import { registerContextCodeTools } from "./pi-lens/context-tools.ts";
import registerSmallTools from "./lib/small-tools.ts";

export default function(pi: any) {
  registerReasoning(pi);
  registerSmallTools(pi);
  registerContextCodeTools(pi);
}
