import { paginate } from './files.mjs';
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const valid = name => new RegExp(`^${NAME}$`).test(name);

export function envAudit(files, args) {
  const refs = new Map(), docs = new Map(), unresolved = [];
  const add = (map, name, file, line, required = true) => {
    if (!valid(name)) return;
    const rows = map.get(name) ?? [];
    if (!rows.some(r => r.file === file && r.line === line && r.required === required)) rows.push({ file, line, required });
    map.set(name, rows);
  };
  const inspectRefs = (text, file) => {
    const patterns = [
      new RegExp(`(?:process\\.env|import\\.meta\\.env|Bun\\.env)\\.(${NAME})`, 'g'),
      new RegExp(`(?:process\\.env|import\\.meta\\.env|Bun\\.env|os\\.environ|ENV|\\$_ENV|\\$_SERVER)\\s*\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
      new RegExp(`(?:os\\.getenv|os\\.environ\\.get|os\\.Getenv|os\\.LookupEnv|System\\.getenv|Environment\\.GetEnvironmentVariable|Deno\\.env\\.get|(?:std::)?env::var(?:_os)?|getenv)\\s*\\(\\s*['"](${NAME})['"]`, 'g'),
      new RegExp(`\\$\\{(${NAME})(?::?[-+?][^}]*|)\\}`, 'g'),
    ];
    for (const re of patterns) for (const match of text.matchAll(re)) {
      const rest = text.slice(match.index + match[0].length).split(/\r?\n/)[0];
      const fallback = /\$\{[^}]+:-/.test(match[0]) || /^\s*(?:\?\?|\|\||,)/.test(rest) || /^\s*\)\s*(?:\?\?|\|\|)/.test(rest);
      add(refs, match[1], file, text.slice(0, match.index).split('\n').length, !fallback);
    }
    for (const match of text.matchAll(/\{([^{}\n]+)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)\b/g)) {
      for (const part of match[1].split(',')) {
        const key = part.trim().match(new RegExp(`^(${NAME})\\b`));
        if (key) add(refs, key[1], file, text.slice(0, match.index).split('\n').length, !part.includes('='));
      }
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (/(?:process\.env|import\.meta\.env|os\.environ|Bun\.env)\s*\[\s*[^\s'"]|(?:getenv|env::var)\s*\(\s*[^\s'"]|\.env\.get\s*\(\s*[^\s'"]/.test(line)) unresolved.push({ file, line: i + 1, kind: 'dynamic_reference' });
    });
  };
  for (const file of [...new Set(args.sources)]) inspectRefs(files.read(file), file);
  for (const file of [...new Set(args.configs)]) {
    const text = files.read(file);
    inspectRefs(text, file);
    text.split(/\r?\n/).forEach((line, i) => {
      const match = line.match(new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=`));
      if (match) add(docs, match[1], file, i + 1);
    });
    if (/\.(?:ya?ml|json)$/i.test(file)) {
      const data = files.document(file);
      const seen = new Set(); let nodes = 0;
      function visit(value, depth = 0) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        if (depth > 40 || ++nodes > 30000) throw Error('Configuration nesting limit exceeded');
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (key === 'env' || key === 'environment' || key === 'stringData' || key === 'data' && value.kind === 'ConfigMap') {
            if (Array.isArray(child)) for (const row of child) {
              if (typeof row === 'string') add(docs, row.split('=')[0], file, null);
              else if (row && typeof row.name === 'string') add(docs, row.name, file, null);
            }
            else if (child && typeof child === 'object') for (const name of Object.keys(child)) add(docs, name, file, null);
          }
          if (key === 'env_file' || key === 'envFrom') unresolved.push({ file, line: null, kind: 'external_environment_source_not_followed' });
          visit(child, depth + 1);
        }
      }
      visit(data);
    }
  }
  const names = [...new Set([...refs.keys(), ...docs.keys()])].sort();
  const result = names.map(name => ({ name, references: refs.get(name) ?? [], documented_in: docs.get(name) ?? [], required: (refs.get(name) ?? []).some(r => r.required) }));
  return { 'required-but-undocumented': result.filter(r => r.required && !r.documented_in.length).map(r => r.name),
    'documented-but-unused': result.filter(r => r.documented_in.length && !r.references.length).map(r => r.name),
    'referenced-across-files': result.filter(r => new Set(r.references.map(x => x.file)).size > 1).map(r => ({ name: r.name, files: [...new Set(r.references.map(x => x.file))].sort() })),
    ...paginate(result, args), unresolved,
    limitations: ['Static references only; comments may contain examples. Required means no recognized local fallback, not proof that a code path executes.', 'Only variable names and source locations are returned. External env files and dynamic variable names are not followed.'] };
}
