---
name: github-actions-workflows
description: Write, review or harden GitHub Actions workflows — triggers, matrix and caching, least-privilege permissions, pinned actions, concurrency, secrets vs OIDC, required status checks and CI failure triage. Use when authoring or fixing CI/CD pipelines or workflow YAML; not for local build debugging, generic shell scripts or git history work.
---

# GitHub Actions workflows

CI exists to answer one question cheaply: does this commit work? Build the pipeline from the checks a developer already runs locally, and keep every workflow readable enough that a failure points at the cause.

## Start from the checks

List the commands that must pass (format, lint, typecheck, unit, integration, build) and run them in a fresh checkout yourself. CI should invoke the same commands with pinned tool versions, not a parallel implementation of the test suite. If a job needs credentials, a database or network access, say so in the job name so a failure is not misread as a code defect.

## Permissions and supply chain

- Default to `permissions: contents: read` at workflow level; grant `id-token: write`, `pull-requests: write`, `packages: write` etc. only on the job that needs them.
- Pin third-party actions to a full commit SHA with the version in a trailing comment (`uses: org/action@<sha> # v4.2.0`); first-party `actions/*` may use a major tag. Let Dependabot update the pins.
- Never use `pull_request_target` with a checkout of the contributor's head — that combination runs untrusted code with a privileged token and repository secrets. Prefer `pull_request`, and require approval for first-time contributors.
- Treat `${{ github.event.* }}` values as untrusted input: pass them through `env:` and quote them in shell, never interpolate them directly into `run:` commands.

## Triggers, caching and cost

- `on: pull_request` plus `on: push` to the default branch; add `paths`/`paths-ignore` so unrelated changes do not queue the full suite, and `workflow_dispatch` for manual runs.
- `concurrency: {group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true}` for PR runs; never cancel release or deploy jobs mid-flight.
- Cache on lockfile hash + OS + runtime version; use `npm ci`, `pnpm install --frozen-lockfile`, `poetry sync` or equivalent so the cache cannot silently change the dependency graph. Never cache credentials, `~/.npmrc` tokens or build outputs that embed secrets.
- Use a matrix for the runtime/OS combinations actually supported, set `fail-fast` deliberately, and add `timeout-minutes` so a hung job cannot burn the runner budget.

## Secrets and deployment

- Repository/organization/environment secrets only; never echo them, never write them into artifacts, never pass them to fork builds (they are not available there — design the pipeline accordingly).
- Prefer short-lived OIDC credentials (`azure/login`, `aws-actions/configure-aws-credentials` with `role-to-assume`) over long-lived cloud keys stored as secrets.
- Gate deployments with environments and required reviewers; keep `GITHUB_TOKEN` permissions minimal and use environments for production approval rather than a hand-rolled check.
- Write step outputs to `$GITHUB_OUTPUT`/`$GITHUB_ENV`, not deprecated `set-output`; upload artifacts with an explicit `retention-days`.

## Required checks and job naming

Branch protection matches jobs by their check name, so a rename silently un-requires the check. Prefer one aggregating job (`ci`) with `needs:` over five required jobs, keep names stable, and confirm the required list after any matrix or rename change.

## Debugging failures

- `gh run view <id> --log-failed`, then read the first failure in the step, not the last warning. `gh run rerun <id> --failed` saves a full re-run.
- Re-run with `ACTIONS_STEP_DEBUG=true` (repository secret) for runner-level detail, and reproduce the failing command locally in the same image when possible.
- Separate infrastructure failures (runner image change, cache miss, rate limit, transient registry 5xx) from code failures before changing any code.
- Never hide a gate with `continue-on-error`, `|| true` or an `if: always()` that turns a failed check green. If a check must be advisory, name it so.

Read [workflow patterns](references/workflow-patterns.md) for CI skeletons, a release-with-provenance workflow, an OIDC deploy job, the security hardening checklist and common failure signatures.
