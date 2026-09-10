/**
 * pi-subagents fork — resource registration.
 *
 * WHY this file exists: upstream loaded its 6 prompt templates through the
 * npm package manifest (`pi.prompts: ["./prompts"]`). The fork lives in a
 * plain extension subdirectory, where pi auto-discovers extensions but NOT
 * package prompts — so the fork re-declares them via `resources_discover`.
 * Upstream's duplicate package skills (council-mode, pi-subagents) were
 * already shadowed by user ~/skills copies and are deliberately NOT
 * re-declared. Upstream provenance: npm:pi-subagents (MIT).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

const PROMPTS = [
	"council.md",
	"fusion.md",
	"gather-context-and-clarify.md",
	"parallel-cleanup.md",
	"parallel-research.md",
	"parallel-review.md",
	"review-loop.md",
];

export default function registerSubagentResources(pi) {
	pi.on("resources_discover", () => ({
		promptPaths: PROMPTS.map((p) => join(baseDir, "prompts", p)),
	}));
}
