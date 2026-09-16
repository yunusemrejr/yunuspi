# Native delegation and independent file checks

Project sessions use native children, parallel `tasks`, or sequential `chain`. The JavaScript `workflowScript` host remains limited to harness maintenance sessions. A denied workflow creates no mission or child and explains the native fallback. Native composites require `async:true`; foreground execution supports one child. If a foreground child reaches launch with its parent cancellation signal already aborted, the executor records a stopped result before context assembly and does not spawn the child, avoiding work that cannot be consumed.

Send the common requirements once, with short assignments per child:

```json
{
  "commonTask": "Preserve the existing page structure and widget behavior. Read relevant guidance before editing. Report remaining verification limits.",
  "tasks": [
    {
      "agent": "worker",
      "task": "Edit the landing page copy in index.html.",
      "acceptance": {
        "files": {
          "scope": ["index.html"],
          "unchanged": ["assets/widget.js"],
          "unchangedScripts": ["index.html"]
        }
      }
    },
    {
      "agent": "worker",
      "task": "Edit only the catalog labels in catalog.html.",
      "acceptance": { "files": { "scope": ["catalog.html"] } }
    }
  ],
  "async": true
}
```

`commonTask` is a nonempty string of at most 48,000 characters. It is expanded once into each native child task, including chain and nested parallel steps. A chain step without a task still receives its preceding output. This reduces repeated text in the parent's tool request; every child still receives the brief, so it does not remove those child input tokens. It does not apply to workflow scripts or management actions.

`acceptance.files` declares exact cwd-relative paths. No filenames or preservation requirements are inferred from task prose or a worker's report. The combined contract accepts up to 32 paths, at most 1 MiB per file and 8 MiB per check. Files must be regular files; symlink paths, invalid UTF-8 HTML, unreadable files and missing required baselines produce explicit failures. No file contents are retained in the baseline, only hashes and bounded structural facts.

- `scope`: require each named file to exist after work. For HTML and static PHP source, preserve the pre-existing H1 count and reject increased orphan/unclosed counts for definite container tags. A fragment with no H1 is allowed. Existing balance defects are compared with the baseline rather than blamed on the new work. Successful native `write`/`edit` tool calls outside this scope reject completion.
- `unchanged`: require whole-file bytes to match the pre-launch baseline.
- `unchangedScripts`: require every script block in each named HTML/PHP file, including attributes and inline body bytes, to match the pre-launch baseline.

These independent checks run before native foreground or background completion is accepted. A failing contract changes an otherwise successful worker run to failure even if its prose claims success. The failure remains in the acceptance ledger and completion diagnostics. A mutation task without this contract reports that independent file checks were not requested; worker claims remain unverified. Child structured output is preserved exactly; coverage information is added to delivery metadata/text.

The checks are deliberately bounded. They do not establish full HTML validity, rendered PHP/JavaScript output, accessibility, visual quality or functional correctness. Container counts do not validate DOM nesting. Direct native writes can be attributed to their child tool receipts; shell writes and other concurrent processes cannot. Keep one writer per file and use separate worktrees when changes overlap. A changed protected file fails its contract, but that alone does not prove which process changed it. The checker never executes commands claimed by a worker; separately configured parent verification commands retain their existing policy.