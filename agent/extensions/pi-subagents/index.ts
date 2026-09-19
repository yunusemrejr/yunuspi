import type { ExtensionAPI } from "@yunuspi/coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

const registerParentExtension = process.env.PI_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	registerParentExtension?.(pi);
}