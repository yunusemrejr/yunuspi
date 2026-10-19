# Working on YunusPi

This is a public source repository. Never copy private harness configuration, credentials, provider state, sessions, memory, logs, archives or local model environments into it. Do not replace `.gitignore` or bypass the public scanner to admit runtime data.

Make changes in this repository directly; the repository root is the only source tree. `agent/scripts/harness-public-export.mjs` is only for exporting from a private installation: give it a fresh output directory, inspect the generated diff, and run `node scripts/check-public.mjs` and distribution tests before pushing. Preserve licenses and exact binary fingerprints; new binary assets require explicit provenance review.

Keep credentials and deployment/account examples generic. Provider names and public endpoints are fine; real account names, keys, SSH details, private domains and personal session excerpts are not. A passing pattern scanner is not proof that arbitrary prose is non-sensitive.

Never alter the user's live credentials while preparing a public release.

State tested platform support accurately. Linux is the full target; Windows uses WSL2 and macOS can use a Linux VM. Do not claim native support or successful model inference from static checks or catalog presence.

Before a substantial task phase, match the next decision to available tools. Use relevant tools to inspect, execute and verify the work, and revisit the choice when scope changes or a tool fails. Skills and `SKILL.md` files are optional guides and docs: consult and adapt useful steps, including mandatory wording, without a required read or skill-count quota. User instructions, tool contracts and safety boundaries take precedence. A guide cannot grant authorization or prove success. Keep simple work simple.

The six runtime core packages under `core/` are YunusPi-owned source. Never install, upgrade, or query upstream Pi to build, repair, or update this product. Keep the immutable Pi 0.85.1 origin distinct from YunusPi core versions. Edit `core/*/src` and update declarations for API changes, build with `npm run build:core`, then run fork-independence and affected behavioral tests. Historical transforms under `agent/scripts/compatibility/legacy-transforms` are test fixtures only. Public exports must include the owned core source and workspace lockfile.
