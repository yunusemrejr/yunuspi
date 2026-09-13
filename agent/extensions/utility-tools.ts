import { TOOLS } from './lib/utility-mcp/catalog.mjs';
import { UtilityClient } from './lib/utility-client.ts';
import fs from 'node:fs';

// Identical guidelines let Pi deduplicate this shared advice across all eight tools.
const UTILITY_GUIDANCE = 'Prefer utility probes and env_audit over shell/Python inspection snippets. Use explicit paths for files; inspect truncation flags and narrow or paginate incomplete results.';

/** Native tool exposure, MCP lifecycle and prompt guidance share one catalog. */
export default function utilityTools(pi: any) {
  let client: UtilityClient | undefined;
  const ensure = (cwd: string) => {
    const root = fs.realpathSync(cwd);
    if (client && client.root !== root) { client.close(); client = undefined; }
    return client ??= new UtilityClient(root);
  };
  const start = async (_event: any, ctx: any) => {
    try { await ensure(ctx.cwd).start(); }
    catch { ctx.ui?.notify?.('Utility MCP startup failed; the harness will retry automatically on use.', 'warning'); }
  };
  pi.on('session_start', start);
  pi.on('session_switch', start);
  pi.on('session_shutdown', () => { client?.close(); client = undefined; });
  for (const spec of TOOLS) pi.registerTool({
    name: spec.name,
    label: spec.name.replaceAll('_', ' '),
    description: spec.description,
    parameters: spec.inputSchema,
    promptSnippet: spec.description.split('. ')[0],
    promptGuidelines: [UTILITY_GUIDANCE],
    async execute(_id: string, args: unknown, signal: AbortSignal, _update: unknown, ctx: any) {
      try { return await ensure(ctx.cwd).call(spec.name, args, signal); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Utility unavailable; automatic retry is enabled' }) }] }; }
    },
  });
}
