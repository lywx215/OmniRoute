import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExecuteProviderRequestDeps } from "../../open-sse/handlers/chatCore/executeProviderRequest.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-concurrency-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const limits = await import("../../open-sse/services/rateLimitManager.ts");
const gates = await import("../../open-sse/services/accountSemaphore.ts");
const core = await import("../../src/lib/db/core.ts");
const { DEFAULT_RESILIENCE_SETTINGS } = await import("../../src/lib/resilience/settings.ts");
const { executeProviderRequest } =
  await import("../../open-sse/handlers/chatCore/executeProviderRequest.ts");

test.beforeEach(async () => {
  gates.resetAll();
  await limits.__resetRateLimitManagerForTests();
  await limits.applyRequestQueueSettings({
    ...DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    concurrentRequests: 2,
    requestsPerMinute: 1,
    minTimeBetweenRequestsMs: 60_000,
    autoEnableApiKeyProviders: false,
  });
});

test.after(async () => {
  gates.resetAll();
  await limits.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for local execution gate");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

for (const scenario of [
  { name: "limiter default", override: null, credentialMax: null, expected: 2 },
  { name: "limiter override", override: 1, credentialMax: null, expected: 1 },
  { name: "stricter connection cap", override: 3, credentialMax: 1, expected: 1 },
]) {
  test(`daily-only dispatch retains ${scenario.name} through the actual account semaphore`, async () => {
    const connectionId = `daily-cap-${scenario.name}`;
    limits.enableRateLimitProtection(connectionId);
    if (scenario.override !== null)
      limits.refreshConnectionRateLimits(connectionId, { maxConcurrent: scenario.override });
    const credentials = {
      connectionId,
      maxConcurrent: scenario.credentialMax,
      providerSpecificData: { geminiDailyQuota: { enabled: true, disableMinuteLimits: true } },
    };
    const model = "gemini-2.5-flash";
    let enteredGate = 0;
    let started = 0;
    let active = 0;
    let maxActive = 0;
    let releaseExecution = () => {};
    const heldExecution = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const controller = new AbortController();
    const deps: ExecuteProviderRequestDeps = {
      agentGoalPolicy: {} as ExecuteProviderRequestDeps["agentGoalPolicy"],
      assertManagedLeaseFence: () => {},
      buildUpstreamHeadersForExecute: () => ({}),
      clientRawRequest: {},
      clientResponseFormat: null,
      connectionId,
      correlationId: null,
      credentials,
      dedupEnabled: false,
      dedupHash: null,
      effectiveModel: model,
      executor: {
        execute: async () => {
          started++;
          active++;
          maxActive = Math.max(maxActive, active);
          await heldExecution;
          active--;
          return {
            response: new Response("{}", { headers: { "Content-Type": "application/json" } }),
            url: "",
            headers: {},
            transformedBody: {},
          };
        },
      },
      getExecutionCredentials: () => credentials,
      getExecutorClientHeaders: () => ({}),
      isModelScope: () => false,
      isOpencodeClient: false,
      log: null,
      model,
      onCredentialsRefreshed: null,
      pendingScope: { id: null, provider: "gemini", model, connectionId },
      provider: "gemini",
      providerRequestCapture: { capture: () => {}, body: (body) => body },
      rawBody: { contents: [] },
      recordKeyHealthStatus: () => {},
      requestedModel: model,
      resilienceSettings: DEFAULT_RESILIENCE_SETTINGS,
      settings: {},
      skipUpstreamRetry: true,
      stream: false,
      streamController: controller,
      targetFormat: "gemini",
      trace: (label) => {
        if (label === "pre_semaphore") enteredGate++;
      },
      traceId: "local-daily-concurrency",
      translatedBody: { contents: [] },
      trustedEffortContext: {},
      upstreamStream: false,
      userAgent: undefined,
    };
    const results = Array.from({ length: 4 }, () => executeProviderRequest(deps));
    try {
      await until(() => enteredGate === 4 && started >= scenario.expected);
      await new Promise((resolve) => setImmediate(resolve));
      const account = gates.getStats()[`gemini:${connectionId}`];
      assert.equal(account?.maxConcurrency, scenario.expected);
      assert.equal(account?.running, scenario.expected);
      assert.equal(account?.queued, 4 - scenario.expected);
      assert.equal(started, scenario.expected, "queued requests must not reach the executor");
      assert.equal(maxActive, scenario.expected);
    } finally {
      releaseExecution();
      const completed = await Promise.all(results);
      assert.ok(completed.every((result) => result.response.status === 200));
    }
    assert.equal(started, 4, "queued requests resume after the active response releases its slot");
    assert.equal(maxActive, scenario.expected);
    assert.equal(gates.getStats()[`gemini:${connectionId}`]?.running ?? 0, 0);
    assert.deepEqual(
      limits.getAllRateLimitStatus(),
      {},
      "daily mode must not instantiate RPM buckets"
    );
  });
}
