/**
 * pi-lens fork — resource registration.
 *
 * WHY this file exists: upstream loaded its 4 skills through the npm package
 * manifest (`pi.skills`). The fork lives in a plain extension subdirectory,
 * where pi auto-discovers extensions but NOT package skills — so the fork
 * re-declares them via `resources_discover` (the fork-resources pattern).
 * Upstream provenance: npm:pi-lens 4.1.3, https://github.com/apmantza/pi-lens
 * (MIT).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

const SKILLS = [
	"pi-lens-ast-grep",
	"pi-lens-lsp-navigation",
	"pi-lens-write-ast-grep-rule",
	"pi-lens-write-tree-sitter-rule",
];

export default function registerPiLensResources(pi) {
	pi.on("resources_discover", () => ({
		skillPaths: SKILLS.map((s) => join(baseDir, "skills", s, "SKILL.md")),
	}));
}
