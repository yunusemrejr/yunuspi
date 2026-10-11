# Anatomy

[Anatomy](https://skills.wheresryan.sh/anatomy) by Ryan is bundled under
`agent/skills/anatomy`, including its geometry kit, browser verification scripts,
references and eight complete examples. It is MIT licensed; `LICENSE` and
`UPSTREAM.json` in that directory retain attribution, the pinned upstream commit
and hashes. Installation is offline and needs no Claude account or plugin.

The standard skill catalogue and relevant-guidance hooks expose it to the
selected model and native child agents. Relevant requests automatically offer
its local workflow, without requiring a slash command or changing the model:

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
