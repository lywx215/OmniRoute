/** Trusted request metadata, separate from the mutable body sent through routing. */
export type ChatRequestContext = {
  readonly originalRequestedModel?: string;
};

/** Capture only the model scalar before aliases, prefixes or routing can rewrite it. */
export function captureChatRequestContext(body: unknown): ChatRequestContext {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" && model.trim().length > 0
    ? { originalRequestedModel: model }
    : {};
}

/** Preserve trusted presentation metadata while making the existing working-body copy. */
export function prepareChatRequest(body: unknown, context?: ChatRequestContext) {
  const originalRequestedModel =
    captureChatRequestContext({ model: context?.originalRequestedModel }).originalRequestedModel ??
    captureChatRequestContext(body).originalRequestedModel;
  let workingBody = body;
  if (body && typeof body === "object") {
    const copy = { ...body } as Record<string, unknown>;
    // Only server policy and function context may supply these internal fields.
    delete copy._omnirouteReasoningRule;
    delete copy._omnirouteReasoningRouteTrace;
    delete copy._omniroutePreviousResponseResumed;
    delete copy.originalRequestedModel;
    delete copy.clientRequestedModel;
    delete copy.requestContext;
    workingBody = copy;
  }
  return { body: workingBody, originalRequestedModel };
}
