import { join } from "node:path";
import { createHash } from "node:crypto";
import { Agent, setDefaultStreamFn } from "@yunuspi/agent-core";
import { clampThinkingLevel, streamSimple } from "@yunuspi/ai/compat";
import { getAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.js";
import { AgentSession } from "./agent-session.js";
import { guardianRequestMessages } from "./guardian/guardian-supervisor.js";
import { formatNoModelsAvailableMessage } from "./auth-guidance.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { convertToLlm } from "./messages.js";
import { findInitialModel } from "./model-resolver.js";
import { ModelRuntime } from "./model-runtime.js";
import { mergeProviderAttributionHeaders } from "./provider-attribution.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { time } from "./timings.js";
import { createBashTool, createCodingTools, createEditTool, createFindTool, createGrepTool, createLsTool, createPowerShellTool, createReadOnlyTools, createReadTool, createWriteTool, withFileMutationQueue, } from "./tools/index.js";
// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);
// Re-exports
export * from "./agent-session-runtime.js";
export { withFileMutationQueue,
// Tool factories (for custom cwd)
createCodingTools, createReadOnlyTools, createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, createPowerShellTool, };
// Helper Functions
function getDefaultAgentDir() {
    return getAgentDir();
}
// Observer delivery receipts contain only an opaque ID and content digest.
// Inspect text fields, never image/audio/base64 data or arbitrary payload trees.
function requestText(payload) {
    const text = [];
    for (const key of ["messages", "input", "contents"]) {
        if (!Array.isArray(payload?.[key])) continue;
        for (const message of payload[key]) {
            if (typeof message?.content === "string") text.push(message.content);
            for (const parts of [message?.content, message?.parts]) if (Array.isArray(parts)) {
                for (const part of parts) if (typeof part?.text === "string") text.push(part.text);
            }
        }
    }
    return text;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@yunuspi/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options = {}) {
    const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
    const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
    let resourceLoader = options.resourceLoader;
    const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
    const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
    const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));
    const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
    const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
    if (!resourceLoader) {
        resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
        await resourceLoader.reload();
        time("resourceLoader.reload");
    }
    // Check if session has existing data to restore
    const existingSession = sessionManager.buildSessionContext();
    const hasExistingSession = existingSession.messages.length > 0;
    const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
    let model = options.model;
    let modelFallbackMessage;
    // If session has data, try to restore model from it
    if (!model && hasExistingSession && existingSession.model) {
        const restoredModel = modelRuntime.getModel(existingSession.model.provider,existingSession.model.modelId) ?? (function restoreUnlisted(modelRuntime, provider, id) {
  /* PI_UNLISTED_RESTORE_V1 */
  if (!modelRuntime.hasConfiguredAuth(provider)) return;
  const base = modelRuntime.getModels(provider)?.[0];
  if (!base) return;
  return ({restoreCustomModelItem(query) {
  /* PI_RESTORE_PICKER_V1 */
  const value = query.trim();
  if (!value || value.includes('://') || value.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(value) || this.isDefaultSearch(value)) return;
  const models = this.allModels.map(item => item.model);
  if (models.some(m => m.id.toLowerCase() === value.toLowerCase() || (m.provider + '/' + m.id).toLowerCase() === value.toLowerCase())) return;
  const providers = [...new Set(models.map(m => m.provider))];
  const slash = value.indexOf('/');
  const explicit = slash > 0 && providers.find(p => p.toLowerCase() === value.slice(0, slash).toLowerCase());
  const provider = explicit || this.currentModel?.provider || (providers.length === 1 ? providers[0] : undefined);
  const id = explicit ? value.slice(slash + 1) : value;
  if (!provider || !id || !providers.includes(provider)) return;
  const base = this.currentModel?.provider === provider ? this.currentModel : models.find(m => m.provider === provider);
  if (!base?.api || !base.baseUrl) return;
  // Carry connection/compatibility settings, never another model's prices or advertised capabilities.
  const contextWindow = Number.isSafeInteger(base.contextWindow) && base.contextWindow > 0 ? base.contextWindow : 131072;
  const maxTokens = Math.min(Number.isSafeInteger(base.maxTokens) && base.maxTokens > 0 ? base.maxTokens : 8192, 8192, contextWindow);
  const model = { provider, id, name: 'Unlisted ID: ' + id + ' — limits/pricing unverified (session only)',
    api: base.api, baseUrl: base.baseUrl, ...(base.headers ? {headers: {...base.headers}} : {}),
    ...(base.compat ? {compat: {...base.compat}} : {}), reasoning: false, input: ['text'],
    contextWindow, maxTokens, cost: {input:0, output:0, cacheRead:0, cacheWrite:0}, piUnlistedModel:true };
  return {provider, id, model};
}}).restoreCustomModelItem.call({
    allModels: [{model:base}], currentModel:base, isDefaultSearch:()=>false,
  }, provider + '/' + id)?.model;
})(modelRuntime,existingSession.model.provider,existingSession.model.modelId);
        if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
            model = restoredModel;
        }
        if (!model) {
            modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
        }
    }
    // If still no model, use findInitialModel (checks settings default, then provider defaults)
    if (!model) {
        const result = await findInitialModel({
            scopedModels: [],
            isContinuing: hasExistingSession,
            defaultProvider: settingsManager.getDefaultProvider(),
            defaultModelId: settingsManager.getDefaultModel(),
            defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
            modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
            modelRuntime,
        });
        model = result.model;
        if (!model) {
            modelFallbackMessage = formatNoModelsAvailableMessage();
        }
        else if (modelFallbackMessage) {
            modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
        }
    }
    let thinkingLevel = options.thinkingLevel;
    // If session has data, restore thinking level from it
    if (thinkingLevel === undefined && hasExistingSession) {
        thinkingLevel = hasThinkingEntry
            ? existingSession.thinkingLevel
            : (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
    }
    // Fall back to per-model override, then global default
    if (thinkingLevel === undefined && model) {
        const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
        if (perModel) {
            thinkingLevel = perModel;
        }
    }
    if (thinkingLevel === undefined) {
        thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    // Clamp to model capabilities
    if (!model) {
        thinkingLevel = "off";
    }
    else {
        thinkingLevel = clampThinkingLevel(model, thinkingLevel);
    }
    const defaultActiveToolNames = ["read", "bash", "edit", "write"];
    const configuredDefaultToolNames = settingsManager.getDefaultTools();
    const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
    const excludedToolNames = options.excludeTools;
    const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
    const initialActiveToolNames = (options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))).filter((name) => !excludedToolNameSet?.has(name));
    let agent;
    // Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
    const convertToLlmWithBlockImages = (messages) => {
        const converted = convertToLlm(messages);
        // Check setting dynamically so mid-session changes take effect
        if (!settingsManager.getBlockImages()) {
            return converted;
        }
        // Filter out ImageContent from all messages, replacing with text placeholder
        return converted.map((msg) => {
            if (msg.role === "user" || msg.role === "toolResult") {
                const content = msg.content;
                if (Array.isArray(content)) {
                    const hasImages = content.some((c) => c.type === "image");
                    if (hasImages) {
                        const filteredContent = content
                            .map((c) => c.type === "image" ? { type: "text", text: "Image reading is disabled." } : c)
                            .filter((c, i, arr) =>
                        // Dedupe consecutive "Image reading is disabled." texts
                        !(c.type === "text" &&
                            c.text === "Image reading is disabled." &&
                            i > 0 &&
                            arr[i - 1].type === "text" &&
                            arr[i - 1].text === "Image reading is disabled."));
                        return { ...msg, content: filteredContent };
                    }
                }
            }
            return msg;
        });
    };
    const extensionRunnerRef = {};
    agent = new Agent({
        initialState: {
            systemPrompt: "",
            model,
            thinkingLevel,
            tools: [],
        },
        convertToLlm: convertToLlmWithBlockImages,
        streamFn: async (model, context, options) => {
            const providerRetrySettings = settingsManager.getProviderRetrySettings();
            const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
            // SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
            // Use max int32 to effectively disable the timeout.
            const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
            const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
            const websocketConnectTimeoutMs = options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
            const headerRunner = extensionRunnerRef.current;
            const requestSessionId = sessionManager.getSessionId();
            let capsules = [];
            try {
                // Advice capsules from the session observer and Mr. Watchmaker
                // share this receipt array; ids are namespaced per reviewer and
                // each extension confirms only its own ids. The receipt line
                // must start the capsule text: extensions put any escalation
                // prefix after it, never before.
                capsules = requestText({ messages: context.messages }).filter(text => text.length <= 4096)
                    .map(text => ({ text, id: /^\[Observer advice receipt=(observer-advice-[0-9a-f-]{36})\b/.exec(text)?.[1] ?? /^\[Watchmaker advice receipt=(watchmaker-advice-[0-9a-f-]{36})\b/.exec(text)?.[1] }))
                    .filter(row => row.id).slice(-4);
            } catch { /* Optional receipt metadata cannot fail inference. */ }
            let observerAdviceReceipts = [];
            return modelRuntime.streamSimple(model, context, {
                ...options,
                timeoutMs,
                websocketConnectTimeoutMs,
                maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
                onPayload: async (payload, actualModel) => {
                    observerAdviceReceipts = [];
                    const finalPayload = (await options?.onPayload?.(payload, actualModel)) ?? payload;
                    try { if (capsules.length && !options?.signal?.aborted && actualModel?.provider === model.provider && actualModel?.id === model.id) {
                        const text = requestText(finalPayload);
                        observerAdviceReceipts = capsules.filter(capsule => text.some(part => part.includes(capsule.text)))
                            .map(capsule => ({ id: capsule.id, sha256: createHash("sha256").update(capsule.text).digest("hex") }));
                    } } catch { /* A receipt failure leaves delivery unknown. */ }
                    return finalPayload;
                },
                onResponse: async (response, actualModel) => {
                    const current = !options?.signal?.aborted && headerRunner === extensionRunnerRef.current && requestSessionId === sessionManager.getSessionId()
                        && actualModel?.provider === model.provider && actualModel?.id === model.id;
                    await options?.onResponse?.({ ...response,
                        observerAdviceReceipts: current && response.status >= 200 && response.status < 300 ? observerAdviceReceipts : [],
                    }, actualModel);
                },
                transformHeaders: async (requestHeaders) => {
                    const headers = mergeProviderAttributionHeaders(model, settingsManager, options?.sessionId, requestHeaders);
                    return headerRunner?.hasHandlers("before_provider_headers")
                        ? headerRunner.emitBeforeProviderHeaders(headers ?? {})
                        : (headers ?? {});
                },
            });
        },
        onPayload: async (payload, _model) => {
            // PI_BODY_GATE (local patch; re-applied by verify-harness.mjs): enforce the
            // provider's hard ENCODED-request-body cap before the HTTP call. Token
            // compaction cannot bound request BYTES: a base64 image is ~1.3x its
            // raw size and every resent turn adds bytes, so a session under the
            // token cap can still exceed the body cap. Oversized requests fail
            // here with a quantified, actionable error instead of the opaque
            // provider `413 payload_too_large`. Sits after the extension hook
            // because the runner swallows handler throws — this is the one point
            // that can actually block.
            const runner = extensionRunnerRef.current;
            let gatePayload = runner?.hasHandlers("before_provider_request")
                ? await runner.emitBeforeProviderRequest(payload)
                : payload;
            /*PI_BODY_GATE_SCOPE*/if(_model?.provider&&!["openrouter","runinfra","friendli"].includes(_model.provider))return gatePayload;
            let __piSerialized;
            try {
                __piSerialized = JSON.stringify(gatePayload);
            } catch {
                return gatePayload; // unmeasurable — never block on a guard failure
            }
            const __piBytes =
                typeof Buffer !== "undefined"
                    ? Buffer.byteLength(__piSerialized, "utf8")
                    : new TextEncoder().encode(__piSerialized).length;
            if (__piBytes > 3538944) {
                let __piImageBytes = 0;
                let __piImageCount = 0;
                try {
                    const __piScan = (node) => {
                        if (!node || typeof node !== "object") return;
                        if (Array.isArray(node)) {
                            for (const item of node) __piScan(item);
                            return;
                        }
                        // Anthropic blocks use `source:{type:"base64",media_type,data}`
                        // (in the nested `source` object); OpenAI uses `image_url.url:"data:..."`.
                        if (typeof node.url === "string" && node.url.startsWith("data:")) {
                            __piImageBytes += node.url.length;
                            __piImageCount++;
                        } else if (typeof node.data === "string" && (node.media_type?.startsWith("image/") || node.mimeType?.startsWith("image/"))) {
                            __piImageBytes += node.data.length;
                            __piImageCount++;
                        }
                        for (const key of Object.keys(node)) {
                            const value = node[key];
                            if (value !== null && typeof value === "object") __piScan(value);
                        }
                    };
                    const messages = Array.isArray(gatePayload?.messages) ? gatePayload.messages : [];
                    __piScan(messages);
                } catch {
                    /* best-effort breakdown */
                }
                const mb = (bytes) => (bytes / 1048576).toFixed(2);
                const imageMb = mb(Math.min(__piImageBytes, __piBytes));
                const contextBytes = Math.max(0, __piBytes - __piImageBytes);
                throw new Error(
                    "[pi-harness request-body gate] blocked before send: encoded request body ~ " +
                        mb(__piBytes) +
                        ' MB exceeds the local 3.375 MB safety threshold for this route (128 KB below its ~3.5 MB request limit) (a byte limit, separate from the token window; base64 inflates images ~1.3x and resent turns add up). ' +
                        (__piImageCount > 0
                            ? __piImageCount + ' image' + (__piImageCount === 1 ? ' ~ ' : 's ~ ') + imageMb + ' MB (base64), other/context content ~ ' + mb(contextBytes) + ' MB. '
                            : '') +
                        'Send less context or a smaller/fewer image(s), then retry.'
                );
            }
            return gatePayload;
        },
        onResponse: async (response, _model) => {
            const runner = extensionRunnerRef.current;
            if (!runner?.hasHandlers("after_provider_response")) {
                return;
            }
            await runner.emit({
                type: "after_provider_response",
                status: response.status,
                headers: response.headers,
                ...(response.observerAdviceReceipts?.length ? { observerAdviceReceipts: response.observerAdviceReceipts, provider: _model?.provider, model: _model?.id } : {}),
            });
        },
        sessionId: sessionManager.getSessionId(),
        transformContext: async (messages) => {
            const runner = extensionRunnerRef.current;
            if (!runner)
                return messages;
            const requestMessages = guardianRequestMessages(messages);
            const latestRequest = requestMessages.at(-1);
            return runner.emitContext(messages, {
                requestMessages,
                ...(latestRequest ? { requestId: latestRequest.requestId, turnId: latestRequest.turnId, requestMessageIndex: latestRequest.messageIndex } : {}),
            });
        },
        steeringMode: settingsManager.getSteeringMode(),
        followUpMode: settingsManager.getFollowUpMode(),
        transport: settingsManager.getTransport(),
        thinkingBudgets: settingsManager.getThinkingBudgets(),
        maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
    });
    // Restore messages if session has existing data
    if (hasExistingSession) {
        agent.state.messages = existingSession.messages;
        if (!hasThinkingEntry) {
            sessionManager.appendThinkingLevelChange(thinkingLevel);
        }
    }
    else {
        // Save initial model and thinking level for new sessions so they can be restored on resume
        if (model) {
            sessionManager.appendModelChange(model.provider, model.id);
        }
        sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
    const session = new AgentSession({
        agent,
        sessionManager,
        settingsManager,
        cwd,
        scopedModels: options.scopedModels,
        resourceLoader,
        customTools: options.customTools,
        modelRuntime,
        initialActiveToolNames,
        allowedToolNames,
        excludedToolNames,
        extensionRunnerRef,
        sessionStartEvent: options.sessionStartEvent,
    });
    const extensionsResult = resourceLoader.getExtensions();
    return {
        session,
        extensionsResult,
        modelFallbackMessage,
    };
}
