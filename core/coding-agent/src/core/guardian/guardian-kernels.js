import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const MAX_SIMILARITY_BYTES = 512;
const encoder = new TextEncoder();
const DEFAULT_FILES = Object.freeze({
	classifier: new URL("./classifier.wasm", import.meta.url),
	similarity: new URL("./similarity.wasm", import.meta.url),
	provenance: new URL("./wasm-provenance.json", import.meta.url),
});

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function instantiate(name, source) {
	const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
	const module = await WebAssembly.compile(bytes);
	const instance = await WebAssembly.instantiate(module, {});
	return { name, bytes, sha256: digest(bytes), module, instance, memory: instance.exports.memory, quarantined: false, error: undefined };
}

export class GuardianKernelRuntime {
	constructor({ readFile = (url) => readFileSync(url), instantiateModule = instantiate, files = DEFAULT_FILES, verifyProvenance = true } = {}) {
		this._readFile = readFile;
		this._instantiateModule = instantiateModule;
		this._files = files;
		this._verifyProvenance = verifyProvenance;
		this._modules = new Map();
		this._initializing = undefined;
	}

	async initialize() {
		if (this._initializing) return this._initializing;
		this._initializing = (async () => {
			let provenance;
			if (this._verifyProvenance) {
				try { provenance = JSON.parse(this._readFile(this._files.provenance).toString("utf8")); }
				catch (error) {
					for (const name of ["classifier", "similarity"]) this._modules.set(name, { name, quarantined: true, error: `provenance-unavailable:${error instanceof Error ? error.message : String(error)}` });
					return this.status();
				}
				if (provenance?.format !== "yunuspi-guardian-wasm-provenance-v1") {
					for (const name of ["classifier", "similarity"]) this._modules.set(name, { name, quarantined: true, error: "invalid-provenance-format" });
					return this.status();
				}
			}
			for (const name of ["classifier", "similarity"]) {
				if (this._modules.has(name)) continue;
				try {
					const bytes = this._readFile(this._files[name]);
					const expectedHash = provenance?.artifacts?.[`${name}.wasm`]?.sha256;
					if (this._verifyProvenance && (typeof expectedHash !== "string" || digest(bytes) !== expectedHash)) throw new Error("artifact-fingerprint-mismatch");
					const module = await this._instantiateModule(name, bytes);
					if (!module.memory || typeof module.memory.buffer !== "object") throw new Error("missing-exported-memory");
					this._modules.set(name, module);
				} catch (error) {
					this._modules.set(name, { name, quarantined: true, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return this.status();
		})();
		return this._initializing;
	}

	_statusOf(module) {
		if (!module) return { state: "unloaded" };
		if (module.quarantined) return { state: "quarantined", error: module.error };
		return { state: "ready", sha256: module.sha256 ?? digest(module.bytes) };
	}

	status() {
		return { classifier: this._statusOf(this._modules.get("classifier")), similarity: this._statusOf(this._modules.get("similarity")) };
	}

	_quarantine(module, error) {
		module.quarantined = true;
		module.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}

	_eval(moduleName, operation) {
		const module = this._modules.get(moduleName);
		if (!module || module.quarantined) return undefined;
		try {
			return operation(module.instance.exports, module.memory);
		} catch (error) {
			this._quarantine(module, error);
			return undefined;
		}
	}

	evaluate(features) {
		if (!Array.isArray(features) || features.length !== 12 || features.some((value) => !Number.isInteger(value) || value < 0 || value > 1000)) return undefined;
		return this._eval("classifier", (exports, memory) => {
			if (exports.guardian_feature_count() !== 12 || exports.guardian_model_version() !== 1) throw new Error("unsupported-classifier-abi");
			const pointer = exports.guardian_feature_buffer_ptr();
			if (!Number.isInteger(pointer) || pointer < 0 || pointer + 48 > memory.buffer.byteLength) throw new Error("classifier-scratch-bounds");
			const bytes = new Uint8Array(memory.buffer);
			try {
				bytes.fill(0, pointer, pointer + 48);
				const view = new DataView(memory.buffer);
				features.forEach((value, index) => view.setUint32(pointer + index * 4, value, true));
				const probability = exports.guardian_eval(pointer, features.length, 0);
				const threshold = exports.guardian_threshold();
				if (!Number.isInteger(probability) || probability < 0 || probability > 10000 || !Number.isInteger(threshold) || threshold < 0 || threshold > 10000) throw new Error("classifier-score-out-of-range");
				return { probability, threshold, modelVersion: exports.guardian_model_version() };
			} finally {
				bytes.fill(0, pointer, pointer + 48);
			}
		});
	}

	similarity(left, right) {
		if (typeof left !== "string" || typeof right !== "string") return undefined;
		// One extra UTF-16 code unit preserves a surrogate crossing the prefix.
		// Encoding is bounded before allocation, with identical first-512-byte semantics.
		const leftBytes = encoder.encode(left.slice(0, MAX_SIMILARITY_BYTES + 1)).subarray(0, MAX_SIMILARITY_BYTES);
		const rightBytes = encoder.encode(right.slice(0, MAX_SIMILARITY_BYTES + 1)).subarray(0, MAX_SIMILARITY_BYTES);
		if (!leftBytes.length || !rightBytes.length) return undefined;
		return this._eval("similarity", (exports, memory) => {
			if (exports.guardian_similarity_version() !== 1) throw new Error("unsupported-similarity-abi");
			const leftPointer = exports.guardian_similarity_left_ptr();
			const rightPointer = exports.guardian_similarity_right_ptr();
			if (!Number.isInteger(leftPointer) || !Number.isInteger(rightPointer) || leftPointer < 0 || rightPointer < 0 || leftPointer + MAX_SIMILARITY_BYTES > memory.buffer.byteLength || rightPointer + MAX_SIMILARITY_BYTES > memory.buffer.byteLength) throw new Error("similarity-scratch-bounds");
			const bytes = new Uint8Array(memory.buffer);
			try {
				bytes.fill(0, leftPointer, leftPointer + MAX_SIMILARITY_BYTES);
				bytes.fill(0, rightPointer, rightPointer + MAX_SIMILARITY_BYTES);
				bytes.set(leftBytes, leftPointer);
				bytes.set(rightBytes, rightPointer);
				const result = exports.guardian_similarity(leftPointer, leftBytes.length, rightPointer, rightBytes.length);
				if (!Number.isInteger(result) || result < 0 || result > 1000) throw new Error("similarity-score-out-of-range");
				return result;
			} finally {
				bytes.fill(0, leftPointer, leftPointer + MAX_SIMILARITY_BYTES);
				bytes.fill(0, rightPointer, rightPointer + MAX_SIMILARITY_BYTES);
			}
		});
	}
}

// Scratch memory and quarantine belong to one supervisor. WebAssembly may cache
// compiled code internally, but no mutable instance is shared between sessions.
export async function getGuardianKernelRuntime() {
	const runtime = new GuardianKernelRuntime();
	await runtime.initialize();
	return runtime;
}
