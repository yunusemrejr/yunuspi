// The Team block in Settings: which model takes each kind of delegated work, and
// two switches. The harness reads it from settings.json; a missing value means the
// session's own model — or no advisor or consultant at all.

export const TEAM_ROLES = [
  { key: 'helper', title: 'Helper', hint: 'Long stretches that need judgment', fallback: 'inherit', first: { value: 'inherit', label: 'Same as the session' } },
  { key: 'legwork', title: 'Legwork', hint: 'Finding, reading, checks', fallback: 'inherit', first: { value: 'inherit', label: 'Same as the session' } },
  { key: 'sublegwork', title: 'Sub-legwork', hint: 'Legwork launched by a legwork child', fallback: 'inherit', first: { value: 'inherit', label: 'Same as legwork' } },
  { key: 'advisor', title: 'Advisor', hint: 'One hard question at a time', fallback: 'off', first: { value: 'off', label: 'Off' } },
  { key: 'consultant', title: 'Consultant', hint: 'A second model for one hard question', fallback: 'off', first: { value: 'off', label: 'Off' } },
];

export const PAID_VENDOR_VALUES = ['block', 'allow'];

/** A picker with two fixed options and no search: whether paid Claude, GPT and Gemini are blocked. */
export const TEAM_VENDOR_PICKER = {
  key: 'paidVendors',
  title: 'Claude, GPT and Gemini on paid APIs',
  hint: 'Block stops requests through OpenRouter or an API key. Subscription logins are not affected.',
  fixed: true,
  options: [{ value: 'block', label: 'Block' }, { value: 'allow', label: 'Allow' }],
};
export const DEFAULT_SUBSCRIPTION_POINTS = 3;
const SWITCH_KEYS = ['paidVendors', 'subscriptionPoints'];

const roleFor = key => TEAM_ROLES.find(role => role.key === key);

/** What the file says, with the defaults a missing block or key stands for. */
export function readTeam(team) {
  const stored = team && typeof team === 'object' && !Array.isArray(team) ? team : {};
  const values = {};
  for (const role of TEAM_ROLES) values[role.key] = typeof stored[role.key] === 'string' && stored[role.key].trim() ? stored[role.key] : role.fallback;
  values.paidVendors = PAID_VENDOR_VALUES.includes(stored.paidVendors) ? stored.paidVendors : 'block';
  values.subscriptionPoints = typeof stored.subscriptionPoints === 'number' && Number.isFinite(stored.subscriptionPoints) && stored.subscriptionPoints >= 0 ? stored.subscriptionPoints : DEFAULT_SUBSCRIPTION_POINTS;
  return values;
}

export const teamValue = model => `${model.provider}/${model.id}`;
export const teamLabel = model => `${model.provider} · ${model.id}`;

/**
 * A role's choices: its own first option, the `latest-<tier>` selectors (each
 * labelled with the model it stands for now), every available model, then a
 * value saved somewhere the current list does not reach (shown as its raw
 * provider/id so the choice stays visible rather than silently reset).
 */
export function teamOptions(role, models = [], saved, selectors = []) {
  const options = [{ ...role.first }];
  const seen = new Set(options.map(option => option.value));
  for (const selector of selectors) {
    if (typeof selector?.setting !== 'string' || typeof selector?.label !== 'string' || seen.has(selector.setting)) continue;
    seen.add(selector.setting);
    options.push({ value: selector.setting, label: selector.setting.replace('/', ' · '), name: selector.label });
  }
  for (const model of models) {
    if (typeof model?.provider !== 'string' || typeof model?.id !== 'string' || !model.provider || !model.id) continue;
    const value = teamValue(model);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: teamLabel(model), ...(typeof model.name === 'string' && model.name && model.name !== model.id ? { name: model.name } : {}) });
  }
  const selected = typeof saved === 'string' && saved.trim() ? saved : role.first.value;
  if (!seen.has(selected)) options.push({ value: selected, label: selected });
  return options.map(option => ({ ...option, selected: option.value === selected }));
}

/** Every word of the query appears somewhere in the text: "codex", "openrouter qwen", "gpt 5". */
export function matchesQuery(text, query) {
  const haystack = String(text).toLocaleLowerCase();
  return String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** How many rows a picker draws before it says how many are left. */
export const PICKER_LIMIT = 150;

/**
 * One picker row. `value` is what choosing it writes (provider/id, or a role's
 * own word), `label` the provider · id line shown beneath, `name` the display
 * name; `text` is what the search reads.
 */
export function modelRow(value, { name = '', label = '', provider, id } = {}) {
  const written = String(value), slash = written.indexOf('/');
  const ownProvider = typeof provider === 'string' && provider ? provider : slash > 0 ? written.slice(0, slash) : '';
  const ownId = typeof id === 'string' && id ? id : slash > 0 ? written.slice(slash + 1) : written;
  const shown = String(name || ownId), line = String(label || `${ownProvider} · ${ownId}`);
  return { value: written, provider: ownProvider, id: ownId, name: shown, label: line, text: `${shown} ${ownProvider}/${ownId} ${ownProvider} ${ownId}` };
}

/**
 * What a model picker shows for a query, best first: the provider the query
 * names, then ids and names that begin with a typed word, then every other
 * match. An empty query puts the current choice on top and groups the rest by
 * provider in the order the list arrived. Nothing is dropped here.
 */
export function rankModels(rows, query, current = '') {
  const words = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matched = rows.filter(row => matchesQuery(row.text, query));
  if (!words.length) {
    const groups = new Map();
    for (const row of matched) {
      if (row.value === current) continue;
      if (!groups.has(row.provider)) groups.set(row.provider, []);
      groups.get(row.provider).push(row);
    }
    return [...matched.filter(row => row.value === current), ...[...groups.values()].flat()];
  }
  const term = words.join(' ');
  const rank = row => {
    const provider = String(row.provider).toLocaleLowerCase();
    if (provider && (provider === term || provider.startsWith(term))) return 0;
    const fields = [row.id, row.name].map(field => String(field ?? '').toLocaleLowerCase());
    return fields.some(field => words.some(word => word && field.startsWith(word))) ? 1 : 2;
  };
  return matched
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.row);
}

/**
 * `inherit` and `off` only for the role that means them; a switch takes its own
 * words or a number of 0 or more; anything else is provider/model-id (or provider/latest-tier).
 */
export function validTeamValue(key, value) {
  if (typeof value !== 'string' || !value || value.length > 300) return false;
  if (key === 'paidVendors') return PAID_VENDOR_VALUES.includes(value);
  if (key === 'subscriptionPoints') return /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value));
  const role = roleFor(key);
  if (!role) return false;
  if (value === 'inherit') return role.fallback === 'inherit';
  if (value === 'off') return role.fallback === 'off';
  if (/\s/.test(value)) return false;
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

/**
 * Writes one key through the harness settings owner: only this key is marked
 * modified, so the locked writer replaces it and keeps every other key of
 * "team" — and of the file — as it was on disk. Returns the value as stored.
 */
export function applyTeamValue(manager, key, value) {
  if (!roleFor(key) && !SWITCH_KEYS.includes(key)) throw Error('Unknown Team setting.');
  if (!validTeamValue(key, value)) throw Error(SWITCH_KEYS.includes(key) ? 'Enter a valid value for this setting.' : 'Choose a model for this role.');
  const stored = key === 'subscriptionPoints' ? Number(value) : value;
  if (!manager.globalSettings.team || typeof manager.globalSettings.team !== 'object' || Array.isArray(manager.globalSettings.team)) manager.globalSettings.team = {};
  manager.globalSettings.team[key] = stored;
  manager.markModified('team', key);
  manager.save();
  return stored;
}
