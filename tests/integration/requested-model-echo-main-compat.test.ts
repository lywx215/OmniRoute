import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const h = await createChatPipelineHarness("requested-model-echo-main-compat");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const quota = await import("../../src/lib/db/geminiDailyQuota.ts");
const { getPendingById } = await import("../../src/lib/usage/usageHistory.ts");
const { DEFAULT_DEDUP_CONFIG, getInflightCount } =
  await import("../../open-sse/services/requestDedup.ts");
const { resetPayloadRulesConfigForTests } = await import("../../open-sse/services/payloadRules.ts");

const ORIGINAL = "gemini-2.5-pro";
const SECOND_ALIAS = "gemini-pro-alias-b";
const TARGET = "gemini-flash-lite-latest";
const POLICY = {
  geminiDailyQuota: { enabled: true, flashRpd: 2, flashLiteRpd: 2, disableMinuteLimits: true },
};
type UpstreamCall = { url: string; body: Record<string, unknown>; apiKey: string | null };
let calls: UpstreamCall[] = [];

beforeEach(async () => {
  await h.resetStorage();
  resetPayloadRulesConfigForTests();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  calls = [];
  await h.settingsDb.updateSettings({
    echoRequestedModelName: true,
    modelAliases: { [ORIGINAL]: TARGET, [SECOND_ALIAS]: TARGET },
    semanticCacheEnabled: false,
    requestRetry: 0,
    maxRetryIntervalSec: 0,
    call_log_pipeline_enabled: true,
    sessionAffinityTtlMs: 600_000,
  });
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      apiKey: headers.get("x-goog-api-key"),
    });
    assert.equal(new URL(String(url)).hostname, "generativelanguage.googleapis.com");
    assert.match(String(url), /\/models\/gemini-flash-lite-latest:generateContent$/);
    return h.buildGeminiResponse("main compatibility reply", TARGET);
  };
});

after(async () => {
  resetPayloadRulesConfigForTests();
  await h.cleanup();
});

function request(model = ORIGINAL, headers: Record<string, string> = {}) {
  return h.buildRequest({
    body: {
      model,
      stream: false,
      temperature: 0,
      messages: [{ role: "user", content: "Main daily quota and original-name echo" }],
    },
    headers: { "x-omniroute-no-memory": "true", ...headers },
  });
}

async function assertEcho(response: Response, original = ORIGINAL) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-omniroute-model"), TARGET);
  const json = await response.json();
  assert.equal(json.model, original);
  assert.equal(json.choices[0].message.content, "main compatibility reply");
}

function assertOnlyLiteUsage(connectionId: string, used: number, policy = POLICY) {
  const projection = quota.getGeminiDailyQuotaProjection(connectionId, policy);
  assert.deepEqual(
    projection.models.map((entry) => ({ model: entry.model, used: entry.used })),
    [{ model: TARGET, used }]
  );
  assert.equal(quota.getGeminiDailyQuotaStatus(connectionId, ORIGINAL, policy), null);
  assert.equal(quota.getGeminiDailyQuotaStatus(connectionId, "gemini-2.5-flash", policy)?.used, 0);
}

async function successfulLogs(count: number) {
  const rows = await h.waitFor(async () => {
    await h.callLogsDb.waitForCallLogSaves(1000);
    const entries = await h.callLogsDb.getCallLogs({ limit: 10 });
    const successful = entries.filter(
      (entry: { status: number; model: string }) => entry.status === 200 && entry.model === TARGET
    );
    return successful.length === count ? successful : null;
  }, 10_000);
  assert.ok(rows, "each client request should keep its own successful log row");
  return rows;
}

test("main daily quota counts only Lite when a Pro alias echoes the original client name", async () => {
  const connection = await h.seedConnection("gemini", { providerSpecificData: POLICY });
  await assertEcho(await chatRoute.POST(request()));
  assert.equal(calls.length, 1);
  assertOnlyLiteUsage(connection.id, 1);
  const [row] = await successfulLogs(1);
  assert.equal(row.requestedModel, ORIGINAL);
  assert.equal(row.model, TARGET);
  const detail = await h.callLogsDb.getCallLogById(row.id);
  const pipeline = detail?.pipelinePayloads as {
    clientRawRequest?: { body?: { model?: string } };
    clientResponse?: { model?: string };
  };
  assert.equal(pipeline.clientRawRequest?.body?.model, ORIGINAL);
  assert.equal(pipeline.clientResponse?.model, ORIGINAL);
});

test("main cache serves two aliases of the same Lite request while reserving daily quota once", async () => {
  const connection = await h.seedConnection("gemini", { providerSpecificData: POLICY });
  await h.settingsDb.updateSettings({ semanticCacheEnabled: true });
  await assertEcho(await chatRoute.POST(request()));
  const hit = await chatRoute.POST(request(SECOND_ALIAS));
  assert.equal(hit.headers.get("x-omniroute-cache"), "HIT");
  assert.equal(hit.headers.get("x-omniroute-response-cost"), "0.0000000000");
  await assertEcho(hit, SECOND_ALIAS);
  assert.equal(calls.length, 1, "cache reuse must not dispatch another Google request");
  assertOnlyLiteUsage(connection.id, 1);
  const rows = await successfulLogs(2);
  assert.deepEqual(
    new Set(rows.map((row) => row.requestedModel)),
    new Set([ORIGINAL, SECOND_ALIAS])
  );
  assert.ok(rows.every((row) => row.model === TARGET));
});

test("main exhausted Lite quota rotates the key and still echoes the Pro alias", async () => {
  const policy = { geminiDailyQuota: { ...POLICY.geminiDailyQuota, flashLiteRpd: 1 } };
  const first = await h.seedConnection("gemini", {
    name: "daily-echo-first",
    apiKey: "fake-daily-echo-first",
    priority: 1,
    providerSpecificData: policy,
  });
  const second = await h.seedConnection("gemini", {
    name: "daily-echo-second",
    apiKey: "fake-daily-echo-second",
    priority: 2,
    providerSpecificData: policy,
  });
  assert.ok(quota.reserveGeminiDailyRequest(first.id, TARGET, policy).allowed);
  const response = await chatRoute.POST(request());
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), second.id);
  await assertEcho(response);
  assert.equal(calls.length, 1, "the locally exhausted key must never reach Google");
  assert.equal(calls[0].apiKey, "fake-daily-echo-second");
  assertOnlyLiteUsage(first.id, 1, policy);
  assertOnlyLiteUsage(second.id, 1, policy);
});

test("main in-flight dedup gives concurrent Lite aliases independent echoed model names", async () => {
  const previousConfig = { ...DEFAULT_DEDUP_CONFIG };
  // Gemini keeps temperature inside generationConfig after translation. Enable the
  // existing dedup path explicitly; its default temperature eligibility is unchanged.
  DEFAULT_DEDUP_CONFIG.enabled = true;
  DEFAULT_DEDUP_CONFIG.maxTemperatureForDedup = 1;
  try {
    const connection = await h.seedConnection("gemini", { providerSpecificData: POLICY });
    const originalFetch = globalThis.fetch;
    let releaseFetch = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    globalThis.fetch = async (url, init) => {
      await fetchGate;
      return originalFetch(url, init);
    };
    const pendingResponses = Promise.all([
      chatRoute.POST(request(ORIGINAL)),
      chatRoute.POST(request(SECOND_ALIAS)),
    ]);
    let bothRegistered: boolean | null = null;
    try {
      bothRegistered = await h.waitFor(
        () => getPendingById().size === 2 && getInflightCount() === 1,
        5000
      );
      // Let the second request pass translation and join the held upstream promise.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      releaseFetch();
    }
    const [first, second] = await pendingResponses;
    assert.ok(bothRegistered, "both clients should join the same in-flight execution");
    await assertEcho(first, ORIGINAL);
    await assertEcho(second, SECOND_ALIAS);
    assert.equal(calls.length, 1, "main dedup should share one actual Google request");
    assertOnlyLiteUsage(connection.id, 1);
    const rows = await successfulLogs(2);
    assert.deepEqual(
      new Set(rows.map((row) => row.requestedModel)),
      new Set([ORIGINAL, SECOND_ALIAS])
    );
    for (const row of rows) {
      const detail = await h.callLogsDb.getCallLogById(row.id);
      const clientResponse = (detail?.pipelinePayloads as { clientResponse?: { model?: string } })
        ?.clientResponse;
      assert.equal(clientResponse?.model, row.requestedModel);
    }
  } finally {
    Object.assign(DEFAULT_DEDUP_CONFIG, previousConfig);
  }
});
