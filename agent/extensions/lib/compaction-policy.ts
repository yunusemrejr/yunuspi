/** Owned compaction policy helpers. Folded from the retired compaction-early
 *  transform so live extensions never import scripts/compatibility. */

/** Full model window only; output/tail sizing cannot advance this threshold. */
export function automaticCompactionThreshold(
  contextTokens: number,
  contextWindow: number,
  _settings?: unknown,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Infinity;
  return Math.ceil(contextWindow * 0.8);
}

/** Preserve useful recent work while leaving room for a summary and continuation. */
export function compactionSettingsForWindow<
  T extends { reserveTokens?: number; keepRecentTokens?: number },
>(contextWindow: number, settings: T): T {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return settings;
  const budget = contextWindow;
  const reserve =
    Number.isFinite(settings.reserveTokens) && (settings.reserveTokens as number) > 0
      ? (settings.reserveTokens as number)
      : 16384;
  const recent =
    Number.isFinite(settings.keepRecentTokens) && (settings.keepRecentTokens as number) >= 0
      ? (settings.keepRecentTokens as number)
      : 20000;
  return {
    ...settings,
    reserveTokens: Math.min(reserve, Math.max(128, Math.floor(budget / 8))),
    keepRecentTokens: Math.min(recent, Math.max(256, Math.floor(budget / 8))),
  };
}
