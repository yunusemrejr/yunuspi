# Design tools an agent can reach

When the design lives in Penpot, its official MCP server (`https://penpot.dev/ai/mcp-server`, hosted or self-run, with a plugin open in the file) lets an agent read and edit the file. When the project has a `components.json`, `npx shadcn@latest mcp` reads the registries it names. Connecting either is the owner's call at that moment.

A second opinion, when a screen passes the list but still feels generic: Impeccable (`https://github.com/pbakaus/impeccable`, Apache-2.0) has a 62-rule anti-slop detector and design commands (critique, audit, polish, typeset, layout, quieter) whose reference files on GitHub are worth reading for a check this list lacks. Running it (`npx impeccable detect`) downloads and executes a binary, and its install adds hooks: only with the owner's OK at that moment.
