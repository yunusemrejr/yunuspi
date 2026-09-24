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
- Kompress-small (`chopratejas/kompress-small`), when configured, is an operator-installed local service; check its model card and license before distribution or use.
- Qwen3.5-0.8B (`Qwen/Qwen3.5-0.8B`, Apache-2.0; GGUF from `ggml-org/Qwen3.5-0.8B-GGUF` at a pinned revision) and the llama.cpp `b10878` server binary (MIT, `ggml-org/llama.cpp`) are downloaded at install time by `agent/extensions/lib/local-lm-assets.mjs`, checksum-verified and never committed.

## Pi-derived core

The six packages in `core/` descend from Pi 0.85.1, commit `d981de1229ef899957bbe968bc8dcda02a21f477` in https://github.com/earendil-works/pi. Original copyright (c) 2025 Mario Zechner; package authorship also credits Earendil Works for Chord. Full original MIT notices are retained in each package's LICENSE. YunusPi modifications are maintained in this repository under MIT; this does not claim original authorship of Pi.

`core/identity.json` records exact source/package provenance. The runtime `clankolas.png` asset is preserved byte-for-byte from that baseline and has a pinned public-scanner fingerprint. Provider SDKs and other third-party libraries remain separately licensed dependencies with integrity-pinned lockfile entries.

## Creative studio and async design references

Three.js 0.180.0 is an exact-pinned MIT dependency downloaded by npm, with lockfile integrity. Standalone scene HTML includes the full Three.js license and the scene export also writes `THREE-LICENSE.txt`. Chromium/Playwright and FFmpeg remain separately licensed runtime dependencies; FFmpeg is supplied by the host.

Async improvements were informed by an independent source review of [Unreal Agent](https://github.com/unreallabsai/unreal-agent/tree/b7c9bf1c5c2fa4127255c07727a7c8413e23944a), MIT, copyright 2026 Unreal Labs. YunusPi implements these ideas in its existing JavaScript/TypeScript owners; no Unreal source code or Go runtime is bundled. The comparison and limitations are documented in `docs/ASYNC-AND-STUDIO.md`.
