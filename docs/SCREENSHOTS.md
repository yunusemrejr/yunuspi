# Screenshot provenance

These images were generated specifically for this public repository from synthetic fixtures on 2026-09-13. They contain no personal sessions, accounts, credentials, private project paths or production data.

| Asset | Source |
| --- | --- |
| `metrics-demo.png` | Native `buildSessionReport` and `createMetricsPanel` output, rendered as terminal text in Chromium. Synthetic rate-limit failures, one timed-out child, and repeated source-inspection results. The image labels itself as a demonstration. |
| `graph-demo.png` | The actual local project-intelligence browser viewer, seeded with a synthetic storefront dependency graph. |

The capture implementation is [scripts/capture-demos.mjs](../scripts/capture-demos.mjs). It uses an installed harness with Playwright and Chromium, creates a temporary graph database, captures the views, and stops the demo server. It never opens a live session or project store.

From the repository root, run `node scripts/capture-demos.mjs /tmp/yunuspi-screenshots`. Set `PI_DEMO_AGENT_DIR` only when the installed harness lives outside its default location. Regeneration can change layout bytes or timestamps: inspect the images and update both root and release-template asset copies and their exact SHA-256 allowlist entries only after reviewing the new files. Existing public safety checks reject any unreviewed binary.

Screenshots illustrate interface behavior and do not establish model quality, inference availability, or production task success. Custom fixture content and captures are covered by the repository's MIT license; the viewer retains its bundled third-party notices.
