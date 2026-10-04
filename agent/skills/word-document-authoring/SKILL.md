---
name: word-document-authoring
description: "Create and revise Microsoft Word DOCX or LibreOffice Writer ODT documents, styles, tables, sections, fields and tracked changes while preserving document fidelity."
---

# Word document authoring

Harness tools: `office_doc` reads, verifies and renders docx and odt and builds docx, all without an office suite, and `deliverable_check` opens any produced file. Start with `office_doc read` on an existing file; build new documents from a spec with `office_doc build` (real heading styles, nested lists, tables with repeating headers, images with alt text, header and footer page numbers), then `office_doc render` and look at the pages (`pdfPath` with `pages:0` converts a document to a checked PDF in one call). Reach for python libraries or an office application only for what a spec cannot express (tracked changes, complex fields, template fidelity).

Inspect document structure before editing: paragraphs, runs, styles, tables, sections, headers, footers, fields, comments and tracked changes. Preserve the requested editing mode and original file; a rewrite with the same visible words can lose important structure.

Read [structure and revisions](references/structure-revisions.md) for safe DOCX edits and change tracking. Read [layout and interoperability](references/layout-interoperability.md) for Writer, page layout, exports and visual checks. Load only the reference needed. Prefer a native document application or available document connector when tracked changes, complex fields or template fidelity demand it; use installed python-docx for supported operations.

Use semantic paragraph and character styles rather than manually formatting every run. Model real headings and lists so navigation and accessibility survive. Keep numbering, cross-references and table structure coherent. Place explicit page or section breaks only when the layout requires them; blank paragraphs are fragile spacing.

Reopen the saved document, confirm expected text and structure, then render affected pages. Inspect pagination, tables, footnotes, headers, orphan headings and missing glyphs. Recalculate fields through a capable application when required; writing field XML does not evaluate it. Deliver the editable document in the requested format and a separate preview when helpful. State any revision, field-update or rendering checks that could not be completed.
