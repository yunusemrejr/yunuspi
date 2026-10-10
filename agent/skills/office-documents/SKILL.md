---
name: office-documents
description: "Create, edit, convert and verify Word (docx, odt), Excel (xlsx, xlsm, ods, csv) and PowerPoint (pptx, odp) files, templates, formulas, tracked changes and speaker notes with office_doc; use for Word, Excel, LibreOffice, slide deck or presentation deliverables."
---

## Tools
- `office_doc read` any existing file; it also opens legacy .doc, .rtf, .xls and .ppt by converting them.
- `office_doc build` makes new docx, xlsx or pptx from a spec without an office suite. Prefer it to hand-written python-docx, python-pptx or openpyxl code.
- `office_doc render` with `pdfPath` and `pages:0` gives a checked PDF; look at the rendered pages.
- `office_doc convert` writes docx, odt, pptx, xlsx, pdf, html, txt or csv (one file per sheet).
- Never run soffice through bash; the sandbox blocks it.
- Use python libraries or a native app only for what the spec cannot express: tracked changes, complex fields, charts, pivots, macros, template fidelity.

## Word documents
- Inspect runs, styles, tables, sections, headers, footers, fields, comments and revisions before editing; a paragraph loop misses tables and text boxes.
- Setting paragraph.text drops run formatting, links and fields. Edit only the target range.
- Use the template's styles, real headings and lists, and no blank paragraphs for spacing.
- python-docx edits are not tracked changes. Keep existing revisions; never accept or flatten them to simplify an edit.
- Writing field XML does not evaluate it; recalculate fields in a capable app and check cross-references.

## Spreadsheets
- Keep IDs with leading zeros as text; keep blanks distinct from zero; take dates, epoch, currency and units from the source.
- Derive totals with formulas from separate input, calculation and output blocks; never paste a second copy of a number.
- Never turn untrusted strings into formulas. Validate denominators instead of hiding errors with IFERROR.
- Libraries do not recalculate; openpyxl data_only returns cached values. Recalculate in Excel or Calc and compare totals with a small independent calculation.
- Refresh pivots and check their source range. CSV drops formulas, styles and sheets: state delimiter, encoding and sheet.
- XLSM stays macro-enabled, never silently saved as XLSX. Inventory external links and package parts before and after a round trip.

## Presentations
- Start from the supplied theme and master; inspect layouts, notes and embedded objects of an existing deck before editing.
- One claim per slide. `office_doc build` continues long lists on "(2/3)" slides; shorten text rather than shrink it below a readable size.
- `office_doc verify` flags empty placeholders, dense slides, tiny type and duplicate titles.
- Keep titles, text, tables and charts editable. Bars for categories, lines for time, scatter for paired values; state units, denominator and source; keep zero distinct from missing.
- Animations and media survive only in native editing; PPTX, ODP and Keynote round trips can change fonts and timing.

## Verification and delivery
- Never overwrite the source or convert onto the only copy; write a new, clearly named file.
- Reopen the saved file; compare text, structure, page or slide count, aspect ratio and required facts.
- Inspect every changed page or slide at readable size: overlaps, off-page objects, cropping, font substitution, orphan headings, displaced footnotes, cut cells, #### or scientific notation, chart labels.
- An exit code proves little; a fresh, non-empty output must open and render. `deliverable_check` opens any produced file.
- A PDF is a static preview, not proof of animation, Word pagination or Excel rendering.
- Accessibility claims need application checks: heading order, language, alt text, table headers, reading order.
- Deliver one clearly named editable file plus an optional matching preview; state untested checks and unsupported features.
