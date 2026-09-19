# Working on YunusPi

This is a public source repository. Never copy private harness configuration, credentials, provider state, sessions, memory, logs, archives or local model environments into it. Do not replace `.gitignore` or bypass the public scanner to admit runtime data.

For changes originating in a private installation, use `agent/scripts/harness-public-export.mjs` with a fresh output directory and these release templates. Inspect the generated diff and run `node scripts/check-public.mjs` and distribution tests before pushing. Preserve licenses and exact binary fingerprints; new binary assets require explicit provenance review.

Keep credentials and deployment/account examples generic. Provider names and public endpoints are fine; real account names, keys, SSH details, private domains and personal session excerpts are not. A passing pattern scanner is not proof that arbitrary prose is non-sensitive.

Keep release-template copies of public docs, installer, tests and safeguards synchronized with their root counterparts so subsequent private exports retain fixes. Never alter the user's live credentials while preparing a public release.

State tested platform support accurately. Linux is the full target; Windows uses WSL2 and macOS can use a Linux VM. Do not claim native support or successful model inference from static checks or catalog presence.

Before a substantial task phase, match the next decision to available tools and any task-specific skill. Read only the `SKILL.md` whose workflow will change that decision, apply the relevant guidance, and revisit the choice when scope changes. Keep simple work simple; skill descriptions guide choice and do not impose quotas, grant authorization or prove success.

The six runtime core packages under `core/` are YunusPi-owned source. Never install, upgrade, or query upstream Pi to build, repair, or update this product. Keep the immutable Pi 0.85.1 origin distinct from YunusPi core versions. Edit `core/*/src` and update declarations for API changes, build with `npm run build:core`, then run fork-independence and affected behavioral tests. Historical transforms under `agent/scripts/compatibility/legacy-transforms` are test fixtures only. Public exports must include the owned core source and workspace lockfile.
