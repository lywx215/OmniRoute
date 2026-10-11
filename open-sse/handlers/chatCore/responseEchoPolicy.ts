import { resolveNoAuthEchoModel } from "./noAuthEchoModel.ts";

/** Resolve presentation only; never use this value for execution, policies or cache keys. */
export function resolveResponseEchoModel({
  clientRequestedModel,
  requestedModel,
  provider,
  echoRequestedModelName,
  isCodexResponsesEcho = false,
  isClaudeCodeClient = false,
}: {
  clientRequestedModel: string;
  requestedModel: string;
  provider: string | null | undefined;
  echoRequestedModelName: unknown;
  isCodexResponsesEcho?: boolean;
  isClaudeCodeClient?: boolean;
}): string | null {
  if (
    (echoRequestedModelName === true || isCodexResponsesEcho || isClaudeCodeClient) &&
    clientRequestedModel
  ) {
    return clientRequestedModel;
  }
  // When exact echo is disabled, retain the existing no-auth listing-valid rule.
  return resolveNoAuthEchoModel(requestedModel, provider);
}
