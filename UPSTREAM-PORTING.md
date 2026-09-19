# Manually porting upstream changes

Upstream Pi is historical origin and an optional reference. YunusPi does not follow its version numbers, releases, release APIs, package tags, or update commands. A new upstream release requires no action and cannot change an installation.

A maintainer may deliberately review a specific upstream commit. Record the source commit, license, concrete defect or capability, affected contracts, and reason the selected change belongs in YunusPi. Port that individual change into `core/*/src` (or reimplement it against the owned contracts); never replace the core with a newer npm package or add an automatic merge/bump job.

Preserve upstream notices and attribution. Update declarations alongside exported API changes. Add a regression reproducing the defect and run the owned core build, fork-independence tests, affected harness tests, full distribution checks, and public scanner. Independent quality review should cover permissions, raw evidence, provider history/cache stability, and installation behavior where affected.

The resulting implementation belongs to a YunusPi commit and release. Advance the YunusPi core version when appropriate; keep `forkOrigin` unchanged. Record port provenance in the commit or release notes. Release via the YunusPi source/repository authority only, with a rollback copy and an offline verification path.

There is intentionally no “latest compatible Pi” command, upstream release watcher, auto-import workflow, or patch-after-install process.
