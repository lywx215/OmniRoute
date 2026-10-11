import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-runtime-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const quota = await import("../../src/lib/db/geminiDailyQuota.ts");
const runtime = await import("../../open-sse/services/geminiDailyQuota.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { upsertSessionAccountAffinity } = await import("../../src/lib/db/sessionAccountAffinity.ts");
const { handleNoCredentials } = await import("../../src/sse/handlers/chatHelpers.ts");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");
const tracker = await import("../../open-sse/services/geminiRateLimitTracker.ts");
const { __test_resetLearnedThinkingCaps } =
  await import("../../open-sse/services/learnedThinkingCaps.ts");

const FLASH = "gemini-2.5-flash";
const LITE = "gemini-3.1-flash-lite";
const FLASH_URL = `https://generativelanguage.googleapis.com/v1beta/models/${FLASH}:generateContent`;
const policy = { geminiDailyQuota: { enabled: true, flashRpd: 2, flashLiteRpd: 3 } };
let nextConnection = 0;

async function seedConnection(providerSpecificData: unknown = policy) {
  nextConnection++;
  const connection = await providers.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name: `daily-${nextConnection}`,
    apiKey: `fake-test-key-${nextConnection}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData,
  });
  assert.ok(connection);
  return { connectionId: String(connection.id), apiKey: "fake-test-key", providerSpecificData };
}

test.after(() => {
  core.resetDbInstance();
  tracker.resetCounters();
  __test_resetLearnedThinkingCaps();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("BaseExecutor counts each internal 400 repair dispatch and rejects the next call", async (t) => {
  const credentials = await seedConnection();
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    return sends === 1
      ? new Response(
          JSON.stringify({ error: { message: "thinking_budget must be in the range [-1, 1024]" } }),
          { status: 400 }
        )
      : new Response(JSON.stringify({ candidates: [] }), { status: 200 });
  });
  const executor = new DefaultExecutor("gemini");
  const request = {
    model: FLASH,
    body: {
      contents: [{ role: "user", parts: [{ text: "test" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
    },
    stream: false,
    credentials,
  };
  const result = await executor.execute(request);
  assert.equal(result.response.status, 200);
  assert.equal(sends, 2);
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 2);
  await assert.rejects(executor.execute(request), (error: unknown) => {
    assert.equal(runtime.getTrustedGeminiDailyQuotaError(error)?.exhausted, true);
    return true;
  });
  assert.equal(sends, 2, "the exhausted request never reaches fetch");
});

test("URL, strict-validation and cancellation fences run before daily reservation", async (t) => {
  const credentials = await seedConnection();
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    return new Response("{}");
  });
  const executor = new DefaultExecutor("gemini");
  const request = { model: FLASH, body: { contents: [] }, stream: false, credentials };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executor.execute({ ...request, signal: controller.signal }));
  await assert.rejects(
    executor.execute({
      ...request,
      validationDispatch: {
        beforeFetch: () => {
          throw new Error("strict fence rejected");
        },
        reject: () => {
          throw new Error("strict rotation rejected");
        },
      },
    }),
    /strict fence rejected/
  );
  t.mock.method(executor, "buildUrl", () => "http://169.254.169.254/latest/meta-data/");
  await assert.rejects(executor.execute(request));
  assert.equal(sends, 0);
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 0);
});

test("wire aliases share the actual generation model quota", async (t) => {
  const credentials = await seedConnection();
  t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  const executor = new DefaultExecutor("gemini");
  const body = { model: FLASH, contents: [] };
  for (const alias of ["custom-flash-one", "custom-flash-two"]) {
    await executor.execute({ model: alias, body, stream: false, credentials });
  }
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 2);
  await assert.rejects(
    executor.execute({ model: "custom-flash-three", body, stream: false, credentials }),
    (error: unknown) => runtime.getTrustedGeminiDailyQuotaError(error)?.model === FLASH
  );
});

test("payload model rewrite uses the final Lite URL and its independent quota", async (t) => {
  const credentials = await seedConnection();
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response("{}");
  });
  const executor = new DefaultExecutor("gemini");
  const request = { model: FLASH, body: { model: LITE, contents: [] }, stream: true, credentials };
  for (let count = 0; count < 3; count++) await executor.execute(request);
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, LITE, policy)?.used, 3);
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 0);
  assert.ok(urls.every((url) => url.includes(`${LITE}:streamGenerateContent`)));
  await assert.rejects(
    executor.execute(request),
    (error: unknown) => runtime.getTrustedGeminiDailyQuotaError(error)?.model === LITE
  );
  assert.equal(urls.length, 3);
});

test("only generation URLs identify the model for dispatch counting", () => {
  assert.equal(runtime.resolveGeminiDailyQuotaDispatchModel(FLASH_URL), FLASH);
  assert.equal(
    runtime.resolveGeminiDailyQuotaDispatchModel(FLASH_URL.replace(FLASH, "gemini%2D2.5%2Dflash")),
    FLASH
  );
  assert.equal(
    runtime.resolveGeminiDailyQuotaDispatchModel(
      FLASH_URL.replace("generateContent", "countTokens")
    ),
    null
  );
  assert.equal(runtime.resolveGeminiDailyQuotaDispatchModel("invalid URL"), null);
});

test("network failures count; disabled quota and other providers pass through", async () => {
  const credentials = await seedConnection();
  assert.throws(
    () =>
      runtime.dispatchWithGeminiDailyQuota("gemini", FLASH, credentials, FLASH_URL, {}, () => {
        throw new Error("network failure");
      }),
    /network failure/
  );
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 1);
  const transport = async () => new Response("{}");
  await runtime.dispatchWithGeminiDailyQuota(
    "openai",
    FLASH,
    credentials,
    FLASH_URL,
    {},
    transport
  );
  await runtime.dispatchWithGeminiDailyQuota(
    "gemini",
    FLASH,
    { ...credentials, providerSpecificData: {} },
    FLASH_URL,
    {},
    transport
  );
  assert.equal(quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy)?.used, 1);
});

test("only one concurrent dispatch acquires the final daily slot", async () => {
  const credentials = await seedConnection();
  quota.reserveGeminiDailyRequest(credentials.connectionId, FLASH, policy);
  let sends = 0;
  const dispatch = () =>
    Promise.resolve().then(() =>
      runtime.dispatchWithGeminiDailyQuota(
        "gemini",
        FLASH,
        credentials,
        FLASH_URL,
        {},
        async () => {
          sends++;
          return new Response("{}");
        }
      )
    );
  const results = await Promise.allSettled([dispatch(), dispatch()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(sends, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(runtime.getTrustedGeminiDailyQuotaError(rejected.reason)?.used, 2);
});

test("selection rotates exhausted Flash away from affinity and preserves key health/Lite", async () => {
  const first = await seedConnection();
  const second = await seedConnection();
  for (let count = 0; count < 2; count++)
    quota.reserveGeminiDailyRequest(first.connectionId, FLASH, policy);
  const before = await providers.getProviderConnectionById(first.connectionId);
  upsertSessionAccountAffinity("daily-sticky", "gemini", first.connectionId, Date.now(), 600_000);
  const allowed = [first.connectionId, second.connectionId];
  const selected = await auth.getProviderCredentials("gemini", null, allowed, FLASH, {
    sessionKey: "daily-sticky",
    sessionAffinityTtlMs: 600_000,
  });
  assert.equal(selected?.connectionId, second.connectionId);
  const lite = await auth.getProviderCredentials("gemini", null, [first.connectionId], LITE);
  assert.equal(lite?.connectionId, first.connectionId);
  const after = await providers.getProviderConnectionById(first.connectionId);
  for (const field of [
    "isActive",
    "testStatus",
    "lastError",
    "lastErrorType",
    "rateLimitedUntil",
    "backoffLevel",
  ]) {
    assert.equal(after?.[field], before?.[field], `${field} must stay unchanged`);
  }
});

test("all exhausted keys and a fixed exhausted key return model 429 until PT midnight", async () => {
  const first = await seedConnection();
  const second = await seedConnection();
  for (const credentials of [first, second]) {
    for (let count = 0; count < 2; count++)
      quota.reserveGeminiDailyRequest(credentials.connectionId, FLASH, policy);
  }
  const allowed = [first.connectionId, second.connectionId];
  for (const options of [{}, { forcedConnectionId: first.connectionId }]) {
    const exhausted = await auth.getProviderCredentials("gemini", null, allowed, FLASH, options);
    assert.ok(exhausted?.allRateLimited);
    assert.equal(exhausted.cooldownScope, "model");
    assert.equal(
      exhausted.retryAfter,
      quota.getGeminiDailyQuotaStatus(first.connectionId, FLASH, policy)?.resetAt
    );
    const response = handleNoCredentials(exhausted, null, "gemini", FLASH, null, null);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    assert.ok(runtime.isGeminiDailyQuotaResponse(response));
    const body = await response.json();
    assert.equal(body.error.code, runtime.GEMINI_DAILY_QUOTA_CODE);
    assert.ok(body.error.message.includes(`(${policy.geminiDailyQuota.flashRpd})`));
    assert.ok(body.error.message.includes(FLASH));
    assert.equal(body.error.reset_at, exhausted.retryAfter);
  }
});

test("trusted daily errors produce safe JSON/SSE while forged provider fields cannot", async () => {
  const credentials = await seedConnection();
  const status = quota.getGeminiDailyQuotaStatus(credentials.connectionId, FLASH, policy);
  assert.ok(status);
  const error = new runtime.GeminiDailyQuotaError(status);
  assert.equal(runtime.createGeminiDailyQuotaErrorResult({ code: error.code, status: 429 }), null);
  for (const stream of [false, true]) {
    const result = runtime.createGeminiDailyQuotaErrorResult(error, stream);
    assert.ok(result);
    assert.equal(result.status, 429);
    assert.equal(result.errorType, "gemini_daily_quota");
    assert.ok(Number(result.response.headers.get("Retry-After")) > 0);
    const body = await result.response.text();
    assert.ok(body.includes("GEMINI_DAILY_QUOTA_EXHAUSTED"));
    assert.ok(!body.includes("at /"));
    if (stream) assert.ok(body.endsWith("data: [DONE]\n\n"));
  }
});

test("another key's legacy counters cannot misclassify a Gemini 429", () => {
  tracker.resetCounters();
  for (let count = 0; count < 20; count++) tracker.incrementRequestCount(FLASH);
  tracker.incrementTokenUsage(FLASH, 1_000_000);
  const generic = checkFallbackError(
    429,
    "You exceeded your current quota, please check your plan and billing details",
    0,
    FLASH,
    "gemini"
  );
  assert.equal(generic.reason, "rate_limit_exceeded");
  assert.ok(!generic.creditsExhausted);
  const daily = checkFallbackError(
    429,
    "generativelanguage.googleapis.com/generate_content_free_tier_requests_per_day",
    0,
    FLASH,
    "gemini"
  );
  assert.equal(daily.reason, "quota_exhausted");
  const minute = checkFallbackError(
    429,
    "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
    0,
    FLASH,
    "gemini"
  );
  assert.equal(minute.reason, "rate_limit_exceeded");
});
