#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(ROOT, "core/coding-agent/src/core/guardian");
const compiler = process.env.GUARDIAN_CXX || "clang++";
const wasmTarget = "wasm32-unknown-unknown";
const commonFlags = [
	`--target=${wasmTarget}`,
	"-std=c++20", "-O3", "-fno-exceptions", "-fno-rtti", "-fno-ident", "-fno-builtin",
	"-ffile-prefix-map=.=.", "-nostdlib", "-Wl,--no-entry", "-Wl,--export-memory",
	"-Wl,--initial-memory=131072", "-Wl,--max-memory=131072", "-Wl,--strip-all", "-Wl,--fatal-warnings",
];
const targets = [
	{ name: "classifier", source: "classifier.cpp", exports: ["guardian_eval", "guardian_model_version", "guardian_feature_count", "guardian_threshold", "guardian_feature_buffer_ptr"] },
	{ name: "similarity", source: "similarity.cpp", exports: ["guardian_similarity", "guardian_similarity_version", "guardian_similarity_left_ptr", "guardian_similarity_right_ptr"] },
];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function execute(file, args) {
	const result = spawnSync(file, args, { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${file} exited ${result.status ?? "by signal"}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout.trim();
}

execute(process.execPath, [path.join(ROOT, "scripts/guardian/train-model.mjs")]);
const compilerVersion = execute(compiler, ["--version"]).split("\n")[0];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-guardian-wasm-"));
const artifacts = {};
try {
	for (const target of targets) {
		const output = path.join(temp, `${target.name}.wasm`);
		const exportFlags = target.exports.map((name) => `-Wl,--export=${name}`);
		execute(compiler, [...commonFlags, ...exportFlags, "-o", output, path.join(SOURCE, target.source)]);
		const bytes = fs.readFileSync(output);
		const module = new WebAssembly.Module(bytes);
		if (WebAssembly.Module.imports(module).length !== 0) throw new Error(`${target.name} unexpectedly imports a host capability`);
		const actualExports = new Set(WebAssembly.Module.exports(module).map((item) => item.name));
		for (const expected of [...target.exports, "memory"]) if (!actualExports.has(expected)) throw new Error(`${target.name} is missing export ${expected}`);
		const destination = path.join(SOURCE, `${target.name}.wasm`);
		fs.writeFileSync(destination, bytes);
		artifacts[`${target.name}.wasm`] = { sha256: sha256(bytes), bytes: bytes.length, exports: [...target.exports, "memory"], imports: [] };
	}
	const provenance = {
		format: "yunuspi-guardian-wasm-provenance-v1",
		buildCommand: "node scripts/guardian/build-wasm.mjs",
		compiler: compilerVersion,
		target: wasmTarget,
		flags: commonFlags,
		modelTraining: "node scripts/guardian/train-model.mjs",
		trainingData: "scripts/guardian/case-data.mjs",
		modelHeaderSha256: sha256(fs.readFileSync(path.join(SOURCE, "model-parameters.generated.h"))),
		sources: Object.fromEntries(["classifier.cpp", "similarity.cpp", "model-parameters.generated.h"].map((file) => [file, sha256(fs.readFileSync(path.join(SOURCE, file)))])),
		trainingSources: Object.fromEntries(["scripts/guardian/case-data.mjs", "scripts/guardian/train-model.mjs"].map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])),
		artifacts,
	};
	fs.writeFileSync(path.join(SOURCE, "wasm-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
	console.log(JSON.stringify(provenance, null, 2));
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
