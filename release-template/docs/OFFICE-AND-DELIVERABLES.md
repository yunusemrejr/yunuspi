# Office documents and deliverable checks

Two tools and one tracker, built so that a model of any strength can read, produce and verify the files people actually ask for, without writing OOXML by hand and without taking "the script printed Saved report.docx" for evidence.

## `office_doc`

| Action | What it does |
| --- | --- |
| `read` | Structured content of `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`: headings, tables, sheet cells with formulas and cached results, slide text and notes, document properties, plus findings. Bounded output; `sheet` and `maxChars` select more. |
| `verify` | Findings only, with a pass, warn or fail status. |
| `build` | Writes a `.docx`, `.xlsx` or `.pptx` from a declarative spec, re-reads it and returns its verification. Inside the workspace only; an existing file needs `overwrite:true`. |
| `convert` | LibreOffice converts any Office, OpenDocument or RTF file (including legacy `.doc`, `.xls`, `.ppt`) to `docx`, `xlsx`, `pptx`, `pdf`, `odt`, `ods`, `odp`, `doc`, `xls`, `ppt`, `rtf`, `txt`, `html` or `csv` (one file per sheet for a workbook). `to` is required, `outPath` is optional (inside the workspace; default is next to the source with the new extension), an existing file needs `overwrite:true`, the source is never touched, and every written file is checked like `deliverable_check` would. Replaces `libreoffice --headless --convert-to` in bash, which the sandbox blocks. |
| `render` | LibreOffice to PDF plus PNG pages (default 3) so layout can be looked at. `pdfPath` also saves the PDF at a chosen path inside the workspace (an existing file needs `overwrite:true`) and checks it, and `pages:0` skips the page images, so a docx, xlsx, pptx, odt, ods or odp becomes a checked PDF in one call. Needs LibreOffice; nothing else depends on it. |

The reader works from the package bytes (ZIP, then XML): no office suite, no Python library. It reports damaged or truncated packages, malformed parts with line and column, broken relationships, an extension that does not match the content, unreplaced `{{placeholders}}` and `[insert date]` markers, blank-line spacing, skipped heading levels, font sprawl and tiny type, review comments and tracked changes left in a deliverable, formulas that were never calculated (viewers, pandas and previews show empty cells), formulas that call post-2007 functions without the `_xlfn.` prefix (Excel shows `#NAME?` until each cell is re-entered; a very common mistake in scripted workbooks), formulas that evaluate to errors, numbers stored as text, text clipped by narrow columns, empty sheets, empty slides, empty placeholders, dense slides and duplicate slide titles. It makes no claim about how an application will paginate; `render` is the check for that.

### Building

A deck spec lists `slides`: `{title, subtitle}` (the first slide without a body becomes the title slide), `bullets` (strings, `{text, level}` or a nested array for sub-bullets; a list whose top-level items are all typed `1.`, `2.`, `3.` or a slide with `numbered:true` gets automatic numbers that continue on follow-on slides), `columns` (two to four, each with a `heading` and `bullets`), `image` (PNG or JPEG with `alt` and `caption`, optionally beside `bullets`), `table` (`header`, `rows`, optional `widths`), `quote` (`text`, `cite`), `text` (paragraphs) and `layout:"section"`; every slide may carry `notes`. Deck-level options are `size` (`16:9` or `4:3`), `font`, `accent`, `dark` and `footer`. Nothing is positioned by the model: the layout engine measures the text, picks the largest size that fits (28 pt down to 20 for bullets), and moves what still cannot fit onto a continuation slide titled `Title (2/3)` with the table header repeated, instead of shrinking it below a readable size or letting it overflow; a slide is also kept under about 110 words, the point where the reader reports a dense slide. Titles are real title placeholders, notes are real notes slides, images carry alt text (a warning appears when it is missing), and numbering shows on every content slide. Split slides are reported in `warnings`.

A document spec lists blocks: `heading` (levels 1 to 3), `paragraph` (inline `**bold**`, `*italic*`, `` `code` `` and `[text](https://…)`, or explicit `runs`), `bullets` and `numbered` (nested with `level`, numbering restarts per list), `table` (header row repeats across pages, numeric columns right-aligned, `grid`, `plain` or `banded`, optional caption), `image` (PNG or JPEG, scaled to the page, alt text and caption), `quote`, `code` and `pagebreak`. Page size, orientation and margins, font family and size, an accent colour for headings, a header and a footer with `{page}` and `{pages}` are set once. Styles are real Word styles, so navigation, accessibility and later edits keep working.

A workbook spec lists sheets with `columns` (header, width, format: `text`, `integer`, `decimal`, `currency`, `percent`, `date`, `datetime`) and `rows`. A string beginning with `=` is a formula, and the built-in calculator evaluates it and stores the result, so previewers, pandas and mail clients show numbers instead of empty cells. Errors such as `=B2/B9` with an empty `B9` are reported while building. It covers references across sheets and whole columns (`A:A`), arithmetic, comparison, `&` and percent literals, and these functions:

| Family | Functions |
| --- | --- |
| Math and statistics | `SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN STDEV STDEV.S STDEV.P VAR VAR.S VAR.P LARGE SMALL ROUND ROUNDUP ROUNDDOWN INT MOD POWER SQRT ABS SIGN CEILING FLOOR EXP LN PI SUMPRODUCT` |
| Conditional | `SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS MAXIFS MINIFS`, with criteria such as `">=10"`, `"<>x"` and `"ab*"` |
| Logic | `IF IFS IFERROR IFNA SWITCH CHOOSE AND OR NOT ISBLANK ISNUMBER ISTEXT ISERROR`; the branch not taken is never evaluated |
| Text | `CONCAT CONCATENATE TEXTJOIN LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM SUBSTITUTE REPT FIND SEARCH EXACT VALUE TEXT` (number, percent and date formats) |
| Dates | `DATE YEAR MONTH DAY EDATE EOMONTH DAYS WEEKDAY` (1900 serial numbers) |
| Lookup | `VLOOKUP HLOOKUP INDEX MATCH XLOOKUP` |

Comparison and criteria follow Excel (text is case-insensitive, a blank equals `""` and 0, numbers sort before text). The results were checked against LibreOffice on about 190 formulas (`tests/sheet-formula.test.mjs`). Anything else, such as volatile `TODAY` and `NOW`, array formulas and user functions, is stored without a result and left to the application, which recalculates on open; the build result lists those cells. A function Excel added after 2007 (`IFS`, `XLOOKUP`, `TEXTJOIN`, `CONCAT`, `MAXIFS`, `DAYS`, `STDEV.S`, …) is written as `_xlfn.IFS(…)` as the file format requires: without the prefix Excel and LibreOffice show `#NAME?`. A formula that is just `DATE(…)`, `EDATE(…)` or `EOMONTH(…)` gets a date format, as it would when typed into Excel. Dynamic-array functions (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, …) cannot be stored reliably by a script and are reported with a suggestion to use classic formulas. Numeric-looking text in a numeric column becomes a number, ISO dates in a date column become real dates, `totals` adds a bold sum row (`true` adds up every numeric column; `{sum:"Amount"}` or `{sum:["Amount","C"]}` names columns by header or letter, and a comma-separated string works too), the header row is bold with a rule, panes freeze and filters apply on larger tables, and column widths fit their content.

The same spec always builds the same bytes.

## `deliverable_check`

Opens any file and returns a status with findings and a fix hint for each: Office documents through the reader above, PDFs (HTML saved as `.pdf`, truncation, page count, extractable text), images (truncation, dimensions, a JPEG named `.png`), SVG, video and audio through ffprobe and a bounded ffmpeg decode (non-`yuv420p` video that many players reject, silent audio, clipping, a missing video stream, audio and video of different length, metadata at the end of an MP4), CSV (ragged rows, duplicate or empty headers), JSON, YAML and TOML (syntax with position), HTML and Markdown (broken local references, unclosed fences), archives (integrity, leftovers such as `.git` and `__MACOSX`). Structure and measurable defects only: it says so, and points at the tools that look at pixels and listen to sound.

## Invented specifics

Weaker models fill gaps with plausible facts: "previously Room A", a phone number, a signature name. For a docx, pptx, odt, odp or pdf **this session produced**, `office_doc` (build, read, verify) and `deliverable_check` compare what the document states with what the session actually saw: the user's own words, tool output, compaction summaries and the input files the session referenced (CSV, JSON, text, Office, PDF; bounded). Contact data (emails, phone numbers, links), names in a greeting, signature, `From:`/`To:` line or after an honorific, and rooms, buildings and street addresses that appear nowhere give a `warn` finding (`unsupported-contact`, `unsupported-name`, `unsupported-place`); dates, times and currency amounts give a softer `info` finding (`unsupported-figure`) because computed totals and dates derived from "next Friday" are legitimate. Today's date counts as seen, a role or group ("Dear Team", "From: Facilities Department") is not a person, and a visible placeholder such as `[Your name]` is the honest answer. A document that reads back what it wrote does not become its own evidence, but what was read before an in-place edit still counts. More than ten unsupported contacts, names or places read as a data merge and become one soft note. Files the user supplied are never checked. `PI_SPECIFICS=off` disables the comparison.

## Reading binary files

The native `read` tool decodes every non-image file as UTF-8, so a PDF, Word or Excel file, archive, database or media file used to arrive as tens of kilobytes of replacement characters (a 69 KB quotation PDF came back as 37,641 characters, 6,508 of them U+FFFD). When a read result looks like binary decoding, the first bytes of the file are checked and the result is replaced with what the file contains:

| Kind | What the read returns |
| --- | --- |
| PDF | Text by page with `--- page n ---` markers, 25 pages at a time. `offset` is the page to start from, and the footer says `Use offset=26 to continue`. A PDF without a text layer says it is scanned and how to render its pages; an encrypted or damaged PDF says so. Needs poppler (`pdftotext`, `pdfinfo`). |
| Office (docx, xlsx, pptx, odt, ods, odp) | The same structured text as `office_doc read`, bounded, with the errors found while opening it. |
| Legacy Office (doc, dot, xls, xlt, ppt, pps, rtf) | Converted by LibreOffice to its modern twin in a private folder and shown as the structured text above, with a note that the original is unchanged and `office_doc convert` makes an editable copy. Without LibreOffice the read says what is needed. |
| ZIP | Entry names and sizes, `archive_probe` for members, and the reminder to extract into a new folder. |
| SQLite | The schema (read-only `sqlite3`) and `sqlite_probe` for queries. |
| Audio and video | Container, duration and streams from `ffprobe`, and which tool looks at it. |
| Anything else | What it is, the first bytes in hex, and the shell command that inspects it. |

Text files are never touched: UTF-16 and UTF-8 files with a byte-order mark, and text with a stray replacement character, are read as before. A file the native tool could read as text, an image, and every other tool are unaffected. A document opened this way counts as opened for the tracker below. `PI_BINARY_READ=off` restores the raw read.

## The tracker

A script that ends in "Saved report.docx" proves nothing about the file. When a bash command writes a final-product file (documents, PDFs, video, audio) that the command named or that sits in the working directory or a conventional output folder (`out`, `dist`, `reports`, …), the file is recorded. Test fixtures, dependency and build trees, scratch folders, lock files and files outside the workspace never count. At the end of a turn, if recorded files were never opened, the answer footer lists them once, and the harness wakes the model with one instruction: call `deliverable_check`. That happens at most twice per distinct set of files, never while other work will resume the session, never for a stopped session, and never in child agents. `office_doc` and `deliverable_check` calls close the record for the bytes they saw; a file rewritten afterwards opens again.

`PI_DELIVERABLES=off` disables the tracker and the follow-ups; the tools stay available.

## Where it lives

`agent/extensions/deliverables.ts` registers both tools and the tracker. `lib/office-zip.ts` and `lib/xml-lite.ts` are the bounded container layer, `lib/office-read.ts` the readers and findings, `lib/office-build.ts` and `lib/sheet-formula.ts` the writers and calculator, `lib/office-render.ts` the optional LibreOffice step (a snap-packaged LibreOffice can only read below the home folder, so inputs are staged there and removed), `lib/deliverable-inspect.ts` the other inspectors, `lib/deliverable-ledger.ts` the tracking rules and `lib/binary-read.ts` the readable view of binary files for `read`, and `lib/specifics.ts` the unsupported-specifics comparison and `lib/pptx-build.ts` the deck builder. Tests: `tests/office-files.test.mjs`, `tests/deliverable-check.test.mjs`, `tests/binary-read.test.mjs`, `tests/specifics.test.mjs`, `tests/pptx-build.test.mjs`, `tests/office-convert.test.mjs`.
