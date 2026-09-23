import { bedrockProviderModule } from "@yunuspi/ai/bedrock-provider";
import { registerBunOAuthFlows } from "@yunuspi/ai/bun-oauth";
import { setBedrockProviderModule } from "@yunuspi/ai/compat";
import { APP_NAME } from "../config.js";
// Linux update safety identifies active core owners from their original argv.
if (process.platform !== "linux") process.title = APP_NAME;
process.emitWarning = (() => { });
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
