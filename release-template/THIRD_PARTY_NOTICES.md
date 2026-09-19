# Third-party notices

YunusPi includes locally modified extensions. Their original notices remain in their directories:

- pi-lens 4.1.3 — MIT; original npm distribution license restored. Nested CodeRabbit rule assets retain their Apache-2.0 license.
- pi-subagents — retain `agent/extensions/pi-subagents/LICENSE`.
- pi-background-tasks — retain `agent/extensions/pi-background-tasks/LICENSE`.
- pi-memory — retain `agent/extensions/pi-memory/LICENSE`.
- rpiv-todo — retain `agent/extensions/rpiv-todo/LICENSE`.
- pi-web-access — retain `agent/extensions/pi-web-access/LICENSE`.
- Cytoscape.js 3.33.3 — MIT; graph viewer library, retained verbatim with `agent/extensions/lib/project-intelligence/viewer-assets/CYTOSCAPE-LICENSE` and upstream provenance in that directory's README.

Parser WASM assets are retained from the existing pi-lens package and fingerprinted by the public checker. Preserve upstream notices when modifying or redistributing them. npm dependencies are downloaded separately from the exact lockfile and retain their respective package licenses. The Pi-derived runtime is owned source under `core/`; each package retains the upstream MIT license.

External office/CAD/media applications and optional model weights are not bundled. Check their licenses and model cards before distribution or use. This notice does not relicense upstream components under the root MIT license.

## Local-inference runtimes (downloaded at install time, never committed)

- Needle3 (Cactus Compute) — Apache-2.0. The `needle.js`/`needle.wasm` engine and `needle3.cact` weights are fetched during setup from the official `Cactus-Compute/needle3` Hugging Face repository at a pinned revision with SHA-256 verification; upstream source is https://github.com/cactus-compute/needle. Telemetry is disabled (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`). A copy of the upstream LICENSE is installed beside the weights.
- Kompress-small (`chopratejas/kompress-small`) and SmolLM2-135M-Instruct loopback runtimes, when configured, are operator-installed local services; check their model cards and licenses before distribution or use.

## Pi-derived core

The six packages in `core/` descend from Pi 0.85.1, commit `d981de1229ef899957bbe968bc8dcda02a21f477` in https://github.com/earendil-works/pi. Original copyright (c) 2025 Mario Zechner; package authorship also credits Earendil Works for Chord. Full original MIT notices are retained in each package's LICENSE. YunusPi modifications are maintained in this repository under MIT; this does not claim original authorship of Pi.

`core/identity.json` records exact source/package provenance. The runtime `clankolas.png` asset is preserved byte-for-byte from that baseline and has a pinned public-scanner fingerprint. Provider SDKs and other third-party libraries remain separately licensed dependencies with integrity-pinned lockfile entries.
