import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-idempotent-echo-"));
process.env.DATA_DIR = dataDir;
const { checkIdempotencyCache, composeIdempotencyKey } =
  await import("../../open-sse/handlers/chatCore/idempotency.ts");
const { saveIdempotency, clearIdempotency, checkIdempotency } =
  await import("../../src/lib/idempotencyLayer.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { OMNIROUTE_RESPONSE_HEADERS } = await import("../../src/shared/constants/headers.ts");

test.after(() => {
  clearIdempotency();
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("idempotency replays the current alias while preserving target identity and cached object", async () => {
  const body = {
    model: "gemini/gemini-flash-lite-latest",
    messages: [{ role: "user", content: "hi" }],
  };
  const base = {
    clientRawRequest: { headers: { "idempotency-key": "same-inference" } },
    provider: "gemini",
    model: "gemini-flash-lite-latest",
    body,
    effectiveServiceTier: undefined,
    startTime: Date.now(),
    log: null,
  };
  const key = composeIdempotencyKey({ rawKey: "same-inference", ...base, messages: body.messages });
  const cached = { model: "stale-alias", response: { model: "stale-alias" }, choices: [] };
  saveIdempotency(key, cached, 200);
  for (const echoModel of ["Gemini/Gemini-2.5-Pro", "another-alias", null]) {
    const { hit, idempotencyKey } = await checkIdempotencyCache({ ...base, echoModel });
    assert.equal(idempotencyKey, key, "display alias must not change the key");
    assert.ok(hit);
    const payload = await hit.response.json();
    assert.equal(payload.model, echoModel ?? base.model);
    assert.equal(payload.response.model, echoModel ?? base.model);
    assert.equal(hit.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.model), base.model);
    assert.equal(checkIdempotency(key)?.response, cached);
    assert.equal(cached.model, "stale-alias");
    assert.equal(cached.response.model, "stale-alias");
  }
});
