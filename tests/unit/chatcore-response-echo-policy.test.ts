import test from "node:test";
import assert from "node:assert/strict";
import { resolveResponseEchoModel } from "../../open-sse/handlers/chatCore/responseEchoPolicy.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";

const base = {
  clientRequestedModel: "Gemini/Gemini-2.5-Pro",
  requestedModel: "gemini/gemini-flash-lite-latest",
  provider: "gemini",
  echoRequestedModelName: false,
};

test("explicit echo preserves the exact source spelling and outranks no-auth normalization", () => {
  assert.equal(
    resolveResponseEchoModel({ ...base, echoRequestedModelName: true }),
    base.clientRequestedModel
  );
  assert.equal(
    resolveResponseEchoModel({
      ...base,
      provider: "opencode",
      requestedModel: "big-pickle",
      echoRequestedModelName: true,
    }),
    base.clientRequestedModel
  );
});

test("ordinary clients with echo disabled retain backend presentation", () => {
  assert.equal(resolveResponseEchoModel(base), null);
  assert.equal(resolveResponseEchoModel({ ...base, echoRequestedModelName: "true" }), null);
});

test("Codex and Claude Code compatibility preserve the original alias with global echo off", () => {
  assert.equal(
    resolveResponseEchoModel({ ...base, isCodexResponsesEcho: true }),
    base.clientRequestedModel
  );
  assert.equal(
    resolveResponseEchoModel({ ...base, isClaudeCodeClient: true }),
    base.clientRequestedModel
  );
});

test("no-auth listing compatibility uses the existing working model rule when exact echo is off", () => {
  assert.equal(
    resolveResponseEchoModel({ ...base, requestedModel: "big-pickle", provider: "opencode" }),
    `${REGISTRY.opencode.alias}/big-pickle`
  );
  assert.equal(
    resolveResponseEchoModel({
      ...base,
      requestedModel: "opencode/big-pickle",
      provider: "opencode",
    }),
    null
  );
});
