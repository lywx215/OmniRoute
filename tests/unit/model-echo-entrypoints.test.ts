import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("model-echo-entrypoints");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const providerRoute =
  await import("../../src/app/api/v1/providers/[provider]/chat/completions/route.ts");
const aliasesDb = await import("../../src/lib/db/models/aliases.ts");
const { invalidateAliasCache } = await import("../../src/lib/modelAliasResolver.ts");

const UPSTREAM_MODEL = "gpt-4o-mini";

test.beforeEach(async () => {
  await harness.resetStorage();
  invalidateAliasCache();
  await harness.settingsDb.updateSettings({ echoRequestedModelName: true });
  await harness.seedConnection("openai");
});

test.after(async () => {
  invalidateAliasCache();
  await harness.cleanup();
});

function captureUpstream() {
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return harness.buildOpenAIResponse("ok", UPSTREAM_MODEL);
  };
  return calls;
}

test("Chat route keeps the model captured before its database alias rewrite", async () => {
  const originalModel = "entrypoint-original-model";
  await aliasesDb.setModelAlias(originalModel, `openai/${UPSTREAM_MODEL}`);
  invalidateAliasCache();
  const calls = captureUpstream();
  const response = await chatRoute.POST(
    harness.buildRequest({
      body: {
        model: originalModel,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      headers: { "X-OmniRoute-No-Cache": "true" },
    })
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, originalModel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, UPSTREAM_MODEL);
  assert.equal("originalRequestedModel" in calls[0], false);
});

test("provider-scoped route keeps a bare model captured before adding its prefix", async () => {
  const calls = captureUpstream();
  const response = await providerRoute.POST(
    harness.buildRequest({
      url: "http://localhost/v1/providers/openai/chat/completions",
      body: {
        model: UPSTREAM_MODEL,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      headers: { "X-OmniRoute-No-Cache": "true" },
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, UPSTREAM_MODEL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, UPSTREAM_MODEL);
});
