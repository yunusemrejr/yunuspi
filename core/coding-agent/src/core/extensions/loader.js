/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@yunuspi/agent-core";
import * as _bundledPiAiCompat from "@yunuspi/ai/compat";
import * as _bundledPiAiOauth from "@yunuspi/ai/oauth";
import * as _bundledPiAiProviders from "@yunuspi/ai/providers/all";
import * as _bundledPiTui from "@yunuspi/tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary, isBundledNode } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @yunuspi/coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { resolvePath } from "../../utils/paths.js";
import { createEventBus } from "../event-bus.js";
import { execCommand } from "../exec.js";
import { readPiManifest } from "../pi-manifest.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import { time } from "../timings.js";
/** Modules available to extensions via virtualModules (for compiled binaries) */
const VIRTUAL_MODULES = {
    typebox: _bundledTypebox,
    "typebox/compile": _bundledTypeboxCompile,
    "typebox/value": _bundledTypeboxValue,
    "@sinclair/typebox": _bundledTypebox,
    "@sinclair/typebox/compile": _bundledTypeboxCompile,
    "@sinclair/typebox/value": _bundledTypeboxValue,
    "@yunuspi/agent-core": _bundledPiAgentCore,
    "@yunuspi/tui": _bundledPiTui,
    // Extensions resolve the pi-ai root to the compat entrypoint (a strict
    // superset of the core entrypoint): existing extensions using the old
    // global API keep working at runtime until compat is removed.
    "@yunuspi/ai": _bundledPiAiCompat,
    "@yunuspi/ai/compat": _bundledPiAiCompat,
    "@yunuspi/ai/oauth": _bundledPiAiOauth,
    "@yunuspi/ai/providers/all": _bundledPiAiProviders,
    "@yunuspi/coding-agent": _bundledPiCodingAgent,
    "@mariozechner/pi-agent-core": _bundledPiAgentCore,
    "@earendil-works/pi-agent-core": _bundledPiAgentCore,
    "@mariozechner/pi-tui": _bundledPiTui,
    "@earendil-works/pi-tui": _bundledPiTui,
    "@mariozechner/pi-ai": _bundledPiAiCompat,
    "@earendil-works/pi-ai": _bundledPiAiCompat,
    "@mariozechner/pi-ai/compat": _bundledPiAiCompat,
    "@earendil-works/pi-ai/compat": _bundledPiAiCompat,
    "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
    "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
    "@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
    "@earendil-works/pi-ai/providers/all": _bundledPiAiProviders,
    "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
    "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
};
const require = createRequire(import.meta.url);
const isNodeSeaBinary = ("sea" in process.features && process.features.sea === true) ||
    process.getBuiltinModule("node:sea")?.isSea() === true;
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";
/**
 * Get aliases for jiti (used in built Node.js mode).
 * In compiled binary mode, virtualModules is used instead.
 */
let _aliases = null;
function getAliases() {
    if (_aliases)
        return _aliases;
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageIndex = path.resolve(__dirname, "../..", "index.js");
    const typeboxEntry = require.resolve("typebox");
    const typeboxCompileEntry = require.resolve("typebox/compile");
    const typeboxValueEntry = require.resolve("typebox/value");
    const packagesRoot = path.resolve(__dirname, "../../../../");
    const resolveWorkspaceOrImport = (workspaceRelativePath, specifier) => {
        const workspacePath = path.join(packagesRoot, workspaceRelativePath);
        if (fs.existsSync(workspacePath)) {
            return workspacePath;
        }
        return fileURLToPath(import.meta.resolve(specifier));
    };
    const piCodingAgentEntry = packageIndex;
    const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@yunuspi/agent-core");
    const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@yunuspi/tui");
    // Extensions resolve the pi-ai root to the compat entrypoint (a strict
    // superset of the core entrypoint): existing extensions using the old
    // global API keep working at runtime until compat is removed.
    const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@yunuspi/ai/compat");
    const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@yunuspi/ai/oauth");
    const piAiProvidersEntry = resolveWorkspaceOrImport("ai/dist/providers/all.js", "@yunuspi/ai/providers/all");
    _aliases = {
        "@yunuspi/coding-agent": piCodingAgentEntry,
        "@yunuspi/agent-core": piAgentCoreEntry,
        "@yunuspi/tui": piTuiEntry,
        "@yunuspi/ai/providers/all": piAiProvidersEntry,
        "@yunuspi/ai/compat": piAiCompatEntry,
        "@yunuspi/ai/oauth": piAiOauthEntry,
        "@yunuspi/ai": piAiCompatEntry,
        "@mariozechner/pi-coding-agent": piCodingAgentEntry,
        "@earendil-works/pi-coding-agent": piCodingAgentEntry,
        "@mariozechner/pi-agent-core": piAgentCoreEntry,
        "@earendil-works/pi-agent-core": piAgentCoreEntry,
        "@mariozechner/pi-tui": piTuiEntry,
        "@earendil-works/pi-tui": piTuiEntry,
        "@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
        "@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
        "@mariozechner/pi-ai/compat": piAiCompatEntry,
        "@earendil-works/pi-ai/compat": piAiCompatEntry,
        "@mariozechner/pi-ai/oauth": piAiOauthEntry,
        "@earendil-works/pi-ai/oauth": piAiOauthEntry,
        "@mariozechner/pi-ai": piAiCompatEntry,
        "@earendil-works/pi-ai": piAiCompatEntry,
        typebox: typeboxEntry,
        "typebox/compile": typeboxCompileEntry,
        "typebox/value": typeboxValueEntry,
        "@sinclair/typebox": typeboxEntry,
        "@sinclair/typebox/compile": typeboxCompileEntry,
        "@sinclair/typebox/value": typeboxValueEntry,
    };
    return _aliases;
}
let extensionCacheCwd;
let extensionCacheGeneration = 0;
const extensionCache = new Map();
export function clearExtensionCache() {
    extensionCache.clear();
    extensionCacheCwd = undefined;
    extensionCacheGeneration++;
}
function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}
/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime() {
    const notInitialized = () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    };
    const state = {};
    const eventBusUnsubscribers = new Set();
    const assertActive = () => {
        if (state.staleMessage) {
            throw new Error(state.staleMessage);
        }
    };
    const runtime = {
        sendMessage: notInitialized,
        sendUserMessage: notInitialized,
        appendEntry: notInitialized,
        setSessionName: notInitialized,
        getSessionName: notInitialized,
        setLabel: notInitialized,
        getActiveTools: notInitialized,
        getAllTools: notInitialized,
        setActiveTools: notInitialized,
        // registerTool() is valid during extension load; refresh is only needed post-bind.
        refreshTools: () => { },
        getCommands: notInitialized,
        setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
        getThinkingLevel: notInitialized,
        setThinkingLevel: notInitialized,
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
        assertActive,
        invalidate: (message) => {
            if (state.staleMessage)
                return;
            state.staleMessage =
                message ??
                    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
            for (const unsubscribe of eventBusUnsubscribers)
                unsubscribe();
            eventBusUnsubscribers.clear();
        },
        trackEventBusSubscription: (unsubscribe) => {
            let active = true;
            const trackedUnsubscribe = () => {
                if (!active)
                    return;
                active = false;
                eventBusUnsubscribers.delete(trackedUnsubscribe);
                unsubscribe();
            };
            eventBusUnsubscribers.add(trackedUnsubscribe);
            return trackedUnsubscribe;
        },
        // Pre-bind: queue registrations so bindCore() can flush them once the
        // model registry is available. bindCore() replaces both with direct calls.
        registerProvider: (name, config, extensionPath = "<unknown>") => {
            runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
        },
        registerNativeProvider: (provider, extensionPath = "<unknown>") => {
            runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
        },
        unregisterProvider: (name) => {
            runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
            runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter((r) => r.provider.id !== name);
        },
    };
    return runtime;
}
/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(extension, runtime, cwd, eventBus) {
    const pendingFlagValues = new Map();
    const pendingRuntimeChanges = [];
    const loadingUnsubscribers = [];
    let state = "loading";
    const assertActive = () => {
        if (state === "failed") {
            throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
        }
        runtime.assertActive();
    };
    const applyRuntimeChange = (change) => {
        if (state === "loading")
            pendingRuntimeChanges.push(change);
        else
            change();
    };
    const clearPending = () => {
        pendingFlagValues.clear();
        pendingRuntimeChanges.length = 0;
        loadingUnsubscribers.length = 0;
    };
    const api = {
        // Registration methods - write to extension
        on(event, handler) {
            assertActive();
            const list = extension.handlers.get(event) ?? [];
            list.push((function instrumentHook(handler, hook, extensionPath) {
 // Count decision/check boundaries, not every streamed token, UI notification,
 // lifecycle observer or the telemetry observer itself. Keep this list aligned
 // with session-metrics.ts so pre-V2 history is interpreted by the same contract.
 if (
  ![
   "input",
   "before_agent_start",
   "context",
   "before_provider_request",
   "tool_call",
   "tool_result",
   "session_before_switch",
   "session_before_fork",
   "session_before_compact",
   "session_before_tree",
  ].includes(hook)
 )
  return handler;
 const parts = String(extensionPath).replace(/\\/g, "/").split("/");
 let owner = parts.at(-1);
 if (owner === "index.ts" || owner === "index.js") {
  parts.pop();
  while (["dist", "build", "lib", "src"].includes(parts.at(-1))) parts.pop();
  owner = parts.at(-1) || "unknown";
 }
 if (owner === "health-log.ts" || owner === "session-telemetry.ts")
  return handler;
 const size = (value) => {
  let total = 0,
   nodes = 0;
  const stack = [value],
   seen = new Set();
  while (stack.length) {
   const x = stack.pop();
   if (++nodes > 100000) return undefined;
   if (typeof x === "string") total += x.length;
   else if (x && typeof x === "object" && !seen.has(x)) {
    seen.add(x);
    const values = Array.isArray(x) ? x : Object.values(x);
    if (values.length + stack.length + nodes > 100000) return undefined;
    for (const v of values) stack.push(v);
   }
  }
  return total;
 };
 // Safe diagnostic fingerprints only: fixed-size hashes of a bounded prefix,
 // never payload text. Lets exports retain before/after prefix hashes, changed
 // position, semantic hash and revision while redacting sensitive content.
 const fnv = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
 };
 const fingerprint = (value) => {
  try {
   const json = JSON.stringify(value);
   if (typeof json !== "string") return undefined;
   const prefix = json.slice(0, 2000);
   const semantic = json.replace(/\s+/g, " ").slice(0, 2000);
   return { beforeHash: fnv(prefix), semanticHash: fnv(semantic), prefixLen: prefix.length };
  } catch { return undefined; }
 };
 const changedAt = (a, b) => {
  try {
   const sa = JSON.stringify(a), sb = JSON.stringify(b);
   if (typeof sa !== "string" || typeof sb !== "string") return undefined;
   const n = Math.min(sa.length, sb.length, 20000);
   for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return i;
   return sa.length === sb.length ? -1 : n;
  } catch { return undefined; }
 };
 return async function (...args) {
  const sink = globalThis[Symbol.for("yunus-pi.metrics.v1")];
  if (typeof sink !== "function") return handler.apply(this, args);
  const started = performance.now(),
   event = args[0];
  // Stable per-dispatch event id. The runner creates ONE ctx per dispatch and
  // passes it to every handler, so ctx identity is a true dispatch handle; a
  // WeakMap on a globalThis Symbol survives /reload and keeps loader + bundle
  // copies in agreement. toolCallId wins where present (stable across
  // processes), which is what makes 2x/3x execution detectable later.
  let eventId, seq;
  try {
   const reg =
    globalThis[Symbol.for("yunus-pi.dispatch.v1")] ||
    (globalThis[Symbol.for("yunus-pi.dispatch.v1")] = {
     seq: 0,
     ctxs: new WeakMap(),
    });
   const key =
    args[1] && typeof args[1] === "object"
     ? args[1]
     : event && typeof event === "object"
       ? event
       : reg;
   let cursor = reg.ctxs.get(key);
   if (cursor === undefined) {
    cursor = { id: ++reg.seq, n: 0 };
    reg.ctxs.set(key, cursor);
   }
   seq = ++cursor.n;
   const toolCallId = event?.toolCallId;
   eventId =
    typeof toolCallId === "string" && toolCallId ? toolCallId : "#" + cursor.id;
  } catch {}
  const input =
   hook === "context"
    ? event?.messages
    : hook === "before_provider_request"
      ? event?.payload
      : undefined;
  let before, beforePrint;
  try {
   if (input !== undefined) { before = size(input); beforePrint = fingerprint(input); }
  } catch {}
  let result,
   error = false;
  try {
   result = await handler.apply(this, args);
   return result;
  } catch (e) {
   error = true;
   throw e;
  } finally {
   try {
    const output = hook === "context" ? (result?.messages ?? input) : (result ?? input);
    const after = before === undefined ? undefined : size(output);
    const afterPrint = before === undefined ? undefined : fingerprint(output);
    const pos = before !== undefined ? changedAt(input, output) : undefined;
    const charsChanged = before !== undefined && after !== undefined ? Math.abs(after - before) : 0;
    sink("hook", {
     owner,
     hook,
     eventId,
     seq,
     revision: seq,
     ms: performance.now() - started,
     at: Date.now(),
     error,
     changed: result !== undefined,
     blocked: result?.block === true,
     removedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, before - after)
       : 0,
     addedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, after - before)
       : 0,
     charsChanged,
     tokensChanged: Math.round(charsChanged / 4),
     changedAt: Number.isSafeInteger(pos) ? pos : undefined,
     beforeHash: beforePrint?.beforeHash,
     afterHash: afterPrint?.beforeHash,
     semanticHash: afterPrint?.semanticHash,
    });
   } catch {}
  }
 };
})(handler,event,extension.path));
            extension.handlers.set(event, list); /* PI_HOOK_METRICS_V3 */
        },
        registerTool(tool) {
            assertActive();
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },
        registerCommand(name, options) {
            assertActive();
            if (typeof name !== "string" || !/^[^\s/]+$/.test(name)) {
                throw new Error("Command names must be non-empty and contain no whitespace or slashes");
            }
            if (typeof options?.handler !== "function") {
                throw new Error(`Command '${name}' requires a handler function`);
            }
            extension.commands.set(name, {
                ...options,
                name,
                sourceInfo: extension.sourceInfo,
            });
        },
        registerShortcut(shortcut, options) {
            assertActive();
            extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
        },
        registerFlag(name, options) {
            assertActive();
            if (options.default !== undefined && typeof options.default !== options.type) {
                throw new Error(`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`);
            }
            extension.flags.set(name, { name, extensionPath: extension.path, ...options });
            if (options.default !== undefined && !runtime.flagValues.has(name)) {
                if (state === "loading") {
                    if (!pendingFlagValues.has(name))
                        pendingFlagValues.set(name, options.default);
                }
                else {
                    runtime.flagValues.set(name, options.default);
                }
            }
        },
        registerMessageRenderer(customType, renderer) {
            assertActive();
            extension.messageRenderers.set(customType, renderer);
        },
        registerMarkdownTransformer(transformer) {
            assertActive();
            extension.markdownTransformer = transformer;
        },
        registerEntryRenderer(customType, renderer) {
            assertActive();
            extension.entryRenderers ??= new Map();
            extension.entryRenderers.set(customType, renderer);
        },
        // Flag access - checks extension registered it, reads from runtime
        getFlag(name) {
            assertActive();
            if (!extension.flags.has(name))
                return undefined;
            return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
        },
        // Action methods - delegate to shared runtime
        sendMessage(message, options) {
            assertActive();
            return runtime.sendMessage(message, options);
        },
        sendUserMessage(content, options) {
            assertActive();
            return runtime.sendUserMessage(content, options);
        },
        appendEntry(customType, data) {
            assertActive();
            runtime.appendEntry(customType, data);
        },
        setSessionName(name) {
            assertActive();
            runtime.setSessionName(name);
        },
        getSessionName() {
            assertActive();
            return runtime.getSessionName();
        },
        setLabel(entryId, label) {
            assertActive();
            runtime.setLabel(entryId, label);
        },
        exec(command, args, options) {
            assertActive();
            return execCommand(command, args, options?.cwd ?? cwd, options);
        },
        getActiveTools() {
            assertActive();
            return runtime.getActiveTools();
        },
        getAllTools() {
            assertActive();
            return runtime.getAllTools();
        },
        setActiveTools(toolNames) {
            assertActive();
            runtime.setActiveTools(toolNames);
        },
        getCommands() {
            assertActive();
            return runtime.getCommands();
        },
        setModel(model) {
            assertActive();
            return runtime.setModel(model);
        },
        getThinkingLevel() {
            assertActive();
            return runtime.getThinkingLevel();
        },
        setThinkingLevel(level) {
            assertActive();
            runtime.setThinkingLevel(level);
        },
        registerProvider(providerOrName, config) {
            assertActive();
            if (typeof providerOrName === "string") {
                if (!config)
                    throw new Error("Provider config is required when registering by name");
                applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
                return;
            }
            applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
        },
        unregisterProvider(name) {
            assertActive();
            applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
        },
        events: {
            emit(channel, data) {
                assertActive();
                eventBus.emit(channel, data);
            },
            on(channel, handler) {
                assertActive();
                const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
                if (state === "loading")
                    loadingUnsubscribers.push(unsubscribe);
                return unsubscribe;
            },
        },
    };
    return {
        api,
        commit: () => {
            if (state !== "loading")
                return;
            runtime.assertActive();
            for (const [name, value] of pendingFlagValues) {
                if (!runtime.flagValues.has(name))
                    runtime.flagValues.set(name, value);
            }
            for (const apply of pendingRuntimeChanges)
                apply();
            state = "active";
            clearPending();
        },
        discard: () => {
            if (state !== "loading")
                return;
            state = "failed";
            for (const unsubscribe of loadingUnsubscribers)
                unsubscribe();
            clearPending();
        },
    };
}
function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);
}
async function loadExtensionModule(extensionPath, cacheToken) {
    if (isCurrentCacheToken(cacheToken)) {
        const cachedFactory = extensionCache.get(extensionPath);
        if (cachedFactory) {
            return cachedFactory;
        }
    }
    const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        // Compiled binaries and the bundled Node distribution use embedded modules.
        // Source TypeScript reuses host modules and root tsconfig paths. Unbundled
        // Node builds use dist aliases.
        ...(isBunBinary || isNodeSeaBinary || isBundledNode
            ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
            : isTypeScriptSourceRuntime
                ? { virtualModules: VIRTUAL_MODULES, tsconfigPaths: true }
                : { alias: getAliases() }),
    });
    const module = await jiti.import(extensionPath, { default: true });
    const factory = module;
    if (typeof factory !== "function") {
        return undefined;
    }
    if (isCurrentCacheToken(cacheToken)) {
        extensionCache.set(extensionPath, factory);
    }
    return factory;
}
/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath, resolvedPath) {
    const source = extensionPath.startsWith("<") && extensionPath.endsWith(">")
        ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
        : "local";
    const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);
    return {
        path: extensionPath,
        resolvedPath,
        sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        entryRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
    };
}
async function initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime) {
    const extension = createExtension(extensionPath, resolvedPath);
    const load = createExtensionAPI(extension, runtime, cwd, eventBus);
    try {
        await factory(load.api);
        load.commit();
    }
    catch (error) {
        load.discard();
        throw error;
    }
    time(`${extensionPath} factory`, "extensions");
    return extension;
}
async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    try {
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        time(`${extensionPath} module import`, "extensions");
        if (!factory) {
            return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
        }
        const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);
        return { extension, error: null };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { extension: null, error: `Failed to load extension: ${message}` };
    }
}
/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath = "<inline>") {
    const resolvedCwd = resolvePath(cwd);
    return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}
/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false) {
    const extensions = [];
    const errors = [];
    const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
    const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
    const resolvedEventBus = eventBus ?? createEventBus();
    const resolvedRuntime = runtime ?? createExtensionRuntime();
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken);
        if (error) {
            errors.push({ path: extPath, error });
            continue;
        }
        if (extension) {
            extensions.push(extension);
        }
    }
    return {
        extensions,
        errors,
        runtime: resolvedRuntime,
    };
}
export async function loadExtensions(paths, cwd, eventBus, runtime) {
    return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}
export async function loadExtensionsCached(paths, cwd, eventBus, runtime) {
    return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}
function isExtensionFile(name) {
    return name.endsWith(".ts") || name.endsWith(".js");
}
/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir) {
    // Check for package.json with "pi" field first
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        const manifest = readPiManifest(packageJsonPath);
        if (manifest?.extensions?.length) {
            const entries = [];
            for (const extPath of manifest.extensions) {
                const resolvedExtPath = path.resolve(dir, extPath);
                if (fs.existsSync(resolvedExtPath)) {
                    entries.push(resolvedExtPath);
                }
            }
            if (entries.length > 0) {
                return entries;
            }
        }
    }
    // Check for index.ts or index.js
    const indexTs = path.join(dir, "index.ts");
    const indexJs = path.join(dir, "index.js");
    if (fs.existsSync(indexTs)) {
        return [indexTs];
    }
    if (fs.existsSync(indexJs)) {
        return [indexJs];
    }
    return null;
}
/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const discovered = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            // 1. Direct files: *.ts or *.js
            if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
                discovered.push(entryPath);
                continue;
            }
            // 2 & 3. Subdirectories
            if (entry.isDirectory() || entry.isSymbolicLink()) {
                const entries = resolveExtensionEntries(entryPath);
                if (entries) {
                    discovered.push(...entries);
                }
            }
        }
    }
    catch {
        return [];
    }
    return discovered;
}
/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(configuredPaths, cwd, agentDir = getAgentDir(), eventBus) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedAgentDir = resolvePath(agentDir);
    const allPaths = [];
    const seen = new Set();
    const addPaths = (paths) => {
        for (const p of paths) {
            const resolved = path.resolve(p);
            if (!seen.has(resolved)) {
                seen.add(resolved);
                allPaths.push(p);
            }
        }
    };
    // 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
    const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
    addPaths(discoverExtensionsInDir(localExtDir));
    // 2. Global extensions: agentDir/extensions/
    const globalExtDir = path.join(resolvedAgentDir, "extensions");
    addPaths(discoverExtensionsInDir(globalExtDir));
    // 3. Explicitly configured paths
    for (const p of configuredPaths) {
        const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            // Check for package.json with pi manifest or index.ts
            const entries = resolveExtensionEntries(resolved);
            if (entries) {
                addPaths(entries);
                continue;
            }
            // No explicit entries - discover individual files in directory
            addPaths(discoverExtensionsInDir(resolved));
            continue;
        }
        addPaths([resolved]);
    }
    return loadExtensions(allPaths, resolvedCwd, eventBus);
}
