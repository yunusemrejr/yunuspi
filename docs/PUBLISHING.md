# Public release boundary

Never initialize Git in the live `~/.pi` directory. Never publish a private backup ZIP or session HTML/JSON export: restore backups contain credentials; session exports can contain personal prose.

The public exporter reads only reusable extensions, skills, runtime scripts, explicitly listed synthetic core compatibility checks and dependency manifests. It excludes live settings/authentication, provider caches, histories, memories, logs, sessions, experiments, private benchmark fixtures, backups, node_modules, model weights and environments. It substitutes the source fallback credential with an environment lookup and normalizes personal home-path examples. The working local installation is not modified.

## Release identity

YunusPi is distributed as source rather than as a published npm package, so Git history and package metadata serve different purposes. The full Git commit SHA is the authoritative identity of a development build; `main`, branch names, dates and words such as "latest" are moving references. The root `package.json` version describes the current compatibility/release line and does not by itself mean a GitHub Release exists. Keep its `package-lock.json` and `release-template` copies synchronized.

The YunusPi core has its own version lineage, starting at `0.1.0`, recorded in the owned workspace package manifests and `core/identity.json`. Its historical origin is Pi `0.85.1`; that attribution is immutable and is not an upgrade target. The product version, owned-core versions and source Git SHA describe different identities. Core changes are reviewed as YunusPi source changes and tested against the maintained harness. Upstream versions never update the lockfile, installed runtime or notifications automatically. See [manual upstream porting](../UPSTREAM-PORTING.md).

Public export must preserve the reviewed `core/` source, root workspace metadata and build script from the YunusPi repository. These cannot be reconstructed from a private installation's upstream packages. Never publish an agent-only export as a complete release.

Normal publication to `main` does not create a formal release. When a release is intentionally cut, update the root package version and lockfile plus their synchronized `release-template` copies in the same reviewed change, place an immutable `vMAJOR.MINOR.PATCH` tag on the exact tested commit, and create the matching GitHub Release with release notes. Never move an existing release tag to different source bytes. Commits after a release remain development revisions until another release is deliberately cut.

Use Semantic Versioning according to intended public behavior, not commit count or calendar age: patch for compatible fixes, documentation/test corrections and internal reliability work with no intentional public-contract change; minor for new user-visible capabilities or meaningful behavior/compatibility changes while the project remains pre-1.0; major only when an explicitly stabilized public contract later receives an incompatible change. Feature branches, PR numbers, CI run numbers, private installation state and generated capability counts are not versions. Mutable counts should remain code-owned rather than copied into prose.

## Version consistency and tagged releases

Run `node scripts/version-release.mjs X.Y.Z --write` to update the product, six owned packages, owned workspace dependency versions, lockfile and template metadata together. Without `--write`, the command checks consistency and fails on drift. It never changes the historical upstream attribution or third-party dependency versions.

The public safety workflow tests both ordinary pushes and version tags. On a `vX.Y.Z` tag, its separate release job receives contents-write permission only after the safety job succeeds. It checks the tag against the package version and publishes the corresponding changelog section for that exact commit. Existing release notes must match on rerun; the job does not move tags or rewrite releases. Push the tested commit to `main`, wait for CI, then push its annotated tag.

## Export changes

Use a fresh staging directory:

```sh
node /path/to/live-agent/scripts/harness-public-export.mjs \
  --source /path/to/live-agent \
  --templates /path/to/yunuspi/release-template \
  --output /tmp/yunuspi-next-release
node /tmp/yunuspi-next-release/scripts/check-public.mjs /tmp/yunuspi-next-release
```

The exporter also checks final bytes against exact credentials read locally, without printing them. An unreadable private configuration blocks the export. The public scanner uses high-confidence patterns, runtime path restrictions and tightly fingerprinted binary exceptions; it cannot determine every organization's confidential prose. Review the generated diff, especially new skills, provider endpoints, deployment examples, logs and screenshots.

Copy only the reviewed public changes into your public checkout. Never copy the live agent folder wholesale. Run distribution tests in a separate throwaway copy of the sanitized export, so installed test dependencies stay outside the clean release tree:

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefer-offline
npm run build:core
PI_PUBLIC_TEST_CONCURRENCY=4 TMPDIR=/var/tmp npm test
```

The suite runs one file at a time by default (`PI_PUBLIC_TEST_CONCURRENCY` raises it). Point the tests' temp root at a low-entry directory: the guarded-command wrapper keeps protected roots read-only by re-binding every existing sibling of each ancestor writable, so fixtures created under a busy `/tmp` produce thousands of bubblewrap arguments per sandboxed spawn (seconds each), while a root with few entries produces roughly a hundred (under a second).

In the clean public checkout containing the same tested source bytes, stage explicit public paths and scan again. The scanner intentionally rejects installed dependency trees and examines the Git index and all reachable commit content, so deleting a secret later does not make its history safe.

```sh
npm run prepare:hooks
npm run check:public
git diff --cached --stat
```

The pre-push hook blocks detected leaks before upload. Hooks must be enabled in each checkout and can be bypassed; CI runs the same checks after pushes/PRs but cannot retract already disclosed content. Enable GitHub secret scanning/push protection and protected-branch checks where your account supports them. Never use bypass flags to silence a real finding. Remediate the staged release, rerun the checks, and rotate credentials if they ever reached a remote.

Do not commit a personal denylist containing actual secrets. Exact local credential comparison belongs in the private exporter process. Update the clean release templates when improving installation/docs/checks so subsequent exports preserve the safeguards.

## Automated publication

`node /path/to/live-agent/scripts/publish-public.mjs --checkout /path/to/public-checkout --message "Describe the verified change"` exports to a fresh directory, installs dependencies with lifecycle scripts disabled, builds the owned core, and verifies distribution tests in a separate temporary copy before checking public content and publishing the resulting commit. The distribution run uses bounded file parallelism (`--test-concurrency N`, default is cores minus two capped at six, override with `PI_PUBLISH_TEST_CONCURRENCY`) and a low-entry temp root, and prints a `[publish] timings` line for each phase. Use `--dry-run` first to inspect differing paths; it performs no checkout writes or upload. Use `--verify-only` to export and test without changing the checkout, index or remote. Review the sanitized diff before publication. Live paths, ancestor overlaps and symlink aliases are rejected. The checkout must be clean unless its existing changes were explicitly reviewed with `--allow-dirty`.

Publication refuses checkout-only paths that are absent from the sanitized export.
Review and remove obsolete published paths explicitly before retrying; the command
does not silently retain excluded files or delete arbitrary checkout content.

For normal maintenance, run the relevant focused checks, review a fresh export
diff with `--dry-run`, then publish once. Publication includes isolated
distribution validation. `--verify-only` is for validation without publication;
it is not a prerequisite that must repeat the same tests immediately before
publishing unchanged source. In a public checkout, run focused tests with
`node --test tests/<name>.test.mjs`. Private installations that include the
curated `scripts/test-harness.mjs` also support `--match <literal-path-text>
--list` to find suites without launching them; removing `--list` runs that
selection. The private runner and historical benches are not exported. Follow
component imports when choosing integration coverage: name matching alone
cannot establish affected behavior.
