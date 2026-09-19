# Third-party notices

YunusPi includes locally modified extensions. Their original notices remain in their directories:

- pi-lens 4.1.3 — MIT; original npm distribution license restored. Nested CodeRabbit rule assets retain their Apache-2.0 license.
- pi-subagents — retain `agent/extensions/pi-subagents/LICENSE`.
- pi-background-tasks — retain `agent/extensions/pi-background-tasks/LICENSE`.
- pi-memory — retain `agent/extensions/pi-memory/LICENSE`.
- rpiv-todo — retain `agent/extensions/rpiv-todo/LICENSE`.
- pi-web-access — retain `agent/extensions/pi-web-access/LICENSE`.
- Cytoscape.js 3.33.3 — MIT; graph viewer library, retained verbatim with `agent/extensions/lib/project-intelligence/viewer-assets/CYTOSCAPE-LICENSE` and upstream provenance in that directory's README.

Parser WASM assets are retained from the existing pi-lens package and fingerprinted by the public checker. Preserve upstream notices when modifying or redistributing them. npm dependencies are downloaded separately from the exact lockfile and retain their respective package licenses. The Pi core is installed separately; YunusPi patches do not replace its license.

External office/CAD/media applications and optional model weights are not bundled. Check their licenses and model cards before distribution or use. This notice does not relicense upstream components under the root MIT license.

## Local-inference runtimes (downloaded at install time, never committed)

- Needle3 (Cactus Compute) — Apache-2.0. The `needle.js`/`needle.wasm` engine and `needle3.cact` weights are fetched during setup from the official `Cactus-Compute/needle3` Hugging Face repository at a pinned revision with SHA-256 verification; upstream source is https://github.com/cactus-compute/needle. Telemetry is disabled (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`). A copy of the upstream LICENSE is installed beside the weights.
- Kompress-small (`chopratejas/kompress-small`) and SmolLM2-135M-Instruct loopback runtimes, when configured, are operator-installed local services; check their model cards and licenses before distribution or use.
