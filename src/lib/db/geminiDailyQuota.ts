import { nextDailyResetAtMs } from "../../../open-sse/services/dailyQuotaReset";
import {
  GEMINI_DAILY_QUOTA_TIME_ZONE,
  getGeminiDailyModelLimit,
  normalizeGeminiDailyQuotaModel,
  resolveGeminiDailyQuotaPolicy,
  type GeminiDailyQuotaPolicy,
} from "../../shared/utils/geminiDailyQuota";
import { getDbInstance } from "./core";

export interface GeminiDailyQuotaStatus {
  model: string;
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  day: string;
  resetAt: string;
}

export interface GeminiDailyQuotaProjection extends GeminiDailyQuotaPolicy {
  timeZone: "America/Los_Angeles";
  day: string;
  resetAt: string;
  models: GeminiDailyQuotaStatus[];
}

interface DailyRequestRow {
  model: string;
  request_count: number;
}

const pacificDayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: GEMINI_DAILY_QUOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getDailyClock(nowMs: number): { day: string; resetAt: string } {
  const parts: Record<string, string> = {};
  for (const part of pacificDayFormatter.formatToParts(new Date(nowMs))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    resetAt: new Date(nextDailyResetAtMs(GEMINI_DAILY_QUOTA_TIME_ZONE, 0, nowMs)).toISOString(),
  };
}

function buildStatus(
  model: string,
  used: number,
  limit: number,
  clock: { day: string; resetAt: string }
): GeminiDailyQuotaStatus {
  return {
    model,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: used >= limit,
    ...clock,
  };
}

/** Advisory read for account selection; dispatch must still reserve atomically. */
export function getGeminiDailyQuotaStatus(
  connectionId: string,
  model: string,
  providerSpecificData: unknown,
  nowMs = Date.now()
): GeminiDailyQuotaStatus | null {
  const limit = getGeminiDailyModelLimit(model, providerSpecificData);
  if (limit === null) return null;
  const normalizedModel = normalizeGeminiDailyQuotaModel(model);
  const clock = getDailyClock(nowMs);
  const row = getDbInstance()
    .prepare(
      `SELECT request_count FROM gemini_daily_request_counts
       WHERE connection_id = ? AND model = ? AND quota_day = ?`
    )
    .get(connectionId, normalizedModel, clock.day) as DailyRequestRow | undefined;
  return buildStatus(normalizedModel, row?.request_count ?? 0, limit, clock);
}

/**
 * Claim one request immediately before upstream dispatch. SQLite's single capped
 * UPSERT prevents two processes from both claiming the final slot. Requests are
 * counted once attempted, including errors; ambiguous network outcomes are not refunded.
 */
export function reserveGeminiDailyRequest(
  connectionId: string,
  model: string,
  providerSpecificData: unknown,
  nowMs = Date.now()
): { allowed: boolean; status: GeminiDailyQuotaStatus | null } {
  const limit = getGeminiDailyModelLimit(model, providerSpecificData);
  if (limit === null) return { allowed: true, status: null };
  const normalizedModel = normalizeGeminiDailyQuotaModel(model);
  const clock = getDailyClock(nowMs);
  const db = getDbInstance();
  const result = db
    .prepare(
      `INSERT INTO gemini_daily_request_counts
         (connection_id, model, quota_day, request_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(connection_id, model, quota_day) DO UPDATE SET
         request_count = gemini_daily_request_counts.request_count + 1,
         updated_at = excluded.updated_at
       WHERE gemini_daily_request_counts.request_count < ?`
    )
    .run(connectionId, normalizedModel, clock.day, nowMs, limit);
  const row = db
    .prepare(
      `SELECT request_count FROM gemini_daily_request_counts
       WHERE connection_id = ? AND model = ? AND quota_day = ?`
    )
    .get(connectionId, normalizedModel, clock.day) as DailyRequestRow;
  return {
    allowed: result.changes === 1,
    status: buildStatus(normalizedModel, row.request_count, limit, clock),
  };
}

/** Today's observed model usage plus the connection's configured family limits. */
export function getGeminiDailyQuotaProjection(
  connectionId: string,
  providerSpecificData: unknown,
  nowMs = Date.now()
): GeminiDailyQuotaProjection {
  const policy = resolveGeminiDailyQuotaPolicy(providerSpecificData);
  const clock = getDailyClock(nowMs);
  const models: GeminiDailyQuotaStatus[] = [];
  if (policy.enabled) {
    const rows = getDbInstance()
      .prepare(
        `SELECT model, request_count FROM gemini_daily_request_counts
         WHERE connection_id = ? AND quota_day = ? ORDER BY model`
      )
      .all(connectionId, clock.day) as DailyRequestRow[];
    for (const row of rows) {
      const limit = getGeminiDailyModelLimit(row.model, providerSpecificData);
      if (limit !== null) models.push(buildStatus(row.model, row.request_count, limit, clock));
    }
  }
  return {
    ...policy,
    timeZone: GEMINI_DAILY_QUOTA_TIME_ZONE,
    ...clock,
    models,
  };
}
