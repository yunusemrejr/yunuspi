# Public release boundary

Never initialize Git in the live `~/.pi` directory. Never publish a private backup ZIP or session HTML/JSON export: restore backups contain credentials; session exports can contain personal prose.

The public exporter reads only reusable extensions, skills, runtime scripts and dependency manifests. It excludes live settings/authentication, provider caches, histories, memories, logs, sessions, experiments, private benchmark fixtures, backups, node_modules, model weights and environments. It substitutes the source fallback credential with an environment lookup and normalizes personal home-path examples. The working local installation is not modified.

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
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

In the clean public checkout containing the same tested source bytes, stage explicit public paths and scan again. The scanner intentionally rejects installed dependency trees and examines the Git index and all reachable commit content, so deleting a secret later does not make its history safe.

```sh
npm run prepare:hooks
npm run check:public
git diff --cached --stat
```

The pre-push hook blocks detected leaks before upload. Hooks must be enabled in each checkout and can be bypassed; CI runs the same checks after pushes/PRs but cannot retract already disclosed content. Enable GitHub secret scanning/push protection and protected-branch checks where your account supports them. Never use bypass flags to silence a real finding. Remediate the staged release, rerun the checks, and rotate credentials if they ever reached a remote.

Do not commit a personal denylist containing actual secrets. Exact local credential comparison belongs in the private exporter process. Update the clean release templates when improving installation/docs/checks so subsequent exports preserve the safeguards.

## Automated publication

`node /path/to/live-agent/scripts/publish-public.mjs --checkout /path/to/public-checkout --message "Describe the verified change"` exports to a fresh directory, verifies distribution tests in a separate temporary copy (`npm ci --ignore-scripts`), checks public content and publishes the resulting commit. Use `--dry-run` first to inspect differing paths; it performs no checkout writes or upload. Use `--verify-only` to export and test without changing the checkout, index or remote. Review the sanitized diff before publication. Live paths, ancestor overlaps and symlink aliases are rejected. The checkout must be clean unless its existing changes were explicitly reviewed with `--allow-dirty`.

Publication refuses checkout-only paths that are absent from the sanitized export.
Review and remove obsolete published paths explicitly before retrying; the command
does not silently retain excluded files or delete arbitrary checkout content.
