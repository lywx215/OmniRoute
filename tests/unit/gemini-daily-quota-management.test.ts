import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession";
import type { GeminiDailyQuotaProjection } from "../../src/lib/db/geminiDailyQuota";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-management-"));
process.env.DATA_DIR = dataDirectory;
process.env.JWT_SECRET = "gemini-daily-quota-test-session";
process.env.INITIAL_PASSWORD = "gemini-test-admin";
process.env.APP_LOG_TO_FILE = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { updateProviderConnectionSchema } = await import("../../src/shared/validation/schemas");
const { normalizeProviderSpecificData } = await import("../../src/lib/providers/requestDefaults");
const core = await import("../../src/lib/db/core");
const { createProviderConnection, getProviderConnectionById } =
  await import("../../src/lib/db/providers");
const { reserveGeminiDailyRequest } = await import("../../src/lib/db/geminiDailyQuota");
const listRoute = await import("../../src/app/api/providers/route");
const connectionRoute = await import("../../src/app/api/providers/[id]/route");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const policy = { enabled: true, flashRpd: 20, flashLiteRpd: 500, disableMinuteLimits: true };

test("daily quota settings validate types, integer bounds and misspelled options", () => {
  assert.equal(
    updateProviderConnectionSchema.safeParse({ providerSpecificData: { geminiDailyQuota: policy } })
      .success,
    true
  );
  for (const invalid of [
    { ...policy, enabled: "yes" },
    { ...policy, flashRpd: 0 },
    { ...policy, flashLiteRpd: 1.5 },
    { ...policy, flashRpd: 10_000_001 },
    { ...policy, disableMinuteLimits: 1 },
    { ...policy, flashLiteRdp: 500 },
    [],
  ]) {
    const result = updateProviderConnectionSchema.safeParse({
      providerSpecificData: { geminiDailyQuota: invalid },
    });
    assert.equal(result.success, false, JSON.stringify(invalid));
  }
});

test("daily quota normalization is opt-in and preserves other provider settings", () => {
  assert.deepEqual(
    normalizeProviderSpecificData("gemini", {
      geminiDailyQuota: { enabled: true },
      customUserAgent: "test",
    }),
    {
      geminiDailyQuota: policy,
      customUserAgent: "test",
    }
  );
  assert.equal(
    normalizeProviderSpecificData("gemini", { customUserAgent: "test" })?.geminiDailyQuota,
    undefined
  );
  assert.equal(normalizeProviderSpecificData("gemini", { geminiDailyQuota: null }), undefined);
  assert.equal(normalizeProviderSpecificData("openai", { geminiDailyQuota: policy }), undefined);
});

interface ManagementConnection {
  id: string;
  providerSpecificData?: Record<string, unknown>;
  geminiDailyQuotaStatus?: GeminiDailyQuotaProjection;
}

test("management API persists settings and projects independent model counts without exposing keys", async () => {
  const apiKey = "AIza-test-daily-management-key-private";
  const connection = await createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name: "daily management test",
    apiKey,
    providerSpecificData: { customUserAgent: "preserve-me" },
  });
  const connectionId = String(connection.id);
  const update = await connectionRoute.PUT(
    await makeManagementSessionRequest(`http://localhost/api/providers/${connectionId}`, {
      method: "PUT",
      body: { providerSpecificData: { geminiDailyQuota: policy } },
    }),
    { params: Promise.resolve({ id: connectionId }) }
  );
  assert.equal(update.status, 200);
  const persisted = await getProviderConnectionById(connectionId);
  assert.equal(persisted?.providerSpecificData?.customUserAgent, "preserve-me");
  assert.deepEqual(persisted?.providerSpecificData?.geminiDailyQuota, policy);
  reserveGeminiDailyRequest(connectionId, "gemini-2.5-flash", { geminiDailyQuota: policy });
  reserveGeminiDailyRequest(connectionId, "gemini-3-flash-preview", { geminiDailyQuota: policy });
  reserveGeminiDailyRequest(connectionId, "gemini-2.5-flash-lite", { geminiDailyQuota: policy });
  const response = await listRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers?provider=gemini")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { connections: ManagementConnection[] };
  assert.equal(JSON.stringify(body).includes(apiKey), false);
  const projected = body.connections.find(
    (entry) => entry.id === connectionId
  )?.geminiDailyQuotaStatus;
  assert.ok(projected);
  assert.equal(projected.timeZone, "America/Los_Angeles");
  assert.deepEqual(
    projected.models.map(({ model, used, limit, remaining }) => ({
      model,
      used,
      limit,
      remaining,
    })),
    [
      { model: "gemini-2.5-flash", used: 1, limit: 20, remaining: 19 },
      { model: "gemini-2.5-flash-lite", used: 1, limit: 500, remaining: 499 },
      { model: "gemini-3-flash-preview", used: 1, limit: 20, remaining: 19 },
    ]
  );
  const single = await connectionRoute.GET(
    await makeManagementSessionRequest(`http://localhost/api/providers/${connectionId}`),
    { params: Promise.resolve({ id: connectionId }) }
  );
  assert.equal(single.status, 200);
  const singleBody = (await single.json()) as { connection: ManagementConnection };
  assert.deepEqual(singleBody.connection.geminiDailyQuotaStatus, projected);
  const invalid = await connectionRoute.PUT(
    await makeManagementSessionRequest(`http://localhost/api/providers/${connectionId}`, {
      method: "PUT",
      body: { providerSpecificData: { geminiDailyQuota: { ...policy, flashRpd: 0 } } },
    }),
    { params: Promise.resolve({ id: connectionId }) }
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(
    (await getProviderConnectionById(connectionId))?.providerSpecificData?.geminiDailyQuota,
    policy
  );
});
