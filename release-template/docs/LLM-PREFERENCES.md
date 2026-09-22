# Explicit model preferences (`llm_preferences.json`)

`~/.pi/settings/llm_preferences.json` is an optional preference layer over the
existing autonomous model selection. It guides the autonomous system; it does
not replace it.

Resolution hierarchy:

1. Look for an applicable explicit preference in `llm_preferences.json`.
2. Validate it against the live registry, cached exclusions, shared
   provider-health cooldowns and capability requirements.
3. Try configured preferences in their declared order.
4. If one is unusable or fails, continue through the remaining entries.
5. If the file is missing, malformed, has no applicable preference, or every
   configured option fails, hand control back to the current autonomous
   selection (free-model preference, availability, benchmark quality gates,
   economy caps — see [Model routing](MODEL-ROUTING.md)).

Invalid aliases, model entries and role lists are reported and skipped while
valid entries remain active. Unsupported thinking levels retain the model and
use dynamic child thinking, as described below.

A viable preference keeps its place across repeated requests and sessions.
Usage frequency and random rotation do not move free alternatives ahead of it.
Context, output, modality, tool-support and quota failures explain why an entry
was skipped. The same order survives launch-time economy filtering; bounded
fallback attempts try the remaining configured routes before autonomous picks.

An explicit free-only task constraint filters preference chains to
proven-free routes. Automatic council and review rounds keep honoring
configured routes while their autonomous fill stays free-only.

Tool-calling capability is proven by catalog facts that exist only for
OpenRouter and OrcaRouter with fresh evidence. A configured route whose
tool support is unknown (another provider, or stale/missing evidence)
still passes validation — the explicit configuration is the positive
evidence — and only a known-negative blocks it. Autonomous selection
without configured preferences keeps requiring positive tool proof.

## State vs policy

Harness persistence records the main model/provider/thinking configuration
you actually selected. `llm_preferences.json` defines preferences and
fallbacks. The JSON never silently becomes the source of truth for the
normal main-session model:

- Main session: your last harness-selected configuration stays active while
  healthy. Only after repeated failure (three consecutive failures, or
  immediately for dead credentials) does recovery consult
  `main_session_fallback`, and only then the autonomous fallback logic.
- Automatic-recovery routes are never persisted as your default model.
- Main-session thinking always stays yours; preference thinking levels apply
  to child teams, never to your active session.

## Schema

```json
{
  "version": 1,
  "models": {
    "cheap_auto": {
      "provider": "openrouter",
      "model": "qwen/qwen3-235b-a22b:free",
      "thinking": "low",
      "provider_options": { "routing": "auto" }
    },
    "strong_pinned": {
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4",
      "thinking": "high",
      "provider_options": {
        "routing": "pinned",
        "order": ["deepinfra"],
        "allow_fallbacks": false
      }
    }
  },
  "preferences": {
    "main_session_fallback": { "models": ["cheap_auto"] },
    "subagents": { "models": ["cheap_auto", "strong_pinned"] },
    "council": { "models": ["strong_pinned", "cheap_auto"] },
    "swarm": { "models": ["cheap_auto"] },
    "fusion": { "models": ["cheap_auto"] },
    "quality_review": { "models": ["cheap_auto"] },
    "project_review": { "models": ["cheap_auto"] },
    "error_review": { "models": ["cheap_auto"] },
    "prompt_analysis": { "models": ["cheap_auto"] }
  }
}
```

- `models` is a reusable alias registry. `model` is required (bare id,
  `provider/id`, or with a `:thinking` suffix). When supplied, `provider` is
  authoritative: an owner namespace inside `model` is part of the vendor ID,
  even if that namespace also names another registered provider. Case and
  supported separator differences resolve against the live registry.
- `preferences.<role>.models` is an ordered list of aliases (or inline
  entries). Role names accept `subagents`, `council`, `swarm`, `fusion`,
  `quality_review`, `project_review`, `error_review` and
  `main_session_fallback`, and `prompt_analysis` (dashes, case and
  singular/plural variants are accepted). Unknown roles pass through for
  future mechanisms. When `prompt_analysis` has no explicit list, its
  low-cost, tool-free initial and follow-up checks inherit the ordered
  `subagents` chain; no model ID is hardcoded by prompt analysis.
- Ad-hoc subagent tasks use the `subagents` chain unless the task explicitly
  names a review or council (`project review`, `error review`, `bug review`,
  `quality review`, `council`). Automatic dispatchers pass their role
  explicitly. A full example lives in
  [llm_preferences.example.json](../config/llm_preferences.example.json).

## Thinking levels

`thinking` accepts harness levels (`off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`) plus `auto` (dynamic logic decides) and `none`
(equivalent to `off`). Omitted, `auto` or unrecognized values retain the
existing dynamic-thinking behavior (configured defaults, thinking ceilings
and the effort policy). An explicitly configured but unsupported level drops
back to dynamic logic for that entry; the model itself stays usable.

## OpenRouter backend control

`provider_options` translates to the existing OpenRouter `compat`
vocabulary — the same shapes `/provider order|only|json` persists:

- `"routing": "auto"` (or omitted) preserves normal OpenRouter selection.
- `"routing": "pinned"` with `order` becomes a hard backend pin
  (`only` + `allow_fallbacks: false`).
- `"routing": "custom"` with `order`/`allow_fallbacks` (plus optional
  `only`, `ignore`, `sort`) becomes an ordered backend preference.

Backend pins apply to main-session fallback recovery through the existing
`compat` path. Child launches carry the selected provider options into each
request payload with a request-local hook, so a retry on the same model can
use a different configured backend without mutating the shared registry
model. Global `/provider` pins in `models.json` remain part of the route.
`provider_options` is ignored for non-OpenRouter providers.

The `/models` command opens the graphical editor for these same preferences.
It saves against a content revision, keeps unknown JSON fields, writes a
verified backup, and refuses to overwrite concurrent manual edits. See
[Model routing](MODEL-ROUTING.md) for provider-aware search, diagnostics and
recovery behavior.

## Parallel allocation

One agent uses the first viable preference. Several simultaneous agents are
distributed across the viable list (first agent → first preference, second →
second, and so on) instead of cloning the first model. Councils and other
multi-model workflows favor distinct model identities first. When more agents
are needed than viable preferences, suitable entries are reused and the
existing autonomous selector fills the remaining gaps.
