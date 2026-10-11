import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("requested-model-echo-fallbacks");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const { getUsageHistory } = await import("../../src/lib/usage/usageHistory.ts");
const { calculateCost } = await import("../../src/lib/usage/costCalculator.ts");
const { formatOmniRouteCost } = await import("../../src/domain/omnirouteResponseMeta.ts");
const { resetEmergencyFallbackEnvCache } =
  await import("../../open-sse/services/emergencyFallback.ts");

const ORIGINAL = "gemini-2.5-pro";
const TARGET = "gemini-flash-lite-latest";
type UpstreamCall = { url: string; body: Record<string, unknown> };
let calls: UpstreamCall[] = [];
const previousEmergencyEnv = process.env.OMNIROUTE_EMERGENCY_FALLBACK;

beforeEach(async () => {
  await h.resetStorage();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  calls = [];
  process.env.OMNIROUTE_EMERGENCY_FALLBACK = "true";
  resetEmergencyFallbackEnvCache();
  await h.seedConnection("gemini");
  await h.settingsDb.updateSettings({
    echoRequestedModelName: true,
    requestRetry: 0,
    maxRetryIntervalSec: 0,
    semanticCacheEnabled: false,
    call_log_pipeline_enabled: true,
  });
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return h.buildGeminiResponse("routed reply", TARGET);
  };
});

after(async () => {
  if (previousEmergencyEnv === undefined) delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  else process.env.OMNIROUTE_EMERGENCY_FALLBACK = previousEmergencyEnv;
  resetEmergencyFallbackEnvCache();
  await h.cleanup();
});

function buildRequest(authKey?: string) {
  return h.buildRequest({
    authKey,
    body: {
      model: ORIGINAL,
      stream: false,
      messages: [{ role: "user", content: "Check the original model identity" }],
    },
    headers: { "X-OmniRoute-No-Cache": "true", "x-omniroute-no-memory": "true" },
  });
}

async function seedGlobalRedirect() {
  return h.reasoningRulesDb.createReasoningRoutingRule({
    name: "Redirect Gemini Pro to Flash Lite",
    description: "Original-name integration regression",
    scope: "global",
    apiKeyId: null,
    comboId: null,
    connectionId: null,
    modelPattern: "gemini/gemini-2.5-pro",
    sourceEffort: "any",
    requestTags: [],
    tagMatchMode: "any",
    effortMode: "inherit",
    targetEffort: null,
    targetKind: "model",
    targetModel: `gemini/${TARGET}`,
    targetComboId: null,
    budgetAction: "preserve",
    budgetTokens: null,
    priority: 100,
    enabled: true,
  });
}

async function assertSuccessIdentity(response: Response, provider = "gemini", target = TARGET) {
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.equal(json.model, ORIGINAL);
  assert.equal(response.headers.get("x-omniroute-model"), target);
  const targetCost = await calculateCost(provider, target, json.usage);
  assert.equal(response.headers.get("x-omniroute-response-cost"), formatOmniRouteCost(targetCost));

  const log = await h.waitFor(async () => {
    await h.callLogsDb.waitForCallLogSaves(1000);
    const rows = await h.callLogsDb.getCallLogs({ limit: 20 });
    const row = rows.find((entry: { status: number; model: string }) => {
      return entry.status === 200 && entry.model === target;
    });
    return row ? h.callLogsDb.getCallLogById(row.id) : null;
  }, 10_000);
  assert.ok(log, "successful target execution should have a call log");
  assert.equal(log.requestedModel, ORIGINAL);
  assert.equal(log.model, target);
  const pipeline = log.pipelinePayloads as {
    clientRawRequest?: { body?: { model?: string } };
    clientResponse?: { model?: string };
  };
  assert.equal(pipeline.clientRawRequest?.body?.model, ORIGINAL);
  assert.equal(pipeline.clientResponse?.model, ORIGINAL);

  const usage = await h.waitFor(async () => {
    const history = await getUsageHistory({ provider, model: target });
    return history.find((entry) => entry.success) ?? null;
  }, 5000);
  assert.ok(usage, "usage accounting should retain the actual executed target");
  assert.equal(usage.model, target);
  assert.equal(usage.provider, provider);
}

test("Settings UI exact alias keeps request/response names while execution and cost use the target", async () => {
  await h.settingsDb.updateSettings({ modelAliases: { [ORIGINAL]: TARGET } });
  await assertSuccessIdentity(await chatRoute.POST(buildRequest()));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/models\/gemini-flash-lite-latest:generateContent/);
});

test("global reasoning redirect keeps the original name in response and logs", async () => {
  await seedGlobalRedirect();
  await assertSuccessIdentity(await chatRoute.POST(buildRequest()));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/models\/gemini-flash-lite-latest:generateContent/);
});

test("global combo fallback retains the outer requested name after the member fails", async () => {
  await h.seedConnection("openai");
  await h.combosDb.createCombo({
    name: ORIGINAL,
    models: ["openai/gpt-4o-mini"],
    strategy: "priority",
    config: { maxRetries: 0 },
  });
  await h.settingsDb.updateSettings({ globalFallbackModel: `gemini/${TARGET}` });
  const geminiFetch = globalThis.fetch;
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    if (new URL(String(url)).hostname === "api.openai.com") {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ error: { message: "mock backend unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return geminiFetch(url, init);
  };
  await assertSuccessIdentity(await chatRoute.POST(buildRequest()));
  assert.ok(calls.some((call) => new URL(call.url).hostname === "api.openai.com"));
  assert.match(calls.at(-1)?.url || "", /\/models\/gemini-flash-lite-latest:generateContent/);
});

test("emergency provider fallback retains the original name while accounting records its target", async () => {
  await h.seedConnection("nvidia");
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (new URL(String(url)).hostname === "generativelanguage.googleapis.com") {
      return new Response(JSON.stringify({ error: { message: "Payment required", code: 402 } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(new URL(String(url)).hostname, "integrate.api.nvidia.com");
    assert.equal(calls.at(-1)?.body.model, "openai/gpt-oss-120b");
    return h.buildOpenAIResponse("emergency fallback reply", "openai/gpt-oss-120b");
  };
  await assertSuccessIdentity(
    await chatRoute.POST(buildRequest()),
    "nvidia",
    "openai/gpt-oss-120b"
  );
  assert.ok(
    calls.some((call) => new URL(call.url).hostname === "generativelanguage.googleapis.com")
  );
  assert.equal(new URL(calls.at(-1)?.url || "").hostname, "integrate.api.nvidia.com");
});

test("original-name echo cannot bypass an API key restriction on the redirected target", async () => {
  const key = await h.seedApiKey({ allowedModels: [ORIGINAL, "gemini/gemini-2.5-pro"] });
  await seedGlobalRedirect();
  const response = await chatRoute.POST(buildRequest(key.key));
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal(calls.length, 0, "denied target must never reach the upstream");
});
