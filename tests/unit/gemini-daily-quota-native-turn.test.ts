import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-native-turn-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OMNIROUTE_QUOTA_AWARE_ROUTING = "1";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const core = await import("../../src/lib/db/core.ts");
const { recordProviderQuotaUsage } = await import("../../src/lib/quota/providerQuotaState.ts");
const { canAffordRequest } = await import("../../src/lib/quota/quotaScheduler.ts");
const { isPinnedTargetModelScopedUnusable, areAllPinnedTargetsModelScopedUnusable } =
  await import("../../open-sse/services/combo/nativeCodexTurnPin.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const scenario of [
  { provider: "gemini", enabled: true, disableMinuteLimits: true, unusable: false },
  { provider: "gemini", enabled: true, disableMinuteLimits: false, unusable: true },
  { provider: "gemini", enabled: false, disableMinuteLimits: true, unusable: true },
  { provider: "openai", enabled: true, disableMinuteLimits: true, unusable: true },
]) {
  test(`pinned ${scenario.provider} minute budget respects daily opt-in ${JSON.stringify(scenario)}`, async () => {
    const connection = await createProviderConnection({
      provider: scenario.provider,
      name: "daily native turn test",
      authType: "apikey",
      apiKey: "fake-local-key",
      isActive: true,
      providerSpecificData: {
        geminiDailyQuota: {
          enabled: scenario.enabled,
          disableMinuteLimits: scenario.disableMinuteLimits,
        },
      },
    });
    const modelStr = `${scenario.provider}/gemini-2.5-flash`;
    recordProviderQuotaUsage(connection.id, modelStr, 1, { tokenLimit: 1 });
    assert.equal(canAffordRequest(connection.id, modelStr, {}).affordable, false);
    const target = {
      modelStr,
      provider: scenario.provider,
      connectionId: connection.id,
      executionKey: `${modelStr}@${connection.id}`,
    };
    assert.equal(
      await isPinnedTargetModelScopedUnusable({
        target,
        comboName: "daily native",
        body: {},
      }),
      scenario.unusable
    );
    assert.equal(
      await areAllPinnedTargetsModelScopedUnusable({
        pinnedTargets: [target],
        comboName: "daily native",
        body: {},
      }),
      scenario.unusable
    );
  });
}
