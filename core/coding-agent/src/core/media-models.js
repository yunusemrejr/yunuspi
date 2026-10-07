/** Media choices share SettingsManager, but never participate in LLM cycling.
 * Catalog reads are public, bounded and lazy; opening /models cannot generate
 * media or spend credits. Provider descriptions are guidance, not quality tests. */
export const MEDIA_KINDS = ["image", "video", "speech", "music", "sfx"];
export const MEDIA_CATALOG_API = "https://openrouter.ai/api/v1";
const cache = new Map();
const TTL = 300_000;

export function normalizeMediaModels(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const kind of MEDIA_KINDS) {
        const id = value[kind];
        if (typeof id === "string" && id.length <= 200 && /^(?:openrouter|openai-compatible|elevenlabs|local)\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) result[kind] = id;
    }
    return result;
}

export function builtinMediaModels() {
    const row = (kind, id, name, description) => ({ kind, id, name, description, source: "bundled", configured: undefined });
    return [
        row("image", "openrouter/auto", "Automatic image choice", "Match reference, alpha, aspect and resolution capabilities, then choose within the explicit cost limit. Preview uses a bounded single image."),
        row("video", "local/native", "Native motion graphics", "Use video_project, video_browser and video_shot for precise typography, 3D, browser demonstrations and editing. No generation API charge."),
        row("video", "openrouter/auto", "Automatic video choice", "Choose a compatible clip model within the per-job cost limit. Native composition is preferable for exact text and interaction."),
        row("speech", "local/piper", "Piper local speech", "Local narration with estimated word timing. Free API usage; use alignment when exact spoken cues are required."),
        ...[["eleven_flash_v2_5", "Flash v2.5", "Fast economical speech"], ["eleven_multilingual_v2", "Multilingual v2", "Long-form speech"], ["eleven_v3", "Eleven v3", "Expressive performance"]].map(([id, name, purpose]) => row("speech", `elevenlabs/${id}`, name, `${purpose}; private ElevenLabs credentials required. Measured provider word timings; no paid retry.`)),
        row("music", "local/procedural", "Local arranged music", "Seeded, editable instruments and rhythmic cues via audio_synth. No generation API charge."),
        ...["music_v2", "music_v2_5"].map(id => row("music", `elevenlabs/${id}`, id, "Prompt-directed music; private ElevenLabs credentials required. Generate short sections and reuse accepted takes.")),
        row("sfx", "local/procedural", "Local sound design", "Seeded whoosh, impact, tick, pop and chime via audio_synth. No generation API charge."),
        row("sfx", "elevenlabs/eleven_text_to_sound_v2", "ElevenLabs Sound v2", "Prompt-directed sound effects; private ElevenLabs credentials required. Duration and loop intent are explicit."),
    ];
}

export async function mediaCatalogJson(endpoint, { signal, fetchImpl = fetch, refresh = false } = {}) {
    signal?.throwIfAborted();
    if (!/^\/(?:images|videos)\/models(?:\/[a-zA-Z0-9._/-]+\/endpoints)?$/.test(endpoint)) throw Error("Invalid media catalog endpoint");
    const hit = cache.get(endpoint);
    if (fetchImpl === fetch && !refresh && hit && Date.now() - hit.time < TTL) return structuredClone(hit.data);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    bounded.throwIfAborted();
    const response = await fetchImpl(MEDIA_CATALOG_API + endpoint, { signal: bounded, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Media catalog returned HTTP ${response.status}`); }
    const limit = 2 * 1024 * 1024;
    if (!response.body || Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw Error("Media catalog exceeds 2 MiB or has no body"); }
    const reader = response.body.getReader();
    let bytes = 0; const chunks = [];
    const abort = () => { void reader.cancel().catch(() => {}); };
    bounded.addEventListener("abort", abort, { once: true });
    try {
        for (;;) {
            bounded.throwIfAborted();
            const part = await reader.read();
            bounded.throwIfAborted();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > limit) throw Error("Media catalog exceeds 2 MiB");
            chunks.push(part.value);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (fetchImpl === fetch) cache.set(endpoint, { time: Date.now(), data });
        return structuredClone(data);
    } finally {
        bounded.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {}); reader.releaseLock();
    }
}

export async function fetchMediaModels(kind, options = {}) {
    if (!["image", "video"].includes(kind)) return builtinMediaModels().filter(row => row.kind === kind);
    const body = await mediaCatalogJson(kind === "image" ? "/images/models" : "/videos/models", options);
    if (!Array.isArray(body.data) || body.data.length > 1000) throw Error("Media catalog returned an invalid model list");
    return body.data.filter(model => typeof model.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/.test(model.id)).map(model => ({
        kind, id: `openrouter/${model.id}`, name: String(model.name ?? model.id).slice(0, 160),
        description: String(model.description ?? "").slice(0, 800), source: "live catalog", capabilities: model,
    }));
}
