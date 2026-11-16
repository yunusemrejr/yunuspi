/**
 * Ids a vendor still answers to but no longer lists, mapped to the id it lists.
 * Consulted only when a provider/id lookup misses, so a saved route (a team role,
 * a default model, a restored session, --model) keeps resolving.
 */
const VENDOR_ALIASES = {
    deepseek: {
        "deepseek-v4-flash": "deepseek-flash",
        "deepseek-v4-flash-vision-exp": "deepseek-flash",
    },
};
export function vendorModelAlias(providerId, modelId) {
    const aliases = Object.hasOwn(VENDOR_ALIASES, providerId) ? VENDOR_ALIASES[providerId] : undefined;
    return aliases && Object.hasOwn(aliases, modelId) ? aliases[modelId] : undefined;
}
