import { SettingsManager, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Remember the main interactive model using Pi's locked, field-merging writer.
 * Startup resolution still owns availability checks and explicit CLI overrides.
 */
export default function lastModel(pi: ExtensionAPI) {
 let settings: SettingsManager | undefined;
 let remembered = '';
 const remember = async (model: {provider: string; id: string} | undefined, ctx: any) => {
  if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || !model ||
      typeof model.provider !== 'string' || !model.provider.trim() ||
      typeof model.id !== 'string' || !model.id.trim()) return;
  const key = JSON.stringify([model.provider, model.id]);
  if (key === remembered) return;
  try {
   settings ??= SettingsManager.create(ctx.cwd, getAgentDir());
   remembered = key;
   settings.setDefaultModelAndProvider(model.provider, model.id);
   await settings.flush();
   if (settings.drainErrors().length) throw new Error('settings persistence failed');
  } catch {
   if (remembered === key) remembered = '';
   ctx.ui?.notify?.('Could not save the last-used model. Check agent settings permissions and JSON validity.', 'warning');
  }
 };
 pi.on('session_start', (_event, ctx) => remember(ctx.model, ctx));
 pi.on('model_select', (event, ctx) => remember(event.model, ctx));
 pi.on('session_shutdown', async () => { await settings?.flush(); });
}
