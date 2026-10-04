---
name: presentation-authoring
description: "Create and edit PowerPoint PPTX or LibreOffice Impress ODP presentations, templates, charts and speaker notes; verify slide geometry, editable content and export fidelity."
---

# Presentation authoring

Harness tools: `office_doc read` reads an existing deck (slide text, notes, layouts) and `office_doc verify` reports empty slides, empty placeholders, dense slides, tiny type and duplicate titles; after saving with python-pptx or an application, run `office_doc render` and look at every slide, then `deliverable_check` the final file; `office_doc render` with `pdfPath` and `pages:0` also turns a deck into a checked PDF in one call. These tools do not build decks.

Identify audience, narrative, aspect ratio, existing template and required editable output. Inspect the source deck's masters, layouts, fonts, notes and embedded objects before editing. Preserve the user's content and branding; give each slide one clear claim supported by its actual evidence.

Read [layout and authoring](references/layout-authoring.md) for reliable object creation and chart handling. Read [verification and interoperability](references/verification-interoperability.md) for rendering, existing-deck fidelity, Impress, Keynote or other format transitions. Load details only for the active workflow.

Use native PowerPoint/Impress operations or an available presentation connector when advanced objects need preservation. Use installed python-pptx or an appropriate generation library for supported editable content. Keep titles, body text, tables and charts editable unless a visual must be embedded as an image. Build alignment, spacing and type size consistently; shortening text is usually better than shrinking it until it fits.

Render every changed slide and inspect a contact sheet plus dense slides at full size. Check overlaps, off-slide objects, font substitution, chart labels, cropping and notes. Validate the deck reopens and compare slide count, aspect ratio and required facts. Package source assets when needed for continued editing. Deliver the requested deck and optional PDF preview, explaining unsupported animation, media or fidelity checks rather than silently dropping them.
