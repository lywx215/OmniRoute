import test from "node:test";
import assert from "node:assert/strict";

const { applyFingerprint, stripInternalBodyFields } =
  await import("../../open-sse/config/cliFingerprints.ts");

test("pre-executor cleanup rejects forged context while retaining executor directives", () => {
  const body = {
    model: "gpt-4o-mini",
    _nativeCodexPassthrough: true,
    originalRequestedModel: "forged",
    clientRequestedModel: "forged",
    requestContext: { originalRequestedModel: "forged" },
  };
  stripInternalBodyFields(body, { keepExecutorMarkers: true });
  assert.deepEqual(body, { model: "gpt-4o-mini", _nativeCodexPassthrough: true });
});

test("the wire boundary strips model metadata only at the request root", () => {
  const toolArguments = {
    originalRequestedModel: "tool-original",
    clientRequestedModel: "tool-client",
    requestContext: "tool-context",
  };
  const originalBody = {
    model: "gpt-4o-mini",
    originalRequestedModel: "forged-original",
    clientRequestedModel: "forged-client",
    requestContext: { originalRequestedModel: "forged-context" },
    tools: [{ type: "function", function: { name: "inspect", parameters: toolArguments } }],
    customField: "keep",
  };
  const body = structuredClone(originalBody);
  stripInternalBodyFields(body);
  const wire = JSON.parse(applyFingerprint("openai", {}, body).bodyString);
  for (const field of ["originalRequestedModel", "clientRequestedModel", "requestContext"]) {
    assert.equal(Object.hasOwn(wire, field), false);
  }
  assert.equal(wire.customField, "keep");
  assert.deepEqual(wire.tools[0].function.parameters, toolArguments);
  assert.equal(originalBody.originalRequestedModel, "forged-original");
  assert.equal(originalBody.clientRequestedModel, "forged-client");
  assert.deepEqual(originalBody.requestContext, { originalRequestedModel: "forged-context" });
});

test("Codex CLI fingerprint orders prompt_cache_key before include", () => {
  const body = {
    model: "gpt-5.5-low",
    stream: true,
    input: [{ role: "user", content: "hello" }],
    instructions: "You are Codex.",
    store: false,
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "conv-codex",
    service_tier: "priority",
  };

  const result = applyFingerprint("codex", {}, body);
  const orderedKeys = Object.keys(JSON.parse(result.bodyString));

  assert.deepEqual(orderedKeys.slice(0, 10), [
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "tools",
    "tool_choice",
    "include",
  ]);
});
