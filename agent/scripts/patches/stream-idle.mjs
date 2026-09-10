// Pi 0.85.1 durable patch: ONE assistant-event inactivity budget, not a total
// generation deadline and not raw transport-byte/heartbeat detection.
// Install only this file in scripts/patches; verify-harness discovers targets().
// PI_STREAM_IDLE_MS (options.env before process.env), default 300000ms.
// Explicit timeoutMs wins, including 0 (disabled); driver options stay intact.
// Covers Models, compat dispatch and arbitrary agent streamFunction overrides.
// Direct raw API/provider calls outside those boundaries are not covered.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const helper = String.raw`
/* PI_STREAM_IDLE_V1: event progress, including thinking/tool fragments. */
// Symbol.for also deduplicates a runtime bundle calling an SDK custom stream.
// This marker is written ONLY to our own child signal, never the caller's.
const piStreamIdleSignalOwner = Symbol.for("pi-harness.stream-idle.v1");
export function piWithStreamIdle(model, options, start) {
    if (options?.signal?.[piStreamIdleSignalOwner] === true) return start(options);
    const outer = new AssistantMessageEventStream();
    const controller = new AbortController();
    const callerSignal = options?.signal;
    let timer, pendingStop, iterator, finished = false, lastMessage;
    const errorMessage = (error, reason) => {
        let message;
        try { if (lastMessage) message = structuredClone(lastMessage); } catch {}
        message ??= {
            role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        };
        for (const block of message.content) {
            delete block.partialJson;
            delete block.customInput;
        }
        message.stopReason = reason;
        message.errorMessage = error instanceof Error ? error.message : String(error);
        return message;
    };
    const cleanup = () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
        delete controller.signal[piStreamIdleSignalOwner];
        pendingStop?.();
    };
    const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        const reason = callerSignal?.aborted ? "aborted" : "error";
        const message = errorMessage(error, reason);
        outer.push({ type: "error", reason, error: message });
        outer.end(message);
        // Settlement precedes transport cancellation; never wait for driver cleanup.
        controller.abort(error);
    };
    const onAbort = () => fail(new Error("Request was aborted"));
    const dispose = (it) => {
        try { Promise.resolve(it?.return?.()).catch(() => {}); } catch {}
    };
    // At most one cancellation waiter, rather than one permanently retained
    // Promise.race handler per token on a long-running stream.
    const wait = async (work) => {
        try {
            return await new Promise((resolve, reject) => {
                pendingStop = () => resolve(undefined);
                Promise.resolve(work).then(resolve, reject);
                if (finished) pendingStop();
            });
        } finally { pendingStop = undefined; }
    };
    let idleMs;
    try {
        const configured = options?.timeoutMs ?? options?.env?.PI_STREAM_IDLE_MS ??
            (typeof process !== "undefined" ? process.env?.PI_STREAM_IDLE_MS : undefined) ?? 300000;
        idleMs = Number(configured);
        if (String(configured).trim() === "" || !Number.isFinite(idleMs) || idleMs < 0 || idleMs > 2147483647)
            throw new Error("Invalid PI_STREAM_IDLE_MS/timeoutMs inactivity budget: " + String(configured));
        idleMs = Math.floor(idleMs);
    } catch (error) { fail(error); return outer; }
    const reset = () => {
        clearTimeout(timer);
        if (idleMs > 0) timer = setTimeout(() => fail(new Error(
            "Provider stream idle timeout after " + idleMs + "ms without assistant events"
        )), idleMs);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) { onAbort(); return outer; }
    Object.defineProperty(controller.signal, piStreamIdleSignalOwner, { value: true, configurable: true });
    reset();
    void (async () => {
        try {
            const source = await wait(Promise.resolve().then(() => {
                if (!finished) return start({ ...options, signal: controller.signal });
            }).then((source) => {
                if (finished && source) dispose(source[Symbol.asyncIterator]());
                return source;
            }));
            if (finished) return;
            iterator = source[Symbol.asyncIterator]();
            while (!finished) {
                const next = await wait(iterator.next());
                if (finished) return;
                if (next.done) {
                    // A result() that never settles is covered by the same budget.
                    const result = await wait(typeof source.result === "function" ? source.result() : undefined);
                    if (finished) return;
                    if (!result || result.stopReason === "pending") throw new Error("Provider stream ended without a final result");
                    const type = result.stopReason === "error" || result.stopReason === "aborted" ? "error" : "done";
                    finished = true;
                    cleanup();
                    outer.push(type === "error" ? { type, reason: result.stopReason, error: result } : { type, reason: result.stopReason, message: result });
                    outer.end(result);
                    return;
                }
                const event = next.value;
                lastMessage = event.partial ?? event.message ?? event.error ?? lastMessage;
                if (event.type === "done" || event.type === "error") {
                    finished = true;
                    cleanup();
                    outer.push(event);
                    outer.end(event.type === "done" ? event.message : event.error);
                    return;
                }
                reset();
                outer.push(event);
            }
        } catch (error) { fail(error); }
        finally { dispose(iterator); }
    })();
    return outer;
}
`;

const count = (s, text) => s.split(text).length - 1;
function applied(source, edits) {
    let original = source;
    for (const [oldText, newText] of edits) {
        if (count(original, newText) !== 1) return false;
        original = original.replace(newText, oldText);
    }
    return (
        !original.includes("PI_STREAM_IDLE") &&
        edits.every(([oldText]) => count(original, oldText) === 1)
    );
}
function transform(source, edits, file) {
    if (applied(source, edits)) return source;
    if (
        source.includes("PI_STREAM_IDLE") ||
        source.includes("piWithStreamIdle")
    )
        throw Error(`stream-idle partial patch/postcondition drift: ${file}`);
    for (const [oldText] of edits) {
        if (count(source, oldText) !== 1)
            throw Error(
                `stream-idle anchor drift: ${file}: ${oldText.slice(0, 100)}`,
            );
    }
    for (const [oldText, newText] of edits)
        source = source.replace(oldText, newText);
    if (!applied(source, edits))
        throw Error(`stream-idle postcondition failed: ${file}`);
    return source;
}
const importEdit = (anchor, specifier) => [
    anchor,
    `import { piWithStreamIdle } from ${JSON.stringify(specifier)}; /* PI_STREAM_IDLE_IMPORT */\n${anchor}`,
];
const wrapper = (head, name, prefix = "") => [
    head,
    `${head} /* PI_STREAM_IDLE_CALL */ return piWithStreamIdle(model, options, idleOptions => ${prefix}piStreamIdleOriginal${name}(model, context, idleOptions)); }\n` +
        head.replace(
            /(?:export )?(function )?(streamSimple|stream)\(/,
            (_, fn) => `${fn ?? ""}piStreamIdleOriginal${name}(`,
        ),
];

export function targets() {
    const core =
        process.env.PI_HARNESS_PATCH_TEST_CORE ??
        path.join(
            execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
            "@earendil-works/pi-coding-agent",
        );
    const ai = path.join(core, "node_modules/@earendil-works/pi-ai");
    const agent = path.join(core, "node_modules/@earendil-works/pi-agent-core");
    for (const dir of [core, ai, agent]) {
        const version = JSON.parse(
            fs.readFileSync(path.join(dir, "package.json"), "utf8"),
        ).version;
        if (version !== "0.85.1")
            throw Error(
                `stream-idle supports Pi 0.85.1 only, found ${version} in ${dir}`,
            );
    }
    const chunks = path.join(core, "dist/bundle/chunks");
    const sources = fs
        .readdirSync(chunks)
        .filter((n) => n.endsWith(".js"))
        .map((n) => [
            path.join(chunks, n),
            fs.readFileSync(path.join(chunks, n), "utf8"),
        ]);
    const owner = (label, anchor) => {
        const found = sources.filter(([, s]) => s.includes(anchor));
        if (found.length !== 1)
            throw Error(
                `stream-idle expected one ${label} bundle owner, found ${found.length}`,
            );
        return found[0][0];
    };
    const eventBundle = owner(
        "event-stream factory",
        "function createAssistantMessageEventStream(",
    );
    const modelsBundle = owner("Models", "var ModelsImpl=class");
    const agentBundle = owner(
        "agent-loop",
        "async function streamAssistantResponse(",
    );
    if (
        owner("compat", "function streamSimple(model,context,options)") !==
        agentBundle
    )
        throw Error("stream-idle compat/agent bundle layout drift");
    const eventImport = "./" + path.basename(eventBundle);
    const definitions = [
        [
            path.join(ai, "dist/utils/event-stream.js"),
            [
                [
                    "export function createAssistantMessageEventStream() {",
                    helper +
                        "\nexport function createAssistantMessageEventStream() {",
                ],
            ],
        ],
        [
            path.join(ai, "dist/models.js"),
            [
                importEdit(
                    'import { lazyStream } from "./api/lazy.js";',
                    "./utils/event-stream.js",
                ),
                wrapper("stream(model, context, options) {", "Stream", "this."),
                wrapper(
                    "streamSimple(model, context, options) {",
                    "Simple",
                    "this.",
                ),
            ],
        ],
        [
            path.join(ai, "dist/compat.js"),
            [
                importEdit(
                    "export function stream(model, context, options) {",
                    "./utils/event-stream.js",
                ),
                wrapper(
                    "export function stream(model, context, options) {",
                    "Stream",
                ),
                wrapper(
                    "export function streamSimple(model, context, options) {",
                    "Simple",
                ),
            ],
        ],
        [
            path.join(agent, "dist/agent-loop.js"),
            [
                importEdit(
                    "async function streamAssistantResponse(context, config, signal, emit, streamFunction) {",
                    "../../pi-ai/dist/utils/event-stream.js",
                ),
                [
                    "const response = await streamFunction(config.model, llmContext, {\n        ...config,\n        apiKey: resolvedApiKey,\n        signal,\n    });",
                    "const response = await piWithStreamIdle(config.model, { ...config, apiKey: resolvedApiKey, signal }, idleOptions => streamFunction(config.model, llmContext, idleOptions)); /* PI_STREAM_IDLE_CALL */",
                ],
            ],
        ],
        [
            eventBundle,
            [
                [
                    "function createAssistantMessageEventStream(){",
                    helper + "\nfunction createAssistantMessageEventStream(){",
                ],
            ],
        ],
        [
            modelsBundle,
            [
                importEdit("var ModelsImpl=class", eventImport),
                wrapper("stream(model,context,options){", "Stream", "this."),
                wrapper(
                    "streamSimple(model,context,options){",
                    "Simple",
                    "this.",
                ),
            ],
        ],
        [
            agentBundle,
            [
                importEdit(
                    "async function streamAssistantResponse(context,config,signal,emit,streamFunction){",
                    eventImport,
                ),
                wrapper("function stream(model,context,options){", "Stream"),
                wrapper(
                    "function streamSimple(model,context,options){",
                    "Simple",
                ),
                [
                    "response=await streamFunction(config.model,llmContext,{...config,apiKey:resolvedApiKey,signal})",
                    "response=await piWithStreamIdle(config.model,{...config,apiKey:resolvedApiKey,signal},idleOptions=>streamFunction(config.model,llmContext,idleOptions)) /* PI_STREAM_IDLE_CALL */",
                ],
            ],
        ],
    ];
    // Some import insertions share a wrapper anchor. Combine these into one
    // replacement so matching and reversal are independent/non-overlapping.
    for (const [, edits] of definitions) {
        for (let i = 0; i < edits.length; i++) {
            for (let j = i + 1; j < edits.length; j++) {
                if (edits[i][0] === edits[j][0]) {
                    edits[i][1] = edits[i][1].replace(edits[j][0], edits[j][1]);
                    edits.splice(j--, 1);
                }
            }
        }
    }
    for (const [file] of definitions)
        if (!fs.existsSync(file))
            throw Error(`stream-idle missing required target: ${file}`);
    return definitions.map(([file, edits]) => ({
        name: `stream inactivity: ${path.relative(core, file)}`,
        file,
        exists: () => fs.existsSync(file),
        isApplied: () =>
            fs.existsSync(file) &&
            applied(fs.readFileSync(file, "utf8"), edits),
        remove() {
            const source = fs.readFileSync(file, "utf8");
            if (!applied(source, edits)) {
                transform(source, edits, file); // Stock is a no-op; partial/drift is loud.
                return;
            }
            let original = source;
            for (const [oldText, newText] of edits)
                original = original.replace(newText, oldText);
            fs.writeFileSync(file, original);
        },
        apply() {
            // Preflight ALL seven targets before any write; no silently omitted
            // runtime/SDK path and no half-application on detectable anchor drift.
            for (const [target, changes] of definitions)
                transform(fs.readFileSync(target, "utf8"), changes, target);
            const source = fs.readFileSync(file, "utf8");
            const result = transform(source, edits, file);
            if (result !== source) fs.writeFileSync(file, result);
        },
    }));
}
