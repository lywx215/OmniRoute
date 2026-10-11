/** Per-connection opt-in daily request policy for Gemini text Flash models. */
export interface GeminiDailyQuotaPolicy {
  enabled: boolean;
  flashRpd: number;
  flashLiteRpd: number;
  disableMinuteLimits: boolean;
}

export const GEMINI_DAILY_QUOTA_TIME_ZONE = "America/Los_Angeles";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveRequestLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveGeminiDailyQuotaPolicy(
  providerSpecificData: unknown
): GeminiDailyQuotaPolicy {
  const settings = asRecord(asRecord(providerSpecificData).geminiDailyQuota);
  return {
    enabled: settings.enabled === true,
    flashRpd: positiveRequestLimit(settings.flashRpd, 20),
    flashLiteRpd: positiveRequestLimit(settings.flashLiteRpd, 500),
    disableMinuteLimits: settings.disableMinuteLimits !== false,
  };
}

/** Strip transport prefixes, while keeping exact version/preview model IDs separate. */
export function normalizeGeminiDailyQuotaModel(model: string): string {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:models|gemini)\/)+/, "");
}

export function getGeminiDailyModelLimit(
  model: string,
  providerSpecificData: unknown
): number | null {
  const policy = resolveGeminiDailyQuotaPolicy(providerSpecificData);
  if (!policy.enabled) return null;
  const normalized = normalizeGeminiDailyQuotaModel(model);
  if (!normalized.startsWith("gemini-")) return null;
  // Output-image, speech/live, Pro and embedding models have different quota families.
  const segments = normalized.split("-");
  if (
    segments.some((part) => ["image", "tts", "live", "audio", "pro", "embedding"].includes(part))
  ) {
    return null;
  }
  const flashIndex = segments.indexOf("flash");
  if (flashIndex === -1) return null;
  return segments[flashIndex + 1] === "lite" ? policy.flashLiteRpd : policy.flashRpd;
}

export function shouldBypassGeminiMinuteLimits(
  provider: string,
  providerSpecificData: unknown
): boolean {
  const policy = resolveGeminiDailyQuotaPolicy(providerSpecificData);
  return provider === "gemini" && policy.enabled && policy.disableMinuteLimits;
}
