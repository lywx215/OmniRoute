import {
  getGeminiDailyQuotaStatus,
  reserveGeminiDailyRequest,
  type GeminiDailyQuotaStatus,
} from "@/lib/db/geminiDailyQuota";
import { evictSessionAccountAffinityForConnection } from "@/lib/db/sessionAccountAffinity";
import { buildErrorBody } from "../utils/error.ts";
import { getPayloadRulesConfig } from "./payloadRules.ts";

export const GEMINI_DAILY_QUOTA_CODE = "GEMINI_DAILY_QUOTA_EXHAUSTED";
export const GEMINI_DAILY_QUOTA_ERROR_TYPE = "gemini_daily_quota";

const dailyQuotaErrors = new WeakMap<object, GeminiDailyQuotaStatus>();
const dailyQuotaResponses = new WeakSet<Response>();

function dailyQuotaMessage(status: GeminiDailyQuotaStatus): string {
  return `Gemini daily request limit (${status.limit}) reached for ${status.model}. Resets at ${status.resetAt}.`;
}

export class GeminiDailyQuotaError extends Error {
  readonly code = GEMINI_DAILY_QUOTA_CODE;
  readonly status = 429;

  constructor(status: GeminiDailyQuotaStatus) {
    super(dailyQuotaMessage(status));
    this.name = "GeminiDailyQuotaError";
    dailyQuotaErrors.set(this, status);
  }
}

export function getTrustedGeminiDailyQuotaError(error: unknown): GeminiDailyQuotaStatus | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  return dailyQuotaErrors.get(error as object) ?? null;
}

export function isGeminiDailyQuotaResponse(response: Response): boolean {
  return dailyQuotaResponses.has(response);
}

export function inheritGeminiDailyQuotaResponse(original: Response, copy: Response): Response {
  if (isGeminiDailyQuotaResponse(original)) dailyQuotaResponses.add(copy);
  return copy;
}

export function clearGeminiDailyQuotaAffinity(
  sessionKey: string | null | undefined,
  provider: string,
  connectionId: string
): void {
  if (!sessionKey) return;
  try {
    evictSessionAccountAffinityForConnection(sessionKey, provider, connectionId);
  } catch {
    // The current request also excludes this connection; affinity eviction is best-effort.
  }
}

type DispatchCredentials = {
  connectionId?: string;
  providerSpecificData?: unknown;
};
type FetchTransport = (url: string, options: RequestInit) => Promise<Response>;

/** The final generation URL is authoritative after aliases and payload model overrides. */
export function resolveGeminiDailyQuotaDispatchModel(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(
      /\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Called after URL/identity validation, directly before the synchronous transport start. */
export function dispatchWithGeminiDailyQuota(
  provider: string,
  _model: string,
  credentials: DispatchCredentials,
  url: string,
  options: RequestInit,
  transport: FetchTransport
): Promise<Response> {
  options.signal?.throwIfAborted();
  const model = provider === "gemini" ? resolveGeminiDailyQuotaDispatchModel(url) : null;
  if (model && credentials.connectionId) {
    const reservation = reserveGeminiDailyRequest(
      credentials.connectionId,
      model,
      credentials.providerSpecificData
    );
    if (!reservation.allowed && reservation.status) {
      throw new GeminiDailyQuotaError(reservation.status);
    }
  }
  // No awaited work may separate the capped SQLite reservation from fetch.
  return transport(url, options);
}

export async function readGeminiDailyQuotaStatuses(
  provider: string,
  model: string | null,
  connections: readonly { id: string; providerSpecificData?: unknown }[],
  now = Date.now()
): Promise<Map<string, GeminiDailyQuotaStatus>> {
  const statuses = new Map<string, GeminiDailyQuotaStatus>();
  if (provider !== "gemini" || !model) return statuses;
  for (const connection of connections) {
    const status = getGeminiDailyQuotaStatus(
      connection.id,
      model,
      connection.providerSpecificData,
      now
    );
    if (status) statuses.set(connection.id, status);
  }
  if (statuses.size > 0) {
    // Selection lacks the prepared request body. A model mutation can turn an exhausted
    // Flash into a fresh Lite, so defer to the hard dispatch guard whenever it is possible.
    try {
      const rules = await getPayloadRulesConfig();
      const modelPath = (path: string) =>
        path
          .split(".")
          .map((part) => part.trim())
          .filter(Boolean)[0] === "model";
      const mutations = [...rules.default, ...rules.defaultRaw, ...rules.override];
      if (
        mutations.some((rule) => Object.keys(rule.params).some(modelPath)) ||
        rules.filter.some((rule) => rule.params.some(modelPath))
      )
        statuses.clear();
    } catch {
      statuses.clear(); // An uncertain wire model must never cause advisory rejection.
    }
  }
  return statuses;
}

/** Preserve local provenance when account selection can reject every eligible key early. */
export function createGeminiDailyQuotaCredentialRefusal(
  statuses: ReadonlyMap<string, GeminiDailyQuotaStatus>,
  connections: readonly { id: string }[]
) {
  if (
    !connections.length ||
    !connections.every((connection) => statuses.get(connection.id)?.exhausted)
  )
    return null;
  const status = statuses.get(connections[0].id)!;
  const refusal = {
    allRateLimited: true as const,
    retryAfter: status.resetAt,
    retryAfterHuman: `reset at ${status.resetAt}`,
    lastError: dailyQuotaMessage(status),
    lastErrorCode: 429,
    cooldownScope: "model" as const,
    cooldownModel: status.model,
    connectionsCount: connections.length,
  };
  dailyQuotaErrors.set(refusal, status);
  return refusal;
}

/** Public JSON/SSE error; upstream text cannot forge the trusted local error identity. */
export function createGeminiDailyQuotaErrorResult(error: unknown, stream = false) {
  const quota = getTrustedGeminiDailyQuotaError(error);
  if (!quota) return null;
  const message = dailyQuotaMessage(quota);
  const retryAfter = Math.max(1, Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1000));
  const body = buildErrorBody(429, message, undefined, {
    code: GEMINI_DAILY_QUOTA_CODE,
    type: GEMINI_DAILY_QUOTA_ERROR_TYPE,
    retryAfter: quota.resetAt,
  });
  const response = new Response(
    stream ? `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n` : JSON.stringify(body),
    {
      status: 429,
      headers: {
        "Content-Type": stream ? "text/event-stream" : "application/json",
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-cache, no-transform",
      },
    }
  );
  dailyQuotaResponses.add(response);
  return {
    success: false as const,
    status: 429,
    error: message,
    errorCode: GEMINI_DAILY_QUOTA_CODE,
    errorType: GEMINI_DAILY_QUOTA_ERROR_TYPE,
    response,
  };
}
