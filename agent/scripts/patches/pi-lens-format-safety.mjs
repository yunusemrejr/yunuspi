// pi-lens on-write formatter safety patch — re-applied by verify-harness.mjs.
//
// Automatic formatting must preserve project-owned bytes unless the project
// has explicitly opted into the formatter's embedded-language behavior. The
// bundled pi-lens fork has no source checkout, so this patch owns the small
// seam between FormatService and the Prettier command.
//
// On-write formatting honors the nearest project .prettierignore and passes
// Prettier's embedded-language-formatting=off option. Calls that use the
// FormatService directly keep Prettier's normal behavior, which leaves manual
// formatting available as an opt-in operation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "PI_LENS_ON_WRITE_FORMAT_SAFETY";
const DIST =
	process.env.PI_HARNESS_PATCH_TEST_LENS ??
	path.join(os.homedir(), ".pi/agent/extensions/pi-lens/dist/index.js");

const edits = [
	[
		"async function resolveFormatterCommand(formatter, absolutePath, cwd) {",
		"async function resolveFormatterCommand(formatter, absolutePath, cwd, options = {}) {",
	],
	[
		"const resolved = formatter.resolveCommand ? await formatter.resolveCommand(absolutePath, cwd) : null;",
		"const resolved = formatter.resolveCommand ? await formatter.resolveCommand(absolutePath, cwd, options) : null;",
	],
	[
		"async function formatFile(filePath, formatter) {",
		"async function formatFile(filePath, formatter, options = {}) {",
	],
	[
		"const cmd = await resolveFormatterCommand(formatter, absolutePath, cwd);",
		"const cmd = await resolveFormatterCommand(formatter, absolutePath, cwd, options);",
	],
	[
		"const results = await this.runFormattersWithConcurrency(absolutePath, formatters);",
		"const results = await this.runFormattersWithConcurrency(absolutePath, formatters, DEFAULT_FORMATTER_CONCURRENCY, options);",
	],
	[
		"async runFormattersWithConcurrency(filePath, formatters, _concurrency = DEFAULT_FORMATTER_CONCURRENCY) {",
		"async runFormattersWithConcurrency(filePath, formatters, _concurrency = DEFAULT_FORMATTER_CONCURRENCY, options = {}) {",
	],
	[
		"loadFormatters().then(({ formatFile: formatFile2 }) => formatFile2(filePath, formatter)),",
		"loadFormatters().then(({ formatFile: formatFile2 }) => formatFile2(filePath, formatter, options)),",
	],
	[
		"const result = await formatService.formatFile(filePath);",
		"const result = await formatService.formatFile(filePath, { onWrite: true });",
	],
	[
		'      "package.json",\n      "biome.json",',
		'      "package.json",\n      ".prettierignore",\n      "biome.json",',
	],
	[
		`prettierFormatter = {
      name: "prettier",
      command: ["npx", "prettier", "--write", "$FILE"],
      async resolveCommand(filePath, cwd) {
        const styleArgs = await indentationArgs(filePath, "prettier", cwd);
        if (styleArgs === null)
          return SKIP_FORMATTING;
        const args = ["--write", ...styleArgs];`,
		`prettierFormatter = {
      name: "prettier",
      command: ["npx", "prettier", "--write", "$FILE"],
      async resolveCommand(filePath, cwd, options = {}) {
        const styleArgs = await indentationArgs(filePath, "prettier", cwd);
        if (styleArgs === null)
          return SKIP_FORMATTING;
        // The explicit path is run with the file's directory as cwd. Pass the
        // nearest ignore file so nested files still use project-root patterns.
        const ignorePaths = await findUp([".prettierignore"], cwd);
        const ignoreArgs = ignorePaths.length > 0 ? ["--ignore-path", ignorePaths[0]] : [];
        const embeddedArgs = options.onWrite ? ["--embedded-language-formatting", "off"] : [];
        const args = ["--write", ...ignoreArgs, ...embeddedArgs, ...styleArgs];`,
	],
	[
		`        const global = await findGlobalBinary("prettier");
        if (global)
          return [global, ...args, filePath];
        return resolveManagedSmartDefaultCommand("prettier", filePath, args);`,
		`        const global = await findGlobalBinary("prettier");
        if (global)
          return [global, ...args, filePath];
        const managed = await resolveManagedSmartDefaultCommand("prettier", filePath, args);
        if (managed)
          return managed;
        if (!assertInstallAllowed("formatter npx fallback: prettier"))
          return SKIP_FORMATTING;
        return ["npx", "prettier", ...args, filePath];`,
	],
	[
		"async function runFormatPhase(filePath, getFormatService2, dbg2) {",
		`function __piLensPreserveInlineSvgOnWrite(filePath, dbg2) {
  const extension = path152.extname(filePath).toLowerCase();
  if (extension !== ".html" && extension !== ".htm")
    return false;
  try {
    const content = nodeFs7.readFileSync(filePath, "utf8");
    if (!/<svg(?:\\s|>)/i.test(content))
      return false;
    (dbg2 ?? (() => {}))("on-write formatter skipped " + filePath + ": inline SVG preservation");
    return true;
  } catch {
    return false;
  }
}

async function runFormatPhase(filePath, getFormatService2, dbg2) {`,
	],
	[
		`async function runFormatPhase(filePath, getFormatService2, dbg2) {
  if (!lensWorkState(filePath, path152.dirname(filePath))) return { formatChanged: false, formattersUsed: [], formatFailures: [], fileContent: void 0 };
  if (__piLensRecentlyWritten(filePath, dbg2)) {
    return { filePath, formatters: [], anyChanged: false, allSucceeded: true };
  }`,
		`async function runFormatPhase(filePath, getFormatService2, dbg2) {
  if (!lensWorkState(filePath, path152.dirname(filePath))) return { formatChanged: false, formattersUsed: [], formatFailures: [], fileContent: void 0 };
  if (__piLensRecentlyWritten(filePath, dbg2)) {
    return { filePath, formatters: [], anyChanged: false, allSucceeded: true };
  }
  if (__piLensPreserveInlineSvgOnWrite(filePath, dbg2)) {
    return { filePath, formatters: [], anyChanged: false, allSucceeded: true };
  }`,
	],
];

function applyEdit(source, [oldText, newText]) {
	if (oldText === newText) return source;
	if (source.includes(newText)) return source;
	const count = source.split(oldText).length - 1;
	if (count !== 1) {
		throw new Error(
			`pi-lens formatter safety anchor mismatch (${count} matches): ${oldText.slice(0, 100)}`,
		);
	}
	return source.replace(oldText, newText);
}

export function patchSource(source) {
	let next = source;
	for (const edit of edits) next = applyEdit(next, edit);
	if (!next.includes(MARKER)) {
		const match = next.match(/(^[ \t]*)prettierFormatter = \{/m);
		if (!match) {
			throw new Error("pi-lens formatter safety marker anchor mismatch");
		}
		const anchor = match[0];
		next = next.replace(
			anchor,
			`${match[1]}// ${MARKER}: on-write Prettier preserves ignored files and embedded bytes.\n${anchor}`,
		);
	}
	return next;
}

export function isAppliedSource(source) {
	return source.includes(MARKER) && edits.every(([, newText]) => source.includes(newText));
}

export function targets() {
	return [
		{
			name: "pi-lens on-write Prettier ignore and embedded-language safety",
			exists: () => fs.existsSync(DIST),
			isApplied: () => {
				try {
					return isAppliedSource(fs.readFileSync(DIST, "utf8"));
				} catch {
					return false;
				}
			},
			apply: () => {
				const source = fs.readFileSync(DIST, "utf8");
				const next = patchSource(source);
				if (next !== source) fs.writeFileSync(DIST, next);
				if (!isAppliedSource(fs.readFileSync(DIST, "utf8"))) {
					throw new Error("pi-lens formatter safety marker missing after patch");
				}
			},
		},
	];
}

if (
	process.argv[1] &&
	process.argv[1].endsWith("pi-lens-format-safety.mjs")
) {
	const isFix = process.argv.includes("--fix");
	const target = targets()[0];
	if (!target.exists()) {
		console.error(`pi-lens-format-safety: dist missing (${DIST})`);
		process.exit(1);
	}
	if (target.isApplied()) {
		console.log("pi-lens-format-safety: already applied");
		process.exit(0);
	}
	if (!isFix) {
		console.log("pi-lens-format-safety: NOT applied (run with --fix)");
		process.exit(1);
	}
	try {
		target.apply();
		console.log("pi-lens-format-safety: applied");
		process.exit(0);
	} catch (error) {
		console.error(
			`pi-lens-format-safety: apply failed — ${String(error?.message ?? error)}`,
		);
		process.exit(1);
	}
}
