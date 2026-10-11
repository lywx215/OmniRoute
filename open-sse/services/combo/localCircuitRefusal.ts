import { recordComboRequest } from "../comboMetrics.ts";
import { classifyComboOutcome, type ComboErrorEntry } from "./comboErrorAggregation.ts";
import { isProviderCircuitOpenResult, toRecordedTarget } from "./comboPredicates.ts";
import type { ResolvedComboTarget } from "./types.ts";
import {
  GEMINI_DAILY_QUOTA_CODE,
  GEMINI_DAILY_QUOTA_ERROR_TYPE,
  inheritGeminiDailyQuotaResponse,
  isGeminiDailyQuotaResponse,
} from "../geminiDailyQuota.ts";
import { recordQuotaExhaustionClassification } from "./quotaExhaustion.ts";
import { buildErrorBody, unavailableResponse } from "../../utils/error.ts";
import type { ComboRetryAfter } from "./types.ts";

const dailyOutcomes = new WeakMap<ComboErrorEntry, Response>();

export function isLocalTargetRefusal(response: Response, errorText: string): boolean {
  return isGeminiDailyQuotaResponse(response) || isProviderCircuitOpenResult(response, errorText);
}

/** Record a local refusal as one attempted combo leg, without upstream health effects. */
export function recordLocalTargetRefusal(args: {
  comboName: string;
  modelStr: string;
  result: Response;
  errorText: string;
  startTime: number;
  fallbackCount: number;
  strategy: string;
  target: ResolvedComboTarget;
}): { error: string; status: number; outcome: ComboErrorEntry } {
  const error = args.errorText || String(args.result.status);
  const dailyQuota = isGeminiDailyQuotaResponse(args.result);
  if (dailyQuota) recordQuotaExhaustionClassification(args.result, true);
  recordComboRequest(args.comboName, args.modelStr, {
    success: false,
    latencyMs: Date.now() - args.startTime,
    fallbackCount: args.fallbackCount,
    strategy: args.strategy,
    target: toRecordedTarget(args.target),
  });
  const outcome: ComboErrorEntry = {
    model: args.modelStr,
    status: args.result.status,
    error,
    kind: classifyComboOutcome(args.result.status, args.errorText),
    ...(dailyQuota ? { code: GEMINI_DAILY_QUOTA_CODE } : {}),
  };
  if (dailyQuota) dailyOutcomes.set(outcome, args.result);
  return {
    error,
    status: args.result.status,
    outcome,
  };
}

/** Only actual locally branded outcomes may confer daily-quota trust on an aggregate. */
export function localQuotaUnavailableResponse(
  status: number,
  message: string,
  retryAfter: ComboRetryAfter,
  retryHuman: string,
  outcomes: readonly ComboErrorEntry[]
): Response {
  if (
    status !== 429 ||
    !outcomes.length ||
    !outcomes.every((outcome) => dailyOutcomes.has(outcome))
  ) {
    return unavailableResponse(status, message, retryAfter, retryHuman);
  }
  const body = buildErrorBody(status, `${message} (${retryHuman})`, undefined, {
    code: GEMINI_DAILY_QUOTA_CODE,
    type: GEMINI_DAILY_QUOTA_ERROR_TYPE,
    retryAfter,
  });
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(body.error.retry_after ?? 1),
      "Cache-Control": "no-cache, no-transform",
    },
  });
  return inheritGeminiDailyQuotaResponse(dailyOutcomes.get(outcomes[0])!, response);
}
