#!/usr/bin/env node
// Bounded deterministic transaction runner.
//
// Collapses the mechanical tail of a task — inspect -> patch -> format ->
// scoped verify — into ONE model request. The LLM supplies a declarative plan;
// every state transition inside it happens here, in Node, with fixed bounds and
// no inference in the loop. Returns a compact receipt instead of N tool results,
// which is what removes the model->tool->model round trips.
//
// Safety model:
//   * dry-run by default; `--apply` (or op.dryRun=false + --apply) is required
//     before any byte is written;
//   * every path is confined to the workspace root (realpath-checked);
//   * fixed op/read/time budgets; a breach fails the transaction, not the host;
//   * `test` only executes node scripts inside the workspace (no shell).
//
// Usage:
//   echo '<plan json>' | node scripts/transaction.mjs --plan - [--apply] [--root DIR]
//   node scripts/transaction.mjs --plan plan.json [--apply] [--json]
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createEffortController,
	DEFAULT_POLICY,
} from "../extensions/lib/effort-policy.mjs";

export const TRANSACTION_LIMITS = Object.freeze({
	maxOps: 12,
	maxReadBytes: 512 * 1024,
	maxWriteBytes: 512 * 1024,
	maxOpMs: 120_000,
	maxTotalMs: 300_000,
	maxReceiptChars: 4000,
	maxGrepMatches: 40,
	maxFileBytes: 8 * 1024 * 1024,
});

export const OP_KINDS = Object.freeze([
	"read",
	"edit",
	"write",
	"check",
	"grep",
	"test",
]);

const fail = (code) => {
	const error = new Error(code);
	error.transactionCode = code;
	throw error;
};

const confine = async (root, target) => {
	const resolved = path.resolve(root, target);
	const real = await fsp.realpath(resolved).catch(() => null);
	const base = await fsp.realpath(root).catch(() => path.resolve(root));
	// Resolve the nearest existing ancestor so a symlinked parent cannot
	// redirect a create/edit outside the workspace even when the final
	// component does not exist yet (realpath of the leaf then fails open).
	let ancestor = resolved;
	let realAncestor = null;
	for (;;) {
		realAncestor = await fsp.realpath(ancestor).catch(() => null);
		if (realAncestor !== null) break;
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	if (realAncestor !== null && realAncestor !== base && !realAncestor.startsWith(base + path.sep))
		fail("path outside workspace");
	const check = real ?? resolved;
	if (check !== base && !check.startsWith(base + path.sep))
		fail("path outside workspace");
	return resolved;
};

const readBounded = async (file, limits) => {
	const stat = await fsp.stat(file);
	if (!stat.isFile()) fail("not a file");
	if (stat.size > limits.maxFileBytes) fail("file too large");
	return fsp.readFile(file, "utf8");
};

const opStatus = (op, started, extra = {}) => ({
	op: op.op,
	status: "ok",
	ms: Math.max(0, Math.round(performance.now() - started)),
	...extra,
});

const runOp = async (op, { root, limits, applied, budget }) => {
	const started = performance.now();
	switch (op.op) {
		case "read": {
			const file = await confine(root, op.path);
			const text = await readBounded(file, limits);
			const offset = Math.max(0, Number(op.offset) || 1) - 1;
			const limit = Math.min(400, Math.max(1, Number(op.limit) || 200));
			const lines = text.split("\n").slice(offset, offset + limit);
			budget.readBytes += Buffer.byteLength(lines.join("\n"));
			if (budget.readBytes > limits.maxReadBytes) fail("read budget exceeded");
			return opStatus(op, started, {
				path: op.path,
				lines: lines.length,
				sha256: createHash("sha256")
					.update(lines.join("\n"))
					.digest("hex")
					.slice(0, 12),
				preview: lines.slice(0, Math.min(12, limit)).join("\n").slice(0, 1200),
			});
		}
		case "edit": {
			const file = await confine(root, op.path);
			const text = await readBounded(file, limits);
			const replacements = Array.isArray(op.replacements)
				? op.replacements
				: [{ oldText: op.oldText, newText: op.newText }];
			if (replacements.length === 0 || replacements.length > 8)
				fail("replacement count out of range");
			let next = text;
			const used = [];
			for (const r of replacements) {
				if (typeof r?.oldText !== "string" || typeof r?.newText !== "string")
					fail("invalid replacement");
				const parts = next.split(r.oldText);
				if (parts.length !== 2)
					fail(`oldText matched ${parts.length - 1} times (need exactly 1)`);
				next = parts.join(r.newText);
				used.push(r.oldText.slice(0, 24));
			}
			const delta = Buffer.byteLength(next) - Buffer.byteLength(text);
			if (Buffer.byteLength(next) > limits.maxWriteBytes)
				fail("write budget exceeded");
			if (applied) await fsp.writeFile(file, next);
			return opStatus(op, started, {
				path: op.path,
				applied,
				replaced: used.length,
				deltaBytes: delta,
			});
		}
		case "write": {
			const file = await confine(root, op.path);
			if (typeof op.content !== "string") fail("content required");
			const bytes = Buffer.byteLength(op.content);
			if (bytes > limits.maxWriteBytes) fail("write budget exceeded");
			const exists = fs.existsSync(file);
			if (exists && op.overwrite !== true) fail("file exists (set overwrite)");
			if (applied) {
				await fsp.mkdir(path.dirname(file), { recursive: true });
				await fsp.writeFile(file, op.content);
			}
			return opStatus(op, started, {
				path: op.path,
				applied,
				bytes,
				created: !exists,
			});
		}
		case "check": {
			const file = await confine(root, op.path);
			await readBounded(file, limits);
			// `node --check` with a module flag cannot take a file argument, so
			// syntax-check through the same stdin path the patch scripts use.
			const argv = [];
			if (file.endsWith(".mjs")) argv.push("--input-type=module");
			argv.push("--check");
			const source = await fsp.readFile(file, "utf8");
			await new Promise((resolve, reject) => {
				const child = execFile(
					process.execPath,
					argv,
					{ timeout: limits.maxOpMs },
					(error) => (error ? reject(error) : resolve()),
				);
				child.stdin?.end(source);
			}).catch(() => fail("syntax check failed"));
			return opStatus(op, started, { path: op.path, syntax: "ok" });
		}
		case "grep": {
			if (typeof op.pattern !== "string" || op.pattern.length > 200)
				fail("invalid pattern");
			const target = await confine(root, op.path ?? ".");
			const stat = await fsp.stat(target);
			const files = stat.isDirectory()
				? (await fsp.readdir(target, { recursive: true })).slice(0, 400)
				: [target];
			const matches = [];
			const re = new RegExp(op.pattern, op.ignoreCase ? "i" : "");
			for (const entry of files) {
				if (matches.length >= limits.maxGrepMatches) break;
				const file = stat.isDirectory() ? path.join(target, entry) : entry;
				let text;
				try {
					text = await readBounded(file, limits);
				} catch {
					continue;
				}
				if (text.includes("\u0000")) continue;
				text.split("\n").forEach((line, i) => {
					if (matches.length < limits.maxGrepMatches && re.test(line))
						matches.push(
							`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 160)}`,
						);
				});
			}
			return opStatus(op, started, {
				matches: matches.length,
				sample: matches.slice(0, 10),
			});
		}
		case "test": {
			const file = await confine(root, op.file ?? op.path);
			await readBounded(file, limits);
			if (!/\.m?js$/.test(file)) fail("test must be a node script");
			const args = Array.isArray(op.args) ? op.args.map(String).slice(0, 16) : [];
			const timeoutMs = Math.min(
				limits.maxOpMs,
				Math.max(1000, Number(op.timeoutMs) || 60_000),
			);
			const { stdout, stderr, exitCode } = await new Promise((resolve) => {
				const child = execFile(
					process.execPath,
					[file, ...args],
					{ timeout: timeoutMs, cwd: root },
					(error, stdout, stderr) =>
						resolve({
							stdout: String(stdout ?? ""),
							stderr: String(stderr ?? ""),
							exitCode: error ? (error.code ?? 1) : 0,
						}),
				);
				child.on("error", () =>
					resolve({ stdout: "", stderr: "spawn failed", exitCode: 1 }),
				);
			});
			const tail = (value) =>
				value.trim().split("\n").slice(-12).join("\n").slice(0, 1200);
			if (exitCode !== 0) {
				const failure = new Error("verify failed");
				failure.transactionCode = "verify failed";
				failure.detail = { exitCode, stdout: tail(stdout), stderr: tail(stderr) };
				throw failure;
			}
			return opStatus(op, started, {
				path: path.relative(root, file),
				exitCode,
				stdout: tail(stdout),
			});
		}
		default:
			fail(`unknown op: ${op.op}`);
	}
};

export const runTransaction = async (plan, options = {}) => {
	const root = path.resolve(options.root ?? process.cwd());
	const limits = { ...TRANSACTION_LIMITS, ...options.limits };
	const applied = options.apply === true;
	const ops = Array.isArray(plan?.ops) ? plan.ops : [];
	if (ops.length === 0) fail("empty plan");
	if (ops.length > limits.maxOps)
		fail(`too many ops (${ops.length} > ${limits.maxOps})`);
	for (const op of ops)
		if (!OP_KINDS.includes(op?.op)) fail(`unknown op: ${op?.op}`);

	const controller = createEffortController({
		level: options.level ?? DEFAULT_POLICY.level,
		floor: options.floor ?? DEFAULT_POLICY.floor,
	});
	const budget = { readBytes: 0 };
	const started = performance.now();
	const results = [];
	const changed = [];
	let failure = null;

	for (const [index, op] of ops.entries()) {
		if (performance.now() - started > limits.maxTotalMs) {
			failure = { index, op: op.op, code: "total time budget exceeded" };
			break;
		}
		try {
			const result = await runOp(op, { root, limits, applied, budget });
			results.push({ index, ...result });
			if (applied && (op.op === "edit" || op.op === "write"))
				changed.push(op.path);
		} catch (error) {
			const code = error?.transactionCode ?? "op failed";
			results.push({
				index,
				op: op.op,
				status: "failed",
				code,
				path: op.path ?? op.file ?? null,
				detail: error?.detail ?? undefined,
				ms: Math.max(0, Math.round(performance.now() - started)),
			});
			failure = { index, op: op.op, code };
			if (op.stop !== false) break; // fail closed: stop the batch
		}
	}

	const errors = results.filter((r) => r.status === "failed").length;
	const advice = controller.advise({
		tools: ops.map((o) =>
			o.op === "test" ? "bash" : o.op === "check" ? "bash" : o.op,
		),
		errors,
		files: changed.length,
	});
	const receipt = {
		ok: failure === null,
		applied,
		root,
		ops: results,
		changed,
		durationMs: Math.round(performance.now() - started),
		budget: {
			readBytes: budget.readBytes,
			ops: results.length,
			of: limits.maxOps,
		},
		nextEffort: {
			level: advice.level,
			difficulty: advice.difficulty,
			reasons: advice.reasons,
		},
	};
	if (failure) receipt.failure = failure;
	return receipt;
};

export const formatReceipt = (receipt, limits = TRANSACTION_LIMITS) => {
	const lines = [
		`transaction ${receipt.ok ? "ok" : "FAILED"} (${receipt.applied ? "applied" : "dry-run"}) ${receipt.durationMs}ms`,
		...receipt.ops.map((r) => {
			const where = r.path ? ` ${r.path}` : "";
			const extra =
				r.status === "ok"
					? r.lines !== undefined
						? ` ${r.lines} lines`
						: r.deltaBytes !== undefined
							? ` ${r.deltaBytes >= 0 ? "+" : ""}${r.deltaBytes}B`
							: r.bytes !== undefined
								? ` ${r.bytes}B`
								: r.matches !== undefined
									? ` ${r.matches} matches`
									: r.exitCode !== undefined
										? ` exit ${r.exitCode}`
										: ""
					: ` ${r.code}`;
			return `  ${r.index + 1}. ${r.op}${where}${extra}`;
		}),
	];
	if (receipt.changed.length > 0)
		lines.push(`changed: ${receipt.changed.join(", ")}`);
	lines.push(
		`next effort: ${receipt.nextEffort.level} (${receipt.nextEffort.difficulty})`,
	);
	const text = lines.join("\n");
	return text.length > limits.maxReceiptChars
		? `${text.slice(0, limits.maxReceiptChars)}\n… receipt truncated`
		: text;
};

const readStdin = () =>
	new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
	});

const isDirectRun =
	process.argv[1] &&
	import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isDirectRun) {
	const args = process.argv.slice(2);
	let planPath = null;
	let apply = false;
	let rootDir = process.cwd();
	let asJson = false;
	for (let i = 0; i < args.length; i++) {
		const key = args[i];
		const value = args[i + 1];
		if (key === "--apply") apply = true;
		else if (key === "--json") asJson = true;
		else if (key === "--plan") {
			planPath = value;
			i++;
		} else if (key === "--root") {
			rootDir = value;
			i++;
		} else {
			console.error(
				"Usage: transaction.mjs --plan FILE|- [--apply] [--root DIR] [--json]",
			);
			process.exit(2);
		}
	}
	try {
		const raw =
			planPath === "-" || planPath === null
				? process.stdin.isTTY
					? ""
					: await readStdin()
				: fs.readFileSync(path.resolve(planPath), "utf8");
		const plan = JSON.parse(raw);
		const receipt = await runTransaction(plan, { apply, root: rootDir });
		console.log(
			asJson ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt),
		);
		if (!receipt.ok) process.exitCode = 1;
	} catch (error) {
		console.error(
			`transaction refused: ${error instanceof Error ? error.message : "invalid plan"}`,
		);
		process.exitCode = 1;
	}
}
