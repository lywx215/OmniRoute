import { inheritGeminiDailyQuotaResponse } from "@omniroute/open-sse/services/geminiDailyQuota.ts";
import { inheritTrustedLocalRateLimitResponse } from "@omniroute/open-sse/services/rateLimitManager/errors.ts";
import { inheritProviderProbeResponse } from "@/shared/utils/providerProbeResult";

/** Header wrappers must preserve trusted local refusal identity when they allocate a copy. */
export function inheritChatResponseIdentity(source: Response, target: Response): Response {
  return inheritGeminiDailyQuotaResponse(
    source,
    inheritTrustedLocalRateLimitResponse(source, target)
  );
}

export function withSelectedConnectionHeader(
  response: Response,
  connectionId: string | null | undefined
): Response {
  if (!response || !connectionId) return response;
  try {
    response.headers.set("X-OmniRoute-Selected-Connection-Id", connectionId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-OmniRoute-Selected-Connection-Id", connectionId);
    const trusted = inheritChatResponseIdentity(response, cloned);
    return inheritProviderProbeResponse(response, trusted);
  }
}
