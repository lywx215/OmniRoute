import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-rate-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";

const limits = await import("../../open-sse/services/rateLimitManager.ts");
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const { DEFAULT_RESILIENCE_SETTINGS } = await import("../../src/lib/resilience/settings.ts");
const { bypassTargetMinuteQuota, resolveTargetTokenLimit } =
  await import("../../open-sse/services/combo/targetTokenLimit.ts");
const { recordProviderQuotaUsage } = await import("../../src/lib/quota/providerQuotaState.ts");
const { canAffordRequest } = await import("../../src/lib/quota/quotaScheduler.ts");

const psd = { geminiDailyQuota: { enabled: true, disableMinuteLimits: true } };

test.beforeEach(async () => {
  await limits.__resetRateLimitManagerForTests();
  await limits.applyRequestQueueSettings({
    ...DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    requestsPerMinute: 1,
    minTimeBetweenRequestsMs: 60_000,
    concurrentRequests: 3,
  });
});

test.after(async () => {
  await limits.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("daily-only mode dispatches without consuming RPM, learned caps or pacing", async () => {
  const connectionId = "daily-only-key";
  limits.enableRateLimitProtection(connectionId);
  limits.refreshConnectionRateLimits(connectionId, { rpm: 1, minTime: 60_000 });
  let calls = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        limits.withRateLimit(
          "gemini",
          connectionId,
          "gemini-3-flash-preview",
          async () => ++calls,
          controller.signal,
          undefined,
          undefined,
          { providerSpecificData: psd }
        )
      )
    );
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(calls, 3);
    assert.deepEqual(limits.getAllRateLimitStatus(), {});
  } finally {
    clearTimeout(timeout);
  }
});

test("daily-only mode preserves the connection concurrency ceiling and abort", async () => {
  limits.enableRateLimitProtection("key");
  assert.equal(limits.getRateLimitConcurrency("key"), 3);
  limits.refreshConnectionRateLimits("key", { maxConcurrent: 2 });
  assert.equal(limits.getRateLimitConcurrency("key"), 2);
  limits.disableRateLimitProtection("key");
  assert.equal(limits.getRateLimitConcurrency("key"), null);
  limits.enableRateLimitProtection("key");
  const controller = new AbortController();
  controller.abort(new Error("Cancelled before dispatch"));
  let called = false;
  await assert.rejects(
    limits.withRateLimit(
      "gemini",
      "key",
      "gemini-3-flash-preview",
      async () => {
        called = true;
      },
      controller.signal,
      undefined,
      undefined,
      { providerSpecificData: psd }
    ),
    /Cancelled before dispatch/
  );
  assert.equal(called, false);
});

test("daily-only Gemini bypasses a configured combo TPM ledger; other connections retain it", async () => {
  const connection = await providers.createProviderConnection({
    provider: "gemini",
    name: "Gemini daily only",
    authType: "apikey",
    apiKey: "test-daily-only",
    providerSpecificData: psd,
    isActive: false,
    rateLimitOverrides: { tpm: 1 },
  });
  const model = "gemini/gemini-3-flash-preview";
  recordProviderQuotaUsage(connection.id, model, 1, { tokenLimit: 1 });
  assert.equal(canAffordRequest(connection.id, model, {}).affordable, false);
  assert.equal(await bypassTargetMinuteQuota(connection.id), true);
  assert.equal(await resolveTargetTokenLimit({ connectionId: connection.id }), undefined);
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: { geminiDailyQuota: { enabled: true, disableMinuteLimits: false } },
  });
  assert.equal(await bypassTargetMinuteQuota(connection.id), false);
  assert.equal(await resolveTargetTokenLimit({ connectionId: connection.id }), 1);
});
