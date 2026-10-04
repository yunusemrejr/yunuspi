---
name: file-organization
description: "Organize, sort, rename and clean up files and folders safely: inventory first, plan before moving, never overwrite or delete, keep a journal for undo and verify the result; use for downloads, photos, scans, invoices and any messy folder."
---

# File organization

Harness tool: `fs_organize` does the whole job in a fixed order, and every step is checked. Use it instead of `mv`, `cp`, `rm` or `find -exec` loops, which replace same-named files silently, cannot be undone and leave no record of what moved.

1. `scan {path}`: what is in the folder. Types and sizes, identical files, names that need cleaning, and what will be left alone (hidden files, links, project folders, unfinished downloads).
2. `plan {path, by}`: a list of moves; nothing is touched. Pick the mode from the folder and the request:
   - `type`: mixed downloads and desktops (Documents, Images, Videos, Audio, Archives, Spreadsheets, Presentations, Code, Data, Installers, Fonts, Other).
   - `date` (`date:"year"` or `"month"`): photos, scans, screenshots, exports; the file's modified date names the folder.
   - `extension`: one folder per file extension.
   - `tidy-names` (`style:"kebab"`, `"snake"` or `"keep"`): fix spaces, illegal characters and upper-case extensions without moving anything.
   - `rules`: the user's own scheme, as ordered conditions (`ext`, `nameContains`, `glob`, `regex`, `olderThanDays`, `largerThanMB`) with a `to` folder that may use `{year}` `{month}` `{day}` `{ext}` `{type}`. The first matching rule wins and unmatched files stay.
   - `moves`: an exact list `[{from, to}]` for decisions that need the file contents (which invoice belongs to which vendor, which photo is from which trip). Read the files first (`office_doc read`, `pdftotext`, `image_analyze`), write the list, and let the tool carry out the moves safely. A `to` ending in `/` keeps the file name.
3. Read the plan summary. If a folder looks wrong, plan again with a different mode or rules; plans are free. `recursive:true` flattens subfolders, so use it only when the user wants that. `duplicates:"separate"` gathers identical copies in `Duplicates/`; never delete them, the user decides.
4. `apply {planId}`: the moves happen with no overwrite (a clash becomes `name (2).ext`), every move is journaled, and the result already contains the verification.
5. Report from the result: how many files moved, into which folders, what was skipped and why, and that `undo {planId}` reverses it. If verification shows missing files or a changed count that the result does not explain, say so and `undo` instead of claiming success.

Boundaries the tool enforces and you should not argue with: the home folder itself, system folders, hidden configuration folders and software projects are refused; links, hidden files and unfinished downloads are skipped; only files move, never folders. If a request truly needs more (deleting, merging folders, moving whole directories), do that step by hand with a narrow command after the sort, list what it will touch first, and ask before anything irreversible.

When the user names a folder loosely ("my Downloads"), resolve it with `ls` or `find` before planning; do not guess a path. When the request is large and ambiguous ("clean up my computer"), start with `scan` on one folder, finish it, and offer the next rather than touching everything at once.
