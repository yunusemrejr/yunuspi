# File organization

`fs_organize` sorts, renames and cleans up a folder of files so that a model of any strength can do it without writing `mv` loops. A loop replaces same-named files silently, removes "duplicates" it should have kept, stops halfway without a record, and ends with "done" and no count. The tool makes the careful path the short one.

## Order of work

| Action | What it does |
| --- | --- |
| `scan` | Inventory: file types and sizes, identical files, names that need cleaning, the largest files, and what will be left alone and why. |
| `plan` | A reviewable list of moves. Nothing is touched. Returns a `planId`, the folders that would be created with example names, collisions that were renamed, and duplicates. |
| `apply` | Performs a plan, journals every move, verifies, and returns the result. |
| `verify` | Every moved file is present and nothing is left at its old path; the file count before and now is compared. |
| `undo` | Puts every file back from the journal, also in a later session, and removes the folders the plan created if they are empty. |
| `plans` | Lists recent plans with their status. |

## Plan modes

`by: "type"` (Documents, Spreadsheets, Presentations, Images, Videos, Audio, Archives, Code, Data, Installers, Fonts, Other), `"extension"`, `"date"` with `date: "year"` or `"month"`, `"tidy-names"` with `style: "keep" | "kebab" | "snake"`, `"rules"` and `"moves"`.

Rules are ordered conditions, first match wins, unmatched files stay: `{ext, nameContains, glob, regex, olderThanDays, largerThanMB, to}`. `to` may use `{year}`, `{month}`, `{day}`, `{ext}` and `{type}`, for example `Photos/{year}-{month}`.

Moves are an exact `[{from, to}]` list for decisions that need the contents of the files, such as which invoice belongs to which vendor. A `to` ending in `/` keeps the file name. The whole list is validated before anything is planned (missing files, paths that leave the folder, links, duplicates in the list), and a bad entry rejects the plan with the reason.

Options: `recursive` (include subfolders; they are flattened into the new folders, except files already inside a matching folder), `into` (put the new folders below a subfolder), `duplicates` (`report` only, or `separate` to gather the later copies in `Duplicates/`, never deleting them), `includeHidden`, `maxFiles` (default 3000).

## Safety

- Nothing is overwritten. A move links the file to its new name (which fails if the name is taken) and then removes the old name; a clash becomes `name (2).ext`, including a name that appeared after the plan was made.
- Nothing is deleted. Duplicates are identified by size and SHA-256 and only moved.
- A file that changed or vanished after the plan is skipped and reported, not moved blindly. A plan older than a day must be made again.
- Only regular files move. Symlinks, hidden files, unfinished downloads (`.crdownload`, `.part`, `.tmp`, office lock files), `Thumbs.db` and `desktop.ini` are skipped; folders are never moved or removed; recursive runs skip software projects, application bundles and `node_modules`. A folder that is a symbolic link is never written through.
- Refused outright: a filesystem root or top-level folder, the home folder itself or any folder that contains it, system folders, hidden configuration folders in the home folder, anything inside `node_modules`, and folders that look like software projects (a `.git` directory, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and similar) unless `allowProject: true`.
- `apply` and `undo` ask the harness mutation policy about every folder they touch, so the session's writable scope applies exactly as it does to `write` and `edit`; headless sessions cannot widen it. The harness maintenance protection applies too.
- Interrupted work is journaled: a partial plan can be applied again and picks up the remaining moves.

## Where it lives

`agent/extensions/fs-organize.ts` registers the tool and the preflight. `lib/fs-organize.ts` is the engine (walk, plan, apply, verify, undo and the journal). Journals are kept in `~/.pi/agent/organize/` (or `PI_ORGANIZE_DIR`) for 90 days. The `file-organization` skill routes requests to it. Tests: `tests/fs-organize.test.mjs`.
