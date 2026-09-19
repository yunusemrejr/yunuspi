/**
 * /effort — minimal thinking control for custom providers.
 *
 * The native /thinking command sets pi's thinking level, but it only accepts
 * levels a model advertises as available (via `thinkingLevelMap`). On custom /
 * OpenAI-compatible providers where that map is incomplete or missing, the
 * default thinking never engages and /thinking refuses mid-range levels
 * ("Unknown thinking level"). This tiny command is a decoupled knob: it reads
 * the active level, shows what's reachable for the current model, and lets you
 * set any level (pi clamps to the model's real capabilities). Native /thinking
 * is left untouched.
 *
 *   /effort           list current + available levels
 *   /effort <level>   set thinking level (off..max)
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@yunuspi/coding-agent";

const LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type Level = (typeof LEVELS)[number];

/** Levels the active model actually supports (mirrors pi's own rule). */
function available(model: ExtensionContext["model"]): Level[] {
	if (!model?.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	return LEVELS.filter((l) => {
		if (map?.[l] === null) return false;
		if (l === "xhigh" || l === "max") return map?.[l] !== undefined;
		return true;
	});
}

function isLevel(v: string): v is Level {
	return (LEVELS as readonly string[]).includes(v);
}

export default function thinkingExtension(pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description:
			"Set thinking (reasoning-effort) level for the active model — incl. custom providers the default /thinking can't engage",
		argumentHint: "[off|minimal|low|medium|high|xhigh|max]",
		handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(
					`Thinking: ${pi.getThinkingLevel()}. Available: ${available(ctx.model).join(" | ")}. Usage: /effort <level>`,
					"info",
				);
				return;
			}
			if (!isLevel(arg)) {
				ctx.ui.notify(
					`Unknown level "${arg}". Valid: ${LEVELS.join(", ")}`,
					"error",
				);
				return;
			}
			const prev = pi.getThinkingLevel();
			pi.setThinkingLevel(arg);
			ctx.ui.notify(`Thinking: ${prev} → ${pi.getThinkingLevel()}`, "info");
		},
	});
}
