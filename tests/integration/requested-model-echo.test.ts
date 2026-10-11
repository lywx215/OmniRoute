import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("requested-model-echo");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const responsesRoute = await import("../../src/app/api/v1/responses/route.ts");
const messagesRoute = await import("../../src/app/api/v1/messages/route.ts");
const aliases = await import("../../src/lib/db/models/aliases.ts");
const aliasResolver = await import("../../src/lib/modelAliasResolver.ts");
const TARGET = "gemini-flash-lite-latest";
const ORIGINAL = "gemini-2.5-pro";
let calls: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(async () => {
  await h.resetStorage();
  aliasResolver.invalidateAliasCache();
  calls = [];
  await h.seedConnection("gemini");
  await h.settingsDb.updateSettings({
    echoRequestedModelName: true,
    requestRetry: 0,
    call_log_pipeline_enabled: true,
  });
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (String(url).includes("streamGenerateContent")) {
      const payload = await h.buildGeminiResponse("中文 reply", TARGET).text();
      const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 11) {
              controller.enqueue(bytes.slice(offset, offset + 11));
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }
    return h.buildGeminiResponse("reply", TARGET);
  };
});
after(() => h.cleanup());

async function seedAlias(name = ORIGINAL) {
  await aliases.setModelAlias(name, `gemini/${TARGET}`);
  aliasResolver.invalidateAliasCache();
}

function body(model = ORIGINAL, stream = false) {
  return { model, stream, messages: [{ role: "user", content: "Say hello" }] };
}

async function assertResponse(response: Response, original: string, stream = false) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-omniroute-model"), TARGET);
  if (!stream) {
    const json = await response.json();
    assert.equal(json.model, original);
    return;
  }
  const frames = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const models = frames.flatMap((frame) => {
    const nested = frame.response as { model?: string } | undefined;
    const message = frame.message as { model?: string } | undefined;
    return [frame.model, nested?.model, message?.model].filter((value) => value !== undefined);
  });
  assert.ok(models.length > 0, "the translated SSE contains a model field");
  assert.ok(
    models.every((model) => model === original),
    JSON.stringify(models)
  );
}

test("route alias keeps the original response and log name while Google receives the target", async () => {
  await seedAlias();
  const response = await chatRoute.POST(h.buildRequest({ body: body() }));
  await assertResponse(response, ORIGINAL);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-flash-lite-latest:generateContent$/);
  assert.equal("originalRequestedModel" in calls[0].body, false);
  const log = await h.waitFor(async () => {
    await h.callLogsDb.waitForCallLogSaves(1000);
    return h.getLatestCallLog();
  }, 10_000);
  assert.ok(log);
  assert.equal(log.requestedModel, ORIGINAL);
  assert.equal(log.model, TARGET);
  const pipeline = log.pipelinePayloads as {
    clientRawRequest?: { body?: { model?: string } };
    clientResponse?: { model?: string };
  };
  assert.equal(pipeline.clientRawRequest?.body?.model, ORIGINAL);
  assert.equal(pipeline.clientResponse?.model, ORIGINAL);
});

test("route alias survives split Gemini SSE translation", async () => {
  await seedAlias();
  await assertResponse(
    await chatRoute.POST(h.buildRequest({ body: body(ORIGINAL, true) })),
    ORIGINAL,
    true
  );
  assert.match(calls[0].url, /\/models\/gemini-flash-lite-latest:streamGenerateContent/);
});

test("same-name and nested combos preserve the outer name after a member fails", async () => {
  await h.seedConnection("openai");
  await h.combosDb.createCombo({
    name: "inner-echo",
    models: [`gemini/${TARGET}`],
    strategy: "priority",
  });
  await h.combosDb.createCombo({
    name: ORIGINAL,
    models: ["openai/gpt-4o-mini", "inner-echo"],
    strategy: "priority",
    config: { maxRetries: 0 },
  });
  const geminiFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("openai.com")) {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ error: { message: "mock model unavailable" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return geminiFetch(url, init);
  };
  await assertResponse(await chatRoute.POST(h.buildRequest({ body: body() })), ORIGINAL);
  assert.ok(calls.some((call) => call.url.includes("openai.com")));
  assert.match(calls.at(-1)?.url || "", /gemini-flash-lite-latest:generateContent$/);
});

test("idempotency cache reuses the target but renders each alias and current echo setting", async () => {
  await seedAlias();
  await seedAlias("pro-alias-b");
  const headers = { "Idempotency-Key": "echo-cache-shared" };
  await assertResponse(await chatRoute.POST(h.buildRequest({ body: body(), headers })), ORIGINAL);
  await assertResponse(
    await chatRoute.POST(h.buildRequest({ body: body("pro-alias-b"), headers })),
    "pro-alias-b"
  );
  assert.equal(calls.length, 1);
  await h.settingsDb.updateSettings({ echoRequestedModelName: false });
  const result = await chatRoute.POST(h.buildRequest({ body: body(), headers }));
  assert.equal((await result.json()).model, TARGET);
  assert.equal(calls.length, 1);
});

test("semantic cache keeps its canonical model across aliases, SSE and echo toggles", async () => {
  await seedAlias();
  await seedAlias("pro-alias-b");
  const cachedBody = (model: string, stream = false) => ({
    ...body(model, stream),
    temperature: 0,
  });
  await assertResponse(
    await chatRoute.POST(h.buildRequest({ body: cachedBody(ORIGINAL) })),
    ORIGINAL
  );
  const hit = await chatRoute.POST(h.buildRequest({ body: cachedBody("pro-alias-b") }));
  assert.equal(hit.headers.get("x-omniroute-cache"), "HIT");
  await assertResponse(hit, "pro-alias-b");
  const streamHit = await chatRoute.POST(h.buildRequest({ body: cachedBody(ORIGINAL, true) }));
  assert.equal(streamHit.headers.get("x-omniroute-cache"), "HIT");
  await assertResponse(streamHit, ORIGINAL, true);
  await h.settingsDb.updateSettings({ echoRequestedModelName: false });
  await assertResponse(
    await chatRoute.POST(h.buildRequest({ body: cachedBody("pro-alias-b") })),
    TARGET
  );
  assert.equal(calls.length, 1);
});

test("Responses JSON and SSE use the original alias after protocol conversion", async () => {
  await seedAlias();
  await h.combosDb.createCombo({
    name: ORIGINAL,
    models: [`gemini/${TARGET}`],
    strategy: "priority",
  });
  for (const stream of [false, true]) {
    const response = await responsesRoute.POST(
      h.buildRequest({
        url: "http://localhost/v1/responses",
        body: { model: ORIGINAL, input: "Say hello", stream },
      })
    );
    await assertResponse(response, ORIGINAL, stream);
  }
});

test("Messages JSON and message_start SSE use the original alias", async () => {
  await seedAlias();
  for (const stream of [false, true]) {
    const response = await messagesRoute.POST(
      h.buildRequest({
        url: "http://localhost/v1/messages",
        body: { ...body(ORIGINAL, stream), max_tokens: 32 },
      })
    );
    await assertResponse(response, ORIGINAL, stream);
  }
});

test("trusted name survives bounded logging, noLog, spoofed fields and concurrent aliases", async () => {
  const key = await h.seedApiKey({ noLog: true });
  await seedAlias();
  await seedAlias("pro-alias-b");
  const padding = Object.fromEntries(
    Array.from({ length: 90 }, (_, index) => [`extra${index}`, index])
  );
  const results = await Promise.all(
    [ORIGINAL, "pro-alias-b"].map((model) =>
      chatRoute.POST(
        h.buildRequest({
          authKey: key.key,
          body: {
            ...padding,
            ...body(model),
            originalRequestedModel: "spoofed",
            requestContext: { originalRequestedModel: "spoofed" },
          },
        })
      )
    )
  );
  for (let index = 0; index < results.length; index++) {
    await assertResponse(results[index], index === 0 ? ORIGINAL : "pro-alias-b");
  }
  assert.ok(
    calls.every(
      (call) => !("originalRequestedModel" in call.body) && !("requestContext" in call.body)
    )
  );
  await h.callLogsDb.waitForCallLogSaves(1000);
  const rows = await h.callLogsDb.getCallLogs({ limit: 5 });
  for (const row of rows) {
    const detail = await h.callLogsDb.getCallLogById(row.id);
    assert.equal(detail?.requestBody, null);
    assert.equal(detail?.responseBody, null);
    assert.equal(detail?.pipelinePayloads ?? null, null);
  }
});

test("client lookalikes cannot reach an OpenAI passthrough upstream as internal metadata", async () => {
  await h.seedConnection("openai");
  await aliases.setModelAlias(ORIGINAL, "openai/gpt-4o-mini");
  aliasResolver.invalidateAliasCache();
  let upstreamBody: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(String(init?.body));
    return h.buildOpenAIResponse("ok", "gpt-4o-mini");
  };
  const response = await chatRoute.POST(
    h.buildRequest({
      body: {
        ...body(),
        originalRequestedModel: "spoofed",
        clientRequestedModel: "spoofed",
        requestContext: { originalRequestedModel: "spoofed" },
      },
    })
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, ORIGINAL);
  assert.equal(upstreamBody.model, "gpt-4o-mini");
  for (const name of ["originalRequestedModel", "clientRequestedModel", "requestContext"]) {
    assert.equal(name in upstreamBody, false, name);
  }
});
