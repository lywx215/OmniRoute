import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const h = await createChatPipelineHarness("requested-model-echo-rejections");
const route = await import("../../src/app/api/v1/chat/completions/route.ts");
const aliases = await import("../../src/lib/db/models/aliases.ts");
const aliasResolver = await import("../../src/lib/modelAliasResolver.ts");
const admission = await import("../../open-sse/services/admission/runtime.ts");
const ORIGINAL = "gemini-2.5-pro";
const TARGET = "gemini/gemini-flash-lite-latest";
let sends = 0;

beforeEach(async () => {
  await h.resetStorage();
  admission.resetAdaptiveAdmissionRuntimeForTests();
  await h.seedConnection("gemini");
  await aliases.setModelAlias(ORIGINAL, TARGET);
  aliasResolver.invalidateAliasCache();
  sends = 0;
  globalThis.fetch = async () => {
    sends++;
    throw new Error("a local rejection must not dispatch upstream");
  };
});

after(async () => {
  admission.resetAdaptiveAdmissionRuntimeForTests();
  await h.cleanup();
});

function request(
  stream = false,
  authKey?: string,
  messages: unknown[] = [{ role: "user", content: "audit" }]
) {
  return h.buildRequest({
    authKey,
    body: { model: ORIGINAL, stream, messages },
  });
}

async function assertRejection(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  const log = await h.waitFor(async () => {
    await h.callLogsDb.waitForCallLogSaves(1000);
    return h.getLatestCallLog();
  }, 5000);
  assert.ok(log, "the existing rejection logging range must retain the call log");
  assert.equal(log.status, status);
  assert.equal(log.requestedModel, ORIGINAL);
  assert.equal(log.model, TARGET, "routing/log model keeps its main contract");
  assert.equal((log.requestBody as { model?: string })?.model, ORIGINAL);
  assert.equal(sends, 0);
}

test("route alias preserves original identity in an API-key policy rejection", async () => {
  const key = await h.seedApiKey({ allowedModels: [ORIGINAL] });
  await assertRejection(await route.POST(request(false, key.key)), 403);
});

test("route alias preserves original identity in shared message validation", async () => {
  await assertRejection(await route.POST(request(false, undefined, [null])), 400);
});

for (const [status, stream] of [
  [429, false],
  [503, true],
] as const) {
  test(`adaptive admission ${status} retains the original alias (stream=${stream})`, async (t) => {
    const runtime = admission.getAdaptiveAdmissionRuntime();
    t.mock.method(runtime, "acquire", async () => ({
      status: "rejected" as const,
      response: new Response(
        JSON.stringify({ error: { code: "admission_test", message: "busy" } }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        }
      ),
    }));
    await assertRejection(await route.POST(request(stream)), status);
  });
}
