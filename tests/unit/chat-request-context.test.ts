import test from "node:test";
import assert from "node:assert/strict";

import { captureChatRequestContext } from "../../src/sse/handlers/chat/requestContext.ts";

test("captures the original model without normalizing its spelling", () => {
  const body = { model: " Gemini/gemini-2.5-pro " };
  const context = captureChatRequestContext(body);
  body.model = "gemini/gemini-flash-lite-latest";
  assert.equal(context.originalRequestedModel, " Gemini/gemini-2.5-pro ");
});

test("only captures a non-blank model string", () => {
  for (const model of [undefined, null, "", "   ", 42, [], {}]) {
    assert.deepEqual(captureChatRequestContext({ model }), {});
  }
  for (const body of [undefined, null, "model", 42, []]) {
    assert.deepEqual(captureChatRequestContext(body), {});
  }
});

test("does not accept client-supplied internal context fields", () => {
  assert.deepEqual(
    captureChatRequestContext({
      model: "gemini-2.5-pro",
      originalRequestedModel: "spoofed",
      _omnirouteRequestContext: { originalRequestedModel: "also-spoofed" },
    }),
    { originalRequestedModel: "gemini-2.5-pro" }
  );
});

test("capture does not enumerate or clone the request body", () => {
  const body = new Proxy(
    { model: "gemini-2.5-pro" },
    {
      ownKeys() {
        throw new Error("request context must only read the model scalar");
      },
    }
  );
  assert.equal(captureChatRequestContext(body).originalRequestedModel, "gemini-2.5-pro");
});

test("prepares a working copy and strips client-supplied internal fields", async () => {
  const { prepareChatRequest } = await import("../../src/sse/handlers/chat/requestContext.ts");
  const body = {
    model: "gemini/gemini-flash-lite-latest",
    messages: [{ role: "user", content: "hello" }],
    originalRequestedModel: "spoofed",
    clientRequestedModel: "spoofed",
    requestContext: { originalRequestedModel: "spoofed" },
    _omnirouteReasoningRule: { enabled: true },
    _omnirouteReasoningRouteTrace: "spoofed",
    _omniroutePreviousResponseResumed: true,
  };
  const prepared = prepareChatRequest(body, {
    originalRequestedModel: " Gemini-2.5-Pro ",
  });
  assert.equal(prepared.originalRequestedModel, " Gemini-2.5-Pro ");
  assert.notEqual(prepared.body, body);
  assert.deepEqual(prepared.body, { model: body.model, messages: body.messages });
  assert.equal(body.originalRequestedModel, "spoofed");
});

test("preparation falls back to the body model for blank trusted context", async () => {
  const { prepareChatRequest } = await import("../../src/sse/handlers/chat/requestContext.ts");
  assert.equal(
    prepareChatRequest({ model: "gemini-2.5-pro" }, { originalRequestedModel: "  " })
      .originalRequestedModel,
    "gemini-2.5-pro"
  );
  assert.deepEqual(prepareChatRequest(null), { body: null, originalRequestedModel: undefined });
});
