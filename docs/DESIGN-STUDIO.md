# Design studio: from reference images to code

`image_crop` cuts assets out of a design reference (a mockup, a screenshot, or a Figma or Dribbble export) at full source resolution, and `image_understand` reads the reference through the selected vision model. The `frontend` skill owns the mockup-to-code workflow, including the comparison of the rendered build with the reference; the Observer Book's *Design to code* chapter carries the doctrine the session observer applies.

When a prompt clearly asks for image-to-code work ("turn this mockup into a website", "make the pricing page look more like this screenshot", an attached image plus a page to build), tool discovery puts these tools on the wire for the first model turn and skill routing suggests the skill. Other sessions discover them on demand with `tool_search`.

| Tool | What it does |
| --- | --- |
| `image_crop` | Cuts assets at full source resolution by region. Optional padding, edge-connected background keying with de-fringing, trimming and format choice (PNG for flat or transparent art, WebP for photographs, JPEG on request). |

## Limits

Crops from a mockup are placeholders unless the user supplied final assets. Compare the rendered build with the reference by eye with `render_see`, at other widths, states and accessibility too: a close visual match is not proof that the page is good.

`image_understand` uses real attachments through the selected vision model. See [media creation](MEDIA-CREATION.md) for limits and workflows.
