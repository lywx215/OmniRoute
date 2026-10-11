import type { ConnectionRateLimitOverrides } from "@/lib/db/providers/columns";
import { MODEL_CONCURRENCY_MAX_CAP } from "@/shared/constants/modelConcurrency";
import {
  formatModelConcurrencyInput,
  parseModelConcurrencyInput,
} from "@/lib/providers/modelConcurrency";

export interface RateLimitOverridesFormFields {
  rpm: string;
  rpd: string;
  tpm: string;
  tpd: string;
  minTime: string;
  maxWaitMs: string;
  rateLimitMaxConcurrent: string;
  modelConcurrency: string;
}

const NUMERIC_FIELDS = ["rpm", "rpd", "tpm", "tpd", "minTime", "maxWaitMs"] as const;

/** Restores blank fields for inherited limits and explicit values for connection overrides. */
export function getRateLimitOverridesFormValues(
  overrides?: ConnectionRateLimitOverrides | null
): RateLimitOverridesFormFields {
  const numeric = Object.fromEntries(
    NUMERIC_FIELDS.map((key) => [key, overrides?.[key] != null ? String(overrides[key]) : ""])
  ) as Pick<RateLimitOverridesFormFields, (typeof NUMERIC_FIELDS)[number]>;
  return {
    ...numeric,
    rateLimitMaxConcurrent: overrides?.maxConcurrent != null ? String(overrides.maxConcurrent) : "",
    modelConcurrency: modelConcurrencyFormValue(overrides),
  };
}

/**
 * Builds the `rateLimitOverrides` payload from the edit form. Per-model caps
 * (`model=cap`, one per line): blank = no caps; a malformed entry is returned
 * in `invalidModelConcurrency` (the ICU values for the localized save error)
 * so operator intent is never silently dropped on save. `existing` carries
 * over overrides the form has no field for (`executionMaxWaitMs`, set via the
 * API) so a dashboard save keeps them.
 */
export function buildRateLimitOverridesFromForm(
  form: RateLimitOverridesFormFields,
  existing?: ConnectionRateLimitOverrides | null
): {
  overrides: ConnectionRateLimitOverrides | null;
  invalidModelConcurrency?: { entry: string; max: number };
} {
  const overrides: ConnectionRateLimitOverrides = {};
  for (const key of NUMERIC_FIELDS) {
    if (form[key].trim()) overrides[key] = Number(form[key]);
  }
  if (form.rateLimitMaxConcurrent.trim())
    overrides.maxConcurrent = Number(form.rateLimitMaxConcurrent);
  if (typeof existing?.executionMaxWaitMs === "number")
    overrides.executionMaxWaitMs = existing.executionMaxWaitMs;
  const parsed = parseModelConcurrencyInput(form.modelConcurrency);
  if (parsed.invalidEntry !== null)
    return {
      overrides: null,
      invalidModelConcurrency: { entry: parsed.invalidEntry, max: MODEL_CONCURRENCY_MAX_CAP },
    };
  if (parsed.map) overrides.modelConcurrency = parsed.map;
  return { overrides: Object.keys(overrides).length > 0 ? overrides : null };
}

/** Form value for the stored per-model caps; written back on save so API-configured caps survive edits. */
export function modelConcurrencyFormValue(
  overrides: ConnectionRateLimitOverrides | null | undefined
): string {
  return formatModelConcurrencyInput(overrides?.modelConcurrency);
}
