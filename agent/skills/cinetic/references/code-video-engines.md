# Video made in code

Engines where every frame is a function of time, so a film can be written, diffed and rendered again. Pick by what the film is made of; the right one is often none of these (a time-parameterised page rendered frame by frame, or ffmpeg on existing footage). Facts checked 27 Nov 2026: read the current licence and version before installing.

| The film is mostly | Look at | Why it fits | Watch out |
|---|---|---|---|
| A product, a UI, a page: DOM, CSS, SVG, three.js in React | **Remotion** (remotion.dev) | React components rendered by headless Chrome and ffmpeg; the local `remotion-*` skills cover create, captions, render and Studio; docs as Markdown (`/docs/agents.md`, `/llms.txt`) | Custom licence: free for individuals, nonprofits and companies of up to 3 people; a larger company needs a paid licence (remotion.dev/pricing). Check before using it for employer work |
| Remotion, with ready motion pieces instead of hand-written keyframes | **Remocn** (remocn.dev, MIT) | shadcn-style registry of Remotion components (text, transitions, UI mocks), Markdown docs per component (`/docs/<name>.md`, `/llms.txt`) | Its MCP server (`remocn.dev/mcp`) and `npx skills add Remocn/remocn` are installs: ask first. Read the component source; Remotion's licence still applies |
| Vector diagrams and code blocks timed to a voice-over | **Motion Canvas** (motioncanvas.io, MIT) | Generator functions drive the timeline, an editor scrubs it against the audio waveform; built-in code highlighting and transitions | Last tagged release is v3.17.2 (Dec 2024) though the repo is still pushed to; pin the version |
| The same, rendered on a server or in a batch | **Revideo** (github.com/midrender/revideo, MIT) | Motion Canvas-style scenes with a headless `renderVideo()` call and a render endpoint; docs at docs.re.video | The old revideo.dev domain no longer resolves; the repo moved to midrender |
| Mathematics, geometry, proofs, algorithms | **Manim Community** (docs.manim.community, MIT, Python) | Precise construction of equations, graphs and transforms; a large body of public scenes to learn from | LaTeX and Cairo dependencies; renders are CPU-heavy, so time a short scene first (`machine-limits`) |

Ways to use them:

- The engine is a means, not the look. Composition, type, palette and pacing still come from the subject and the rules in `SKILL.md`; a stock template from any of these is the median.
- Read a library's own examples for technique (a Motion Canvas code-morph, a Manim transform), then build the film from this project's content.
- Render one short test at the final size before the full length.