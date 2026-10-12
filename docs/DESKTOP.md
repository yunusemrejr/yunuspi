# YunusPi desktop

YunusPi now opens an Electron workspace. The rat, conversation and composer stay central; tool output and diagnostics expand when needed. Linux is the supported desktop target. The renderer follows the system’s light or dark appearance and reduced-motion preference.

After [installation](INSTALL.md), open **YunusPi** from the Linux application launcher, or run `yunuspi` in a terminal. `yunuspi --gui` explicitly opens the desktop. A positional prompt in an interactive terminal opens as a draft. Automation continues to use `yunuspi --print "task"` or `yunuspi --mode rpc`; neither needs a graphical session.

For development in the public checkout:

```sh
npm ci --ignore-scripts
npm run build:core
npm run setup:desktop
npm start
```

The explicit setup downloads the exact Electron version in the lockfile and verifies its upstream distribution checksum. npm lifecycle scripts remain disabled. Offline installation reuses the matching Electron distribution already installed in the source checkout. Never add `--no-sandbox` to a normal launcher.

## Projects and sessions

Open a project folder, then use **New session** or the plus beside its name. Multiple sessions can run in the same project or in different projects. Each conversation gets its own core worker, model selection, thinking level, draft and transcript. Switching sessions keeps running turns alive. Browsing saved conversations reads the existing session transcript without starting a worker. Model controls and submitted work start the harness only when needed. Workers that have accepted a task or restored a transcript stay resident until explicitly closed, because jobs or schedules may continue beyond a model turn. Only explicitly closing a session stops its worker. This also protects project schedules that may arm during startup. Up to eight resident workers are supported.

The session menu supports rename, close, archive, export and delete. Close stops the worker and retains the conversation. Archive also removes it from the usual list; the Archive view restores it. Delete requires confirmation and removes that desktop transcript and draft. Shared project memory and project files remain. Imported terminal sessions are copied under a new desktop identity; their original files are retained.

Same-project sessions use the existing canonical-checkout coordination layer. Root sessions publish a bounded, redacted initial objective, plans and recent writes. Peers receive advisory context at normal agent boundaries. Overlapping direct edits require a fresh read. These are not locks: shell tools, external editors and other writers can still race; use separate worktrees for conflicting changes. Sessions keep independent goals and never automatically merge instructions or wake idle model inference.

## Working in a conversation

Enter sends a request; Shift Enter inserts a line break. During a running turn, Enter queues a follow-up and the stop control remains available. The model and thinking controls use the existing core registry. Existing provider credentials are reused; Settings can add an API key through the locked harness credential store without exposing stored keys to the renderer.

Images can be chosen, dropped or pasted, up to six images and 10 MiB total. Tool runs show compact status rows; expand one for its bounded output or image results. Markdown code blocks and tables scroll within their own bounds. The composer stays fixed while the conversation scrolls. Reading older messages suspends automatic following; **Latest** returns to the bottom. History loads in pages with a byte budget, and larger previews point out truncation while the complete core transcript remains on disk.

The Workbench shows tool activity, the project, peer sessions, extension widgets and measured session usage. Commands and skills remain discoverable through the harness. RPC-aware extension selection, confirmation, input and editor dialogs appear as native HTML dialogs, with keyboard focus contained while open. Legacy terminal-only custom component factories are not rendered by the desktop; maintained session/subagent/background controls use their RPC alternatives.

## Data and updates

The desktop workspace lives in Electron’s user-data folder (normally `~/.config/YunusPi` on Linux). **Settings → Open workspace data** opens the actual location. `workspace.json` stores project/session metadata; `transcripts/<session-id>/` holds core JSONL. Atomic metadata commits, coalesced draft writes and recoverable deletion protect against interrupted saves. Failed saves keep the draft in memory and report the error. Quit stops workers and flushes pending drafts.

Global harness credentials, tools, skills and existing state remain in `~/.pi/agent`. Project notes and source-linked vector indexes keep their existing owners and SQLite transaction/WAL behavior. The desktop does not create a competing memory database. Rebuildable vector indexes are retrieval aids, not authoritative session history.

Quit the desktop before a state-preserving harness update. The installer rejects active desktop/core owners, backs up the prior installation, and records managed GUI source hashes alongside agent/core hashes. GUI data lives outside the runtime and survives replacement. See [publishing](PUBLISHING.md) for release identity and rollback.

## Verification

`npm run test:desktop` runs real Electron and the owned RPC core against an isolated loopback provider: simultaneous sessions, project separation, drafts, tools, dialogs, history paging, scrolling, window sizes, appearance, archive/restore, shutdown and renderer isolation. It does not spend provider credits or certify live-provider inference. Unit checks cover failed saves, crash recovery, framing, cancellation, update ownership, preview budgets and concurrent project-memory writers. Public CI verifies Linux; native Windows/macOS desktop support is not claimed.
