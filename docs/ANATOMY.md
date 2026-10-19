# Anatomy

[Anatomy](https://skills.wheresryan.sh/anatomy) by Ryan is bundled under
`agent/skills/anatomy`, including its geometry kit, browser verification scripts,
references and eight complete examples. It is MIT licensed; `LICENSE` and
`UPSTREAM.json` in that directory retain attribution, the pinned upstream commit
and hashes. Installation is offline and needs no Claude account or plugin.

The standard skill catalogue exposes it to the selected model and native child
agents, so relevant requests can use its local workflow without a slash command:

- “Make a 3D animation of a mechanical watch.”
- “Explain how an LRU cache evicts entries, interactive.”
- “Draw an isometric diagram of this mechanism.”
- “Build a technical illustration for our documentation.”

`/skill:anatomy <request>` explicitly selects it. `skill_review` can also search
for `anatomy`, `isometric`, or `3D animation`. A parent can offer the same guide
to a child with `skill: "anatomy"`. Ordinary text explanations, excluded clauses,
quoted examples and requests without skills do not trigger the visual route.
Builtin workers that disable ambient skill inheritance still receive this one
bundled guide when their task matches; the rest of the catalogue stays unloaded.

Anatomy fits crafted SVG explanations, interactive mechanisms and parts that
turn in depth. General Blender scenes and rendered films retain the existing
3D/video tools. The guide is optional documentation: adapt detail and duration
to the user's request, keep the selected model and tool permissions, and inspect
actual frames and interaction before claiming quality. Its 3D engine is upstream
beta software; a small working preview comes before a dense animated scene.

Resolve all kit, script and example paths against the installed skill directory.
Copy an example or the needed kit files into the working project before building;
the bundled examples are reusable references, not an output directory. Node
build scripts require no npm packages. Browser checks use an existing Chrome or
Chromium (`CHROME_PATH` can select it), or YunusPi's available rendering/browser
tools; their results establish only the states actually checked.

## Anatomy Reveal

[Anatomy Reveal](https://github.com/annnguyentt/anatomy-reveal-skill) by Ann
Nguyen is bundled under `agent/skills/anatomy-reveal`. It builds one physical
object (a product, tool, instrument, shoe, fruit) from real dimensions as many
convex parts drawn with the Anatomy kit, then makes two things from that one
model: an interactive dissection page to drag, turn and take apart, and a
product-reveal film (MP4, 3–60 s, 9:16, 4:5, 1:1 or 16:9) that tumbles in,
whips to macro details, works a feature, explodes and snaps back. It is MIT
licensed; its `template/kit` is a subset of Anatomy with extra materials, and
`LICENSE`, `THIRD_PARTY_NOTICES.md` and `UPSTREAM.json` keep attribution, the
pinned commit and hashes. The demo film and stills are not bundled.

Use `anatomy` to explain how a system or mechanism works and `anatomy-reveal`
to show off one object and its parts. Requests such as “an exploded-view
animation of a mechanical keyboard” or “a product reveal film of my sneaker”
offer it automatically; `/skill:anatomy-reveal` loads it explicitly.

`node agent/skills/anatomy-reveal/scripts/new-project.mjs <dir>` scaffolds a
project (it runs `npm install` for puppeteer-core) and needs Chrome or Chromium
(`CHROME_PATH`), ffmpeg and ImageMagick 7. Frame size is the film's layout size
times `--dpr` (default 2, so 1080 wide); a 3 s 1:1 preview with
`--step 40 --most 2 --dpr 0.5` renders in about 30 s, while the full blur
render costs about two minutes per second of film.

## /anatomy

`/anatomy <object, mechanism or system>` starts a goal that uses both skills
and chooses between them by what the reader should understand. It chains like
the other boosts (see [GOAL.md](GOAL.md)):

```
/anatomy an interactive cutaway of a watch escapement
/anatomy /video a 10-second 1:1 reveal film of a Moka pot   # adds sound and a watched master
/anatomy /3d /noslop replace the landing page's feature list with one take-apart figure
/goal redesign the product page /anatomy /nobug
/anatomy                                                      # improve this project's anatomy figures
```

Its fronts are a grounded spec with the right skill, real parts, one truthful
model with clean geometry checks, rendered frames and a driven page actually
looked at, and a deliverable that builds from a clean start.

