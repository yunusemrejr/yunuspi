export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export function clampOpenAIPromptCacheKey(key) {
    if (key === undefined)
        return undefined;
    const chars = Array.from(key);
    if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
        return key;
    return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/** Protocol-specific cache fields require an exact official host or explicit compat. */
export function isOpenAIEndpoint(baseUrl) {
    try {
        const url = new URL(baseUrl);
        return url.protocol === "https:" && ["api.openai.com", "us.api.openai.com", "eu.api.openai.com"].includes(url.hostname);
    } catch { return false; }
}
