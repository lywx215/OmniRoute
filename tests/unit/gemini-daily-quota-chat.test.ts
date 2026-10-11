import assert from "node:assert/strict";
import test from "node:test";
import type { BaseExecutor as Executor, ExecuteInput } from "../../open-sse/executors/base.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const harness = await createChatPipelineHarness("gemini-daily-quota-chat");
const { BaseExecutor, buildGeminiResponse, buildRequest, handleChat, seedConnection } = harness;
const quota = await import("../../src/lib/db/geminiDailyQuota.ts");
const providers = await import("../../src/lib/db/providers.ts");
const payloadRules = await import("../../open-sse/services/payloadRules.ts");
const affinity = await import("../../src/lib/db/sessionAccountAffinity.ts");
const { extractSessionAffinityKey } = await import("../../src/sse/services/auth.ts");
const FLASH = "gemini-2.5-flash";
const LITE = "gemini-3.1-flash-lite";
const policy = { geminiDailyQuota: { enabled: true } };
const healthFields = [
  "isActive",
  "testStatus",
  "lastError",
  "lastErrorType",
  "rateLimitedUntil",
  "backoffLevel",
];

function exhaust(connectionId: string) {
  for (let count = 0; count < 20; count++) {
    assert.ok(quota.reserveGeminiDailyRequest(connectionId, FLASH, policy).allowed);
  }
}

function rewriteModel(requested: string, actual: string) {
  payloadRules.setPayloadRulesConfig({
    override: [{ models: [{ name: requested, protocol: "gemini" }], params: { model: actual } }],
  });
}

function requestBody(model: string, stream = false) {
  return {
    model: `gemini/${model}`,
    stream,
    messages: [{ role: "user", content: "daily quota routing test" }],
  };
}

test.beforeEach(async () => {
  await harness.resetStorage();
  payloadRules.resetPayloadRulesConfigForTests();
  await harness.settingsDb.updateSettings({
    requestRetry: 0,
    requestDedupEnabled: false,
    sessionAffinityTtlMs: 600_000,
  });
});

test.afterEach(() => payloadRules.resetPayloadRulesConfigForTests());
test.after(async () => harness.cleanup());

test("an exhausted Flash remains selectable when a payload rule rewrites it to Lite", async (t) => {
  const connection = await seedConnection("gemini", { providerSpecificData: policy });
  exhaust(connection.id);
  const before = await providers.getProviderConnectionById(connection.id);
  rewriteModel(FLASH, LITE);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    sends++;
    assert.ok(url.includes(`/models/${LITE}:generateContent`));
    return buildGeminiResponse("Lite is still available", LITE);
  });
  const response = await handleChat(buildRequest({ body: requestBody(FLASH) }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(sends, 1);
  assert.equal(quota.getGeminiDailyQuotaStatus(connection.id, FLASH, policy)?.used, 20);
  assert.equal(quota.getGeminiDailyQuotaStatus(connection.id, LITE, policy)?.used, 1);
  assert.equal(quota.getGeminiDailyQuotaStatus(connection.id, LITE, policy)?.limit, 500);
  const after = await providers.getProviderConnectionById(connection.id);
  for (const field of healthFields) assert.equal(after?.[field], before?.[field], field);
});

test("an alias exhausting the actual Flash model rotates its affinity to the next key", async (t) => {
  const first = await seedConnection("gemini", {
    name: "alias-first",
    priority: 1,
    providerSpecificData: policy,
  });
  const second = await seedConnection("gemini", {
    name: "alias-second",
    priority: 2,
    providerSpecificData: policy,
  });
  exhaust(first.id);
  rewriteModel("custom-flash-alias", FLASH);
  const body = requestBody("custom-flash-alias");
  const request = buildRequest({ body });
  const sessionKey = extractSessionAffinityKey(body, request.headers);
  assert.ok(sessionKey);
  affinity.upsertSessionAccountAffinity(sessionKey, "gemini", first.id, Date.now(), 600_000);
  const before = await providers.getProviderConnectionById(first.id);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    sends++;
    assert.ok(url.includes(`/models/${FLASH}:generateContent`));
    return buildGeminiResponse();
  });
  const response = await handleChat(request);
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), second.id);
  assert.equal(sends, 1, "the exhausted alias never reaches transport");
  assert.equal(quota.getGeminiDailyQuotaStatus(first.id, FLASH, policy)?.used, 20);
  assert.equal(quota.getGeminiDailyQuotaStatus(second.id, FLASH, policy)?.used, 1);
  assert.equal(
    affinity.getSessionAccountAffinity(sessionKey, "gemini", 600_000)?.connectionId,
    second.id
  );
  const after = await providers.getProviderConnectionById(first.id);
  for (const field of healthFields) assert.equal(after?.[field], before?.[field], field);
});

test("a reservation race after selection retries another key without changing key health", async (t) => {
  const first = await seedConnection("gemini", {
    name: "race-first",
    priority: 1,
    providerSpecificData: policy,
  });
  const second = await seedConnection("gemini", {
    name: "race-second",
    priority: 2,
    providerSpecificData: policy,
  });
  const before = await providers.getProviderConnectionById(first.id);
  const originalExecute = BaseExecutor.prototype.execute;
  let raceInjected = false;
  t.mock.method(BaseExecutor.prototype, "execute", function (this: Executor, input: ExecuteInput) {
    if (input.credentials.connectionId === first.id && !raceInjected) {
      raceInjected = true;
      exhaust(first.id);
    }
    return originalExecute.call(this, input);
  });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    return buildGeminiResponse();
  });
  const response = await handleChat(buildRequest({ body: requestBody(FLASH) }));
  assert.equal(response.status, 200, await response.text());
  assert.ok(raceInjected);
  assert.equal(sends, 1);
  assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), second.id);
  const after = await providers.getProviderConnectionById(first.id);
  for (const field of healthFields) assert.equal(after?.[field], before?.[field], field);
});

test("all actual-model exhausted aliases preserve JSON/SSE reset hints and explicit pins", async (t) => {
  const first = await seedConnection("gemini", {
    name: "exhausted-first",
    priority: 1,
    providerSpecificData: policy,
  });
  const second = await seedConnection("gemini", {
    name: "exhausted-second",
    priority: 2,
    providerSpecificData: policy,
  });
  exhaust(first.id);
  exhaust(second.id);
  rewriteModel("custom-flash-alias", FLASH);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    throw new Error("unexpected model call");
  });
  for (const stream of [false, true]) {
    for (const pinned of [false, true]) {
      const response = await handleChat(
        buildRequest({
          body: requestBody("custom-flash-alias", stream),
          headers: pinned ? { "X-OmniRoute-Connection": first.id } : {},
        })
      );
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get("Retry-After")) > 0);
      const text = await response.text();
      assert.ok(text.includes("GEMINI_DAILY_QUOTA_EXHAUSTED"), text);
      assert.ok(
        text.includes(
          quota.getGeminiDailyQuotaStatus(first.id, FLASH, policy)?.resetAt ?? "missing reset"
        )
      );
      if (pinned)
        assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), first.id);
      if (stream) assert.ok(text.endsWith("data: [DONE]\n\n"));
    }
  }
  assert.equal(sends, 0);
});
