# yunuspi-utility-mcp

One local MCP stdio server, automatically owned by `extensions/utility-tools.ts`.
Starting a harness session prewarms the server and exposes the shared catalog as native tools. Calls reuse that process. Unexpected exits trigger up to three automatic
restarts per minute; the next call can retry after that circuit breaker. Shutdown
closes the server. A workspace switch replaces it with a process rooted in the
new workspace. There are no credentials, config files, network listeners or
manual server commands to set up.

The extension and server share `catalog.mjs`, so schemas, names and descriptions
cannot drift. Tool prompt guidelines persist in the normal harness catalog.
Existing relevant-guidance and Bash routing provide contextual reminders and
measure available substitutions and native successes. All built-in helper agents
explicitly load the extension and router and permit these read-only tools.

## Tools

| Tool | Operations |
| --- | --- |
| `sqlite_probe` | `tables`, `schema`, `describe`, `query`, `explain` |
| `package_probe` | Installed Node metadata, declaration and lock resolution |
| `openapi_probe` | `list_endpoints`, `operation`, `schema`, `request_shape`, `response_shape`, `auth` |
| `coverage_probe` | Existing artifacts, uncovered evidence and Git line intersections |
| `contract_diff` | JSON/YAML file or inline payload structural changes; schema mode |
| `env_audit` | Names referenced in explicit sources versus example/deployment configs |
| `net_probe` | `dns`, one `tcp` connection, one `tls` handshake, passive `ssh` banner |
| `workspace_search` | Literal file/folder or UTF-8 content search under an explicit root |
| `local_mail_search` / `local_mail_read` | Explicit Maildir/mbox search and exact message reading |
| `ssh_plan` | Safe explicit-target argv plan, without connecting or reading SSH config |
| `archive_probe` | `list`, `stat`, `find`, one bounded UTF-8 `read` |

## Bounds and evidence

- Files resolve inside the startup workspace, including symlink and descriptor
  checks. Only `workspace_search` traverses directories, under its explicit root;
  symlinks and dependency directories are skipped. Package lookup
  checks known manifest/lock/node_modules paths up the ancestor chain only as far
  as the workspace boundary. Git inspection is limited to explicit source files.
- MCP requests: 512 KiB; two concurrent workers; six seconds per call; 128 MiB
  worker heap; 24 KiB result text, always valid JSON. Lists use `limit`/`offset`
  where appropriate. Inspect `truncated` and `output_truncated`, then narrow the
  request. Individual strings cap at 2,048 characters.
- JSON/YAML inputs: 16 MiB per file and 32 MiB per call, capped aliases and schema
  reference depth. External references are reported, never fetched. No package
  scripts or module code run. Yarn PnP execution is unsupported. npm v1/v2/v3,
  pnpm and Yarn classic/Berry lock data are inspected; ambiguous matches are
  labeled instead of presented as exact resolutions.
- SQLite uses a private temporary snapshot of the DB and WAL, with source change
  checks. This avoids creating or writing a workspace WAL shared-memory file.
  Snapshot bytes cap at 256 MiB. Nonempty rollback journals require a retry after
  the writer completes. SQLite opens `mode=ro`, sets `query_only` and disables
  trusted schemas/extensions. An authorizer denies writes, ATTACH and functions
  outside the safe allowlist. Query execution has a three-second progress limit,
  200-row cap and bounded cells. The Python executor also has a five-second alarm
  and a 512 MiB address-space cap. Concurrent writes can require a retry.
- ZIP/TAR archives cap at 256 MiB compressed, 512 MiB declared expanded data,
  20,000 entries and a five-second executor deadline. Text reads cap at 16 KiB
  before the normal result-string cap. Traversal names, links, special files,
  duplicate names, encrypted members and binary text reads cannot be read. Files
  are never extracted. Large archives/decompression work can return a limit error.
- Coverage reads LCOV, Istanbul `coverage-final.json` and Cobertura XML; it never
  runs tests. Changed modes are `working` (unstaged), `staged`, `all` (HEAD to
  working tree plus explicit untracked files) and `ref` (a commit to working tree).
  Deleted lines do not count as executable current lines. Missing instrumentation
  and artifact freshness remain unknown. Cobertura exposes aggregate branch
  outcomes; LCOV without function ends can intersect only function entry lines.
- Contract diffs infer shapes from samples unless `mode: "schema"` is supplied.
  They cannot infer a universal API contract from one example. Nesting moves are
  labeled inferred. Scalar values are omitted. Environment auditing is static,
  recognizes common language forms and defaults, reports unresolved dynamic
  references and never reads process environment values or follows `env_file`.
- Network results are live and never cached. Certificate validation errors stay
  visible even though the inspection handshake permits an untrusted certificate
  so its subject/SAN/issuer/expiry can be returned. No HTTP bytes are sent.
- Workspace search caps traversal at 5,000 entries, content at 16 MiB per call
  and 1 MiB per file, and matches at 1,000. Hidden paths require an explicit
  option. Skipped paths and incomplete scans are reported; no match is not proof
  of absence outside that scope. Continuation requires the prior `snapshot`;
  changed directory metadata or scanned bytes reject stale pages.
- Local mail uses an explicit workspace-contained Maildir (`cur`/`new`) or mbox.
  It never discovers credentials or accounts. The existing AgentMail tools own
  hosted inbox access. MIME/charset decoding uses Python's standard library;
  attachments are omitted, HTML becomes inert text, and malformed/lossy decoding
  stays visible. Search caps are 1,000 messages, 16 MiB total, 1 MiB per message
  and 65,536 decoded body characters. `local_mail_read` requires the exact
  `message_hash`, rejecting stale results, and returns 1,600-character pages.
- SSH banner checks send no application bytes, cap received data at 4 KiB and
  close after 3.5 seconds. A banner does not verify the host key or authenticate.
  `ssh_plan` returns argv only, bypassing SSH configuration, proxies, local
  commands, forwarding and interactive authentication. Host-key checking remains
  strict; normal authorized shell execution owns any later connection.
- File-backed results include `input_hash` derived from exact source bytes and
  arguments; SQLite includes DB/WAL snapshot hashes and coverage includes Git
  diff evidence. No result cache retains user data; hashes support caller caching
  only after inputs are revalidated. Network results and SQLite queries using
  clock-capable date/time functions explicitly disable caching.

## Runtime and verification

Uses the harness's installed Node.js (22.19+), pinned `yaml` and `linkedom`
dependencies, and Linux Python 3.11+ standard library (`sqlite3`, `zipfile`,
`tarfile`, `resource`). No new package install, daemon, MCP SDK or PyYAML dependency
is needed. Python processes are short-lived inspection executors, not additional
MCP servers. Parsing runs in disposable workers so a malformed file cannot stall
the MCP protocol owner. Temp snapshots are cleaned up by the executor.

Run `node --test --test-concurrency=1 agent/public-template/tests/utility-mcp.test.mjs`
in the private tree, or `node --test tests/utility-mcp.test.mjs` in a public export.
Fixtures are temporary and include real SQLite/WAL, Git, ZIP/TAR and localhost
TCP/TLS cases. `tests/operation-tools.test.mjs` covers actual MCP/native discovery,
Maildir/mbox, stale pages, MIME encodings, path boundaries, SSH banners and cancellation. DNS record formatting has a deterministic resolver fixture.

Protocol framing follows the [MCP stdio specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
SQLite enforcement uses its [authorizer and progress APIs](https://docs.python.org/3/library/sqlite3.html).
