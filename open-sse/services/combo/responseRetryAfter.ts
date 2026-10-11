import { parseRetryAfterHeader, readProseRetryAfter } from "../../utils/error.ts";
import type { ComboErrorBody, ComboRetryAfter } from "./types.ts";

/** Canonical instant for both nested local reset fields and upstream retry hints. */
export function readComboRetryHint(
  response: Response,
  body: ComboErrorBody,
  text: string
): ComboRetryAfter | null {
  const error = body?.error && typeof body.error === "object" ? body.error : null;
  const retry = error?.retry_after;
  const resetSeconds = error?.reset_seconds;
  return (
    body?.retryAfter ||
    error?.reset_at ||
    (typeof retry === "number" && retry > 0
      ? new Date(Date.now() + retry * 1000).toISOString()
      : retry) ||
    (typeof resetSeconds === "number" && resetSeconds > 0
      ? new Date(Date.now() + resetSeconds * 1000).toISOString()
      : null) ||
    readProseRetryAfter(text) ||
    parseRetryAfterHeader(response.headers)
  );
}
