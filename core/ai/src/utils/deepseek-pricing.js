const OFFICIAL_ORIGIN = "https://api.deepseek.com";
const FLASH_RATE = Object.freeze({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
const PRO_RATE = Object.freeze({ input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });
const PRO_FLASH_RATE_START = Date.parse("2026-09-14T04:00:00Z");
// First observation of the restored Pro price. Retained history has its own rates.
const PRO_RESTORED_OBSERVED_AT = Date.parse("2026-11-10T00:00:00Z");
const FLASH_IDS = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
const BASE_BUCKETS = ["input", "output", "cacheRead", "cacheWrite"];
const BILLED_WEB_METERS = new Set(["tool_search", "tool_fetch", "tool_image_search"]);
const WEB_PRICE_PER_CALL = 0.75 / 1000;
// https://api-docs.deepseek.com/quick_start/pricing/
// State Council schedules, in China Standard Time. Weekend make-up workdays
// remain off-peak because the rate schedule specifies Monday through Friday.
// https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html
// https://english.www.gov.cn/policies/latestreleases/202611/06/content_WS6aed74dcc6d00ca5f9a0e22e.html
const HOLIDAYS_BY_YEAR = new Map([
    [2026, [[101, 103], [215, 223], [404, 406], [501, 505], [619, 621], [925, 927], [1001, 1007]]],
    [2027, [[101, 103], [205, 213], [403, 405], [501, 505], [609, 609], [915, 915], [1001, 1007]]],
]);

export function isDirectDeepSeek(model) {
    if (model.provider !== "deepseek") return false;
    try { return new URL(model.baseUrl).origin === OFFICIAL_ORIGIN; }
    catch { return false; }
}

export function providerCreatedMs(value) {
    return Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000 ? value * 1_000 : undefined;
}

export function deepSeekPublishedPeakRate(id, at) {
    if (id === "deepseek-v4-pro") {
        return at >= PRO_FLASH_RATE_START && at < PRO_RESTORED_OBSERVED_AT ? FLASH_RATE : PRO_RATE;
    }
    return FLASH_IDS.has(id) ? FLASH_RATE : undefined;
}

function weekdayPricing(at) {
    const date = new Date(at);
    const day = date.getUTCDay(), hour = date.getUTCHours();
    if (day === 0 || day === 6 || hour < 1 || (hour >= 4 && hour < 6) || hour >= 10) return "off-peak";
    const chinaDate = new Date(at + 8 * 60 * 60 * 1000);
    const holidays = HOLIDAYS_BY_YEAR.get(chinaDate.getUTCFullYear());
    if (!holidays) return "unknown";
    const monthDay = (chinaDate.getUTCMonth() + 1) * 100 + chinaDate.getUTCDate();
    return holidays.some(([first, last]) => monthDay >= first && monthDay <= last) ? "off-peak" : "peak";
}

/** Apply direct API rates to an already normalized usage record. */
export function applyDeepSeekPricing(model, usage, reportedUsage, at, partial = false) {
    if (!isDirectDeepSeek(model)) return;
    const rate = deepSeekPublishedPeakRate(model.id, at);
    const cost = usage.cost;
    if (rate && !model.cost?.tiers?.length && BASE_BUCKETS.every(key => model.cost?.[key] === rate[key])) {
        const period = weekdayPricing(at);
        const factor = period === "peak" ? 1 : 0.5;
        for (const key of BASE_BUCKETS) {
            cost[key] *= factor;
            cost.rates[key] *= factor;
        }
        cost.total *= factor;
        cost.priceBasis = `deepseek-${period}-2026-11-16`;
        if (period === "unknown") cost.complete = false;
    }
    const meters = reportedUsage?.server_tool_use;
    if (meters !== undefined) {
        if (meters === null || typeof meters !== "object" || Array.isArray(meters)) {
            cost.complete = false;
        }
        else {
            const web = {};
            for (const [key, value] of Object.entries(meters)) {
                if (!key.startsWith("tool_")) continue;
                if (BILLED_WEB_METERS.has(key) && Number.isSafeInteger(value) && value >= 0) web[key] = value;
                else if (value !== 0) cost.complete = false;
            }
            const fee = Object.values(web).reduce((sum, count) => sum + count * WEB_PRICE_PER_CALL, 0);
            cost.serverToolUse = web;
            cost.serverToolCost = fee;
            cost.total += fee;
        }
    }
    if (partial) cost.complete = false;
}
