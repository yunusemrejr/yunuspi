---
name: spreadsheet-authoring
description: "Create, edit and verify Excel XLSX/XLSM or LibreOffice Calc ODS workbooks, formulas, tables, charts and print layouts; use for spreadsheet deliverables."
---

# Spreadsheet authoring

Harness tools: `office_doc` reads, verifies and renders xlsx and ods and builds xlsx, all without an office suite, and `deliverable_check` opens any produced file. Start with `office_doc read` on an existing file; build new workbooks from a spec with `office_doc build` (columns with number formats, calculated formulas, totals, frozen header, auto-fitted widths), then `office_doc render` and look at the pages (`pdfPath` with `pages:0` converts a workbook to a checked PDF in one call). `office_doc convert` with `to:"csv"` writes one csv per sheet, `to:"xlsx"` upgrades a legacy `.xls`, and `read` on a legacy `.xls` converts it for you; never call libreoffice through bash, the sandbox blocks it. Reach for python libraries or an office application only for what a spec cannot express (charts, pivot tables, macros, existing-workbook edits that must keep every feature).

Inspect sheets, used ranges, formulas, cached values, named ranges, external links, macros and charts before choosing an editor. Keep identifiers as text, distinguish blanks from zero, and establish dates, locale, currency and units from the source. Preserve the original workbook and user formulas.

For workbook creation and formula validation, read [formulas and data](references/formulas-data.md). For existing complex workbooks, formats and Linux interoperability, read [fidelity and delivery](references/fidelity-delivery.md). Load only the relevant reference. Use the available spreadsheet application or connector when fidelity requires native behavior; use installed Python libraries for supported transformations. Do not assume an installed library recalculates formulas.

Separate inputs, calculations and outputs through clear labels and cell styles. Derive totals from formulas rather than baking a second set of numbers into the workbook. Trace material figures to input ranges and verify representative edge cases, including empty input and boundary dates. Avoid turning untrusted strings into executable formulas.

Reopen the saved file, check formula errors and key totals after actual recalculation, and render affected sheets or print regions to inspect clipping, date formats and pagination. Report explicitly if recalculation or visual inspection could not run. Deliver the editable workbook, retaining requested file format and macros when supported, with a short note on assumptions and any unresolved compatibility differences.
