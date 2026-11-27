// What the Team pickers list. The harness's own policy files decide, loaded as
// they are, so Settings and /team never disagree: the available models without
// the routes the vendor policy refuses (unless team.paidVendors allows them),
// and one `latest-<tier>` selector per tier, each with the model it stands for.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const policyFiles = ['vendor-policy.ts', 'model-tiers.ts'];

/**
 * `models` are { provider, id, name?, baseUrl? }; `oauthProviders` the providers
 * whose stored login is OAuth (a subscription), never an API key. `libDirs` are
 * the places the harness's lib folder can be: the first that holds both files
 * wins (the installed agent folder, then a source checkout). With none, it rejects,
 * so Settings says so instead of listing routes the harness would refuse.
 */
export async function teamCatalog({ libDirs, models, paidVendors, oauthProviders }) {
  const libDir = libDirs.find(dir => policyFiles.every(file => fs.existsSync(path.join(dir, file))));
  if (!libDir) throw Error('The harness policy files were not found. Reinstall YunusPi.');
  const [policy, tiers] = await Promise.all(policyFiles.map(file => import(pathToFileURL(path.join(libDir, file)).href)));
  const registry = { isUsingOAuth: model => oauthProviders.has(model.provider) };
  const listed = paidVendors === 'allow' ? models : models.filter(model => !policy.paidRouteRefusal(model, registry));
  return {
    models: listed.map(({ provider, id, name }) => ({ provider, id, ...(name ? { name } : {}) })),
    selectors: tiers.tierOptions(listed),
  };
}
