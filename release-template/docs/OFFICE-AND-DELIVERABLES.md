# Office documents and deliverable checks

Two tools and one tracker, built so that a model of any strength can read, produce and verify the files people actually ask for, without writing OOXML by hand and without taking "the script printed Saved report.docx" for evidence.

## `office_doc`

| Action | What it does |
| --- | --- |
| `read` | Structured content of `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`: headings, tables, sheet cells with formulas and cached results, slide text and notes, document properties, plus findings. Bounded output; `sheet` and `maxChars` select more. |
| `verify` | Findings only, with a pass, warn or fail status. |
| `build` | Writes a `.docx` or `.xlsx` from a declarative spec, re-reads it and returns its verification. Inside the workspace only; an existing file needs `overwrite:true`. |
| `render` | LibreOffice to PDF plus PNG pages (default 3) so layout can be looked at. Needs LibreOffice; nothing else depends on it. |

The reader works from the package bytes (ZIP, then XML): no office suite, no Python library. It reports damaged or truncated packages, malformed parts with line and column, broken relationships, an extension that does not match the content, unreplaced `{{placeholders}}` and `[insert date]` markers, blank-line spacing, skipped heading levels, font sprawl and tiny type, review comments and tracked changes left in a deliverable, formulas that were never calculated (viewers, pandas and previews show empty cells), formulas that evaluate to errors, numbers stored as text, text clipped by narrow columns, empty sheets, empty slides, empty placeholders, dense slides and duplicate slide titles. It makes no claim about how an application will paginate; `render` is the check for that.

### Building

A document spec lists blocks: `heading` (levels 1 to 3), `paragraph` (inline `**bold**`, `*italic*`, `` `code` `` and `[text](https://…)`, or explicit `runs`), `bullets` and `numbered` (nested with `level`, numbering restarts per list), `table` (header row repeats across pages, numeric columns right-aligned, `grid`, `plain` or `banded`, optional caption), `image` (PNG or JPEG, scaled to the page, alt text and caption), `quote`, `code` and `pagebreak`. Page size, orientation and margins, font family and size, an accent colour for headings, a header and a footer with `{page}` and `{pages}` are set once. Styles are real Word styles, so navigation, accessibility and later edits keep working.

A workbook spec lists sheets with `columns` (header, width, format: `text`, `integer`, `decimal`, `currency`, `percent`, `date`, `datetime`) and `rows`. A string beginning with `=` is a formula and is calculated and stored (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `ROUND`, `ABS`, `IF`, `IFERROR`, `AND`, `OR`, `NOT`, `CONCAT`, `LEN`, arithmetic, comparison, `&`, percent literals and references across sheets); a formula that errors, such as `=B2/B9` with an empty `B9`, is reported while building. Anything the calculator does not cover is left to the application, which recalculates on open. Numeric-looking text in a numeric column becomes a number, ISO dates in a date column become real dates, `totals` adds a bold sum row, the header row is bold with a rule, panes freeze and filters apply on larger tables, and column widths fit their content.

The same spec always builds the same bytes.

## `deliverable_check`

Opens any file and returns a status with findings and a fix hint for each: Office documents through the reader above, PDFs (HTML saved as `.pdf`, truncation, page count, extractable text), images (truncation, dimensions, a JPEG named `.png`), SVG, video and audio through ffprobe and a bounded ffmpeg decode (non-`yuv420p` video that many players reject, silent audio, clipping, a missing video stream, audio and video of different length, metadata at the end of an MP4), CSV (ragged rows, duplicate or empty headers), JSON, YAML and TOML (syntax with position), HTML and Markdown (broken local references, unclosed fences), archives (integrity, leftovers such as `.git` and `__MACOSX`). Structure and measurable defects only: it says so, and points at the tools that look at pixels and listen to sound.

## Reading binary files

The native `read` tool decodes every non-image file as UTF-8, so a PDF, Word or Excel file, archive, database or media file used to arrive as tens of kilobytes of replacement characters (a 69 KB quotation PDF came back as 37,641 characters, 6,508 of them U+FFFD). When a read result looks like binary decoding, the first bytes of the file are checked and the result is replaced with what the file contains:

| Kind | What the read returns |
| --- | --- |
| PDF | Text by page with `--- page n ---` markers, 25 pages at a time. `offset` is the page to start from, and the footer says `Use offset=26 to continue`. A PDF without a text layer says it is scanned and how to render its pages; an encrypted or damaged PDF says so. Needs poppler (`pdftotext`, `pdfinfo`). |
| Office (docx, xlsx, pptx, odt, ods, odp) | The same structured text as `office_doc read`, bounded, with the errors found while opening it. |
| ZIP | Entry names and sizes, `archive_probe` for members, and the reminder to extract into a new folder. |
| SQLite | The schema (read-only `sqlite3`) and `sqlite_probe` for queries. |
| Audio and video | Container, duration and streams from `ffprobe`, and which tool looks at it. |
| Anything else | What it is, the first bytes in hex, and the shell command that inspects it. |

Text files are never touched: UTF-16 and UTF-8 files with a byte-order mark, and text with a stray replacement character, are read as before. A file the native tool could read as text, an image, and every other tool are unaffected. A document opened this way counts as opened for the tracker below. `PI_BINARY_READ=off` restores the raw read.

## The tracker

A script that ends in "Saved report.docx" proves nothing about the file. When a bash command writes a final-product file (documents, PDFs, video, audio) that the command named or that sits in the working directory or a conventional output folder (`out`, `dist`, `reports`, …), the file is recorded. Test fixtures, dependency and build trees, scratch folders, lock files and files outside the workspace never count. At the end of a turn, if recorded files were never opened, the answer footer lists them once, and the harness wakes the model with one instruction: call `deliverable_check`. That happens at most twice per distinct set of files, never while other work will resume the session, never for a stopped session, and never in child agents. `office_doc` and `deliverable_check` calls close the record for the bytes they saw; a file rewritten afterwards opens again.

`PI_DELIVERABLES=off` disables the tracker and the follow-ups; the tools stay available.

## Where it lives

`agent/extensions/deliverables.ts` registers both tools and the tracker. `lib/office-zip.ts` and `lib/xml-lite.ts` are the bounded container layer, `lib/office-read.ts` the readers and findings, `lib/office-build.ts` and `lib/sheet-formula.ts` the writers and calculator, `lib/office-render.ts` the optional LibreOffice step (a snap-packaged LibreOffice can only read below the home folder, so inputs are staged there and removed), `lib/deliverable-inspect.ts` the other inspectors, `lib/deliverable-ledger.ts` the tracking rules and `lib/binary-read.ts` the readable view of binary files for `read`. Tests: `tests/office-files.test.mjs`, `tests/deliverable-check.test.mjs`, `tests/binary-read.test.mjs`.
