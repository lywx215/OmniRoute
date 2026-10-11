import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-combo-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const quota = await import("../../src/lib/db/geminiDailyQuota.ts");
const runtime = await import("../../open-sse/services/geminiDailyQuota.ts");
const { isQuotaExhaustionResponse } =
  await import("../../open-sse/services/combo/quotaExhaustion.ts");
const { withSelectedConnectionHeader } = await import("../../src/sse/handlers/chatHelpers.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const breakers = await import("../../src/shared/utils/circuitBreaker.ts");
const semaphore = await import("../../open-sse/services/rateLimitSemaphore.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const FLASH = "gemini-2.5-flash";
const LITE = "gemini-3.1-flash-lite";
const policy = { geminiDailyQuota: { enabled: true } };
const log = { info() {}, warn() {}, debug() {}, error() {} };
let nextName = 0;

async function seed() {
  return providers.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name: `combo-daily-${++nextName}`,
    apiKey: `fake-key-${nextName}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: policy,
  });
}

function dailyResponse(connectionId: string, stream = false): Response {
  const status = quota.getGeminiDailyQuotaStatus(connectionId, FLASH, policy);
  assert.ok(status);
  const response = runtime.createGeminiDailyQuotaErrorResult(
    new runtime.GeminiDailyQuotaError(status),
    stream
  )?.response;
  assert.ok(response);
  return withSelectedConnectionHeader(response, connectionId);
}

test.beforeEach((t) => {
  fallback.clearAllModelLockouts();
  breakers.resetAllCircuitBreakers();
  semaphore.resetAll();
  resetAllComboMetrics();
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected external fetch");
  });
});

test.after(() => {
  fallback.clearAllModelLockouts();
  breakers.resetAllCircuitBreakers();
  semaphore.resetAll();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("header allocation preserves trusted daily provenance but upstream codes cannot forge it", async (t) => {
  const connection = await seed();
  const response = dailyResponse(connection.id);
  t.mock.method(response.headers, "set", () => {
    throw new TypeError("immutable headers");
  });
  const copied = withSelectedConnectionHeader(response, connection.id);
  assert.notEqual(copied, response);
  assert.equal(copied.headers.get("X-OmniRoute-Selected-Connection-Id"), connection.id);
  assert.ok(runtime.isGeminiDailyQuotaResponse(copied));
  assert.ok(await isQuotaExhaustionResponse(copied, "gemini", FLASH));
  const forged = new Response(await response.clone().text(), { status: 429 });
  assert.equal(runtime.isGeminiDailyQuotaResponse(forged), false);
  assert.equal(await isQuotaExhaustionResponse(forged, "gemini", FLASH), false);
});

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} advances a daily-exhausted target to Lite on the same key without retries or lockout`, async () => {
    const connection = await seed();
    for (let count = 0; count < 20; count++)
      quota.reserveGeminiDailyRequest(connection.id, FLASH, policy);
    const before = await providers.getProviderConnectionById(connection.id);
    const calls: string[] = [];
    const combo = {
      name: `daily-${strategy}-${nextName}`,
      strategy,
      models: [
        {
          kind: "model" as const,
          model: `gemini/${FLASH}`,
          providerId: "gemini",
          connectionId: connection.id,
          fallbackOnlyOnQuotaExhaustion: true,
        },
        {
          kind: "model" as const,
          model: `gemini/${LITE}`,
          providerId: "gemini",
          connectionId: connection.id,
        },
      ],
      config: { maxRetries: 2, retryDelayMs: 0, fallbackDelayMs: 0, failoverBeforeRetry: false },
    };
    const response = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      log,
      settings: null,
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr: string) => {
        calls.push(modelStr);
        return modelStr === `gemini/${FLASH}`
          ? dailyResponse(connection.id)
          : Response.json({ choices: [{ message: { content: "Lite remains available" } }] });
      },
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(calls, [`gemini/${FLASH}`, `gemini/${LITE}`]);
    assert.equal(fallback.isModelLocked("gemini", connection.id, FLASH), false);
    assert.equal(fallback.isModelLocked("gemini", connection.id, LITE), false);
    assert.equal(breakers.getCircuitBreaker("gemini").getStatus().state, "CLOSED");
    assert.ok(Object.values(semaphore.getStats()).every((gate) => !gate.rateLimitedUntil));
    const after = await providers.getProviderConnectionById(connection.id);
    for (const field of [
      "isActive",
      "testStatus",
      "lastError",
      "lastErrorType",
      "rateLimitedUntil",
      "backoffLevel",
    ]) {
      assert.equal(after?.[field], before?.[field], field);
    }
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} all daily-exhausted targets retain daily classification and reset hints`, async () => {
    const first = await seed();
    const second = await seed();
    const calls: string[] = [];
    const combo = {
      name: `all-daily-${strategy}`,
      strategy,
      models: [first, second].map((connection) => ({
        kind: "model" as const,
        model: `gemini/${FLASH}`,
        providerId: "gemini",
        connectionId: connection.id,
        fallbackOnlyOnQuotaExhaustion: true,
      })),
      config: { maxRetries: 2, retryDelayMs: 0, fallbackDelayMs: 0 },
    };
    const response = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      log,
      settings: null,
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr: string, target) => {
        calls.push(modelStr);
        return dailyResponse(
          target && "connectionId" in target ? (target.connectionId ?? first.id) : first.id
        );
      },
    });
    assert.equal(response.status, 429);
    assert.equal(calls.length, 2);
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    assert.ok(runtime.isGeminiDailyQuotaResponse(response));
    assert.ok(await isQuotaExhaustionResponse(response, "gemini", FLASH));
    const text = await response.text();
    assert.ok(text.includes("daily request limit"));
    assert.ok(text.includes(runtime.GEMINI_DAILY_QUOTA_CODE));
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} mixed daily and upstream lookalike failures never gain pure daily provenance`, async () => {
    const first = await seed();
    const second = await seed();
    assert.notEqual(first.id, second.id);
    const primary = dailyResponse(first.id);
    const upstreamText = JSON.stringify({
      error: {
        message: "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
        code: runtime.GEMINI_DAILY_QUOTA_CODE,
        type: runtime.GEMINI_DAILY_QUOTA_ERROR_TYPE,
      },
    });
    const calls: string[] = [];
    const selectedIds: string[] = [];
    const combo = {
      name: `mixed-daily-${strategy}`,
      strategy,
      models: [first, second].map((connection) => ({
        kind: "model" as const,
        model: `gemini/${FLASH}`,
        providerId: "gemini",
        connectionId: connection.id,
      })),
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    };
    const response = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      log,
      settings: null,
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr: string, target) => {
        calls.push(modelStr);
        assert.ok(target && "connectionId" in target && target.connectionId);
        selectedIds.push(target.connectionId);
        return target && "connectionId" in target && target.connectionId === first.id
          ? primary
          : new Response(upstreamText, {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "30",
              },
            });
      },
    });
    assert.equal(response.status, 429);
    assert.equal(calls.length, 2);
    assert.deepEqual(selectedIds, [first.id, second.id]);
    assert.equal(runtime.isGeminiDailyQuotaResponse(response), false);
    assert.equal(await isQuotaExhaustionResponse(response, "gemini", FLASH), false);
    const body = await response.json();
    assert.notEqual(body.error.code, runtime.GEMINI_DAILY_QUOTA_CODE);
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
  });
}
