import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getGeminiDailyModelLimit,
  normalizeGeminiDailyQuotaModel,
  resolveGeminiDailyQuotaPolicy,
  shouldBypassGeminiMinuteLimits,
} from "../../../src/shared/utils/geminiDailyQuota.ts";

const IS_COUNTER_WORKER = process.env.OMNIROUTE_GEMINI_DAILY_TEST_WORKER === "1";
const TEST_DATA_DIR = IS_COUNTER_WORKER
  ? process.env.DATA_DIR!
  : fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-daily-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const quota = await import("../../../src/lib/db/geminiDailyQuota.ts");

const POLICY = { geminiDailyQuota: { enabled: true } };
const NOW = Date.parse("2026-10-11T12:00:00Z");
const FLASH = "gemini-3-flash-preview";
const LITE = "gemini-3.1-flash-lite";

async function seedConnection(name: string): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name,
    apiKey: `test-${name}`,
    isActive: false,
    providerSpecificData: POLICY,
  });
  return connection!.id;
}

function runCounterWorker(connectionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        OMNIROUTE_GEMINI_DAILY_TEST_WORKER: "1",
        OMNIROUTE_GEMINI_DAILY_TEST_CONNECTION: connectionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const count = /GEMINI_DAILY_ALLOWED=(\d+)/.exec(stdout);
      if (code === 0 && count) resolve(Number(count[1]));
      else reject(new Error(`Counter worker exited ${code}: ${stderr}`));
    });
  });
}

if (IS_COUNTER_WORKER) {
  try {
    let allowed = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (
        quota.reserveGeminiDailyRequest(
          process.env.OMNIROUTE_GEMINI_DAILY_TEST_CONNECTION!,
          FLASH,
          POLICY,
          NOW
        ).allowed
      ) {
        allowed++;
      }
    }
    process.stdout.write(`GEMINI_DAILY_ALLOWED=${allowed}\n`);
  } finally {
    core.resetDbInstance();
  }
} else {
  test.beforeEach(() => {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  test.after(() => {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("daily control is opt-in and uses valid default family limits", () => {
    assert.deepEqual(resolveGeminiDailyQuotaPolicy(undefined), {
      enabled: false,
      flashRpd: 20,
      flashLiteRpd: 500,
      disableMinuteLimits: true,
    });
    assert.deepEqual(
      resolveGeminiDailyQuotaPolicy({
        geminiDailyQuota: {
          enabled: "true",
          flashRpd: -1,
          flashLiteRpd: 0.5,
        },
      }),
      resolveGeminiDailyQuotaPolicy(undefined)
    );
    assert.equal(getGeminiDailyModelLimit(FLASH, {}), null);
    assert.equal(shouldBypassGeminiMinuteLimits("gemini", POLICY), true);
    assert.equal(shouldBypassGeminiMinuteLimits("gemini", {}), false);
    assert.equal(shouldBypassGeminiMinuteLimits("openai", POLICY), false);
    assert.equal(
      shouldBypassGeminiMinuteLimits("gemini", {
        geminiDailyQuota: { enabled: true, disableMinuteLimits: false },
      }),
      false
    );
  });

  test("text Flash and Flash Lite receive distinct limits without merging model variants", () => {
    assert.equal(getGeminiDailyModelLimit(" models/Gemini-3-Flash-Preview ", POLICY), 20);
    assert.equal(getGeminiDailyModelLimit("gemini/gemini-3.1-flash-lite", POLICY), 500);
    assert.equal(getGeminiDailyModelLimit("gemini-flash-latest", POLICY), 20);
    assert.equal(
      normalizeGeminiDailyQuotaModel("models/gemini-3-flash-preview-09-2026"),
      "gemini-3-flash-preview-09-2026"
    );
    for (const model of [
      "gemini-3-pro",
      "gemini-3-flash-image-preview",
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-flash-native-audio-preview",
      "gemini-2.0-flash-live-001",
      "gemini-embedding-001",
      "other-flash-model",
    ]) {
      assert.equal(getGeminiDailyModelLimit(model, POLICY), null, model);
    }
  });

  test("Flash admits its twentieth request and rejects subsequent attempts without incrementing", async () => {
    const id = await seedConnection("flash-cap");
    for (let attempt = 1; attempt <= 20; attempt++) {
      const result = quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
      assert.equal(result.allowed, true);
      assert.equal(result.status?.used, attempt);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const rejected = quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
      assert.equal(rejected.allowed, false);
      assert.equal(rejected.status?.used, 20);
      assert.equal(rejected.status?.remaining, 0);
      assert.equal(rejected.status?.exhausted, true);
    }
  });

  test("Flash Lite allows 500 requests independently of Flash, other keys and previews", async () => {
    const id = await seedConnection("independent-key");
    const secondId = await seedConnection("second-project");
    for (let attempt = 0; attempt < 20; attempt++) {
      quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    }
    for (let attempt = 0; attempt < 500; attempt++) {
      assert.equal(quota.reserveGeminiDailyRequest(id, LITE, POLICY, NOW).allowed, true);
    }
    assert.equal(quota.reserveGeminiDailyRequest(id, LITE, POLICY, NOW).allowed, false);
    assert.equal(quota.reserveGeminiDailyRequest(secondId, FLASH, POLICY, NOW).allowed, true);
    assert.equal(quota.reserveGeminiDailyRequest(id, "gemini-3-flash", POLICY, NOW).allowed, true);
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 20);
    assert.equal(quota.getGeminiDailyQuotaStatus(id, LITE, POLICY, NOW)?.used, 500);
    assert.equal(quota.getGeminiDailyQuotaStatus(secondId, FLASH, POLICY, NOW)?.used, 1);
  });

  test("prefix aliases share the exact model counter and policy changes do not erase usage", async () => {
    const id = await seedConnection("policy-update");
    quota.reserveGeminiDailyRequest(id, `models/${FLASH}`, POLICY, NOW);
    quota.reserveGeminiDailyRequest(id, `gemini/${FLASH.toUpperCase()}`, POLICY, NOW);
    const smaller = { geminiDailyQuota: { enabled: true, flashRpd: 1 } };
    assert.equal(quota.reserveGeminiDailyRequest(id, FLASH, smaller, NOW).allowed, false);
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, smaller, NOW)?.used, 2);
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, smaller, NOW)?.remaining, 0);
    assert.deepEqual(quota.reserveGeminiDailyRequest(id, FLASH, {}, NOW), {
      allowed: true,
      status: null,
    });
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 2);
  });

  test("Pacific midnight restores eligibility even when UTC stays on the same date", async () => {
    const id = await seedConnection("midnight");
    const before = Date.parse("2026-10-11T06:59:59.999Z");
    const after = before + 1;
    const oneRequest = { geminiDailyQuota: { enabled: true, flashRpd: 1 } };
    const spent = quota.reserveGeminiDailyRequest(id, FLASH, oneRequest, before);
    assert.equal(spent.status?.day, "2026-10-10");
    assert.equal(spent.status?.resetAt, "2026-10-11T07:00:00.000Z");
    assert.equal(quota.reserveGeminiDailyRequest(id, FLASH, oneRequest, before).allowed, false);
    const restored = quota.getGeminiDailyQuotaStatus(id, FLASH, oneRequest, after);
    assert.equal(restored?.day, "2026-10-11");
    assert.equal(restored?.used, 0);
    assert.equal(restored?.exhausted, false);
    assert.equal(quota.reserveGeminiDailyRequest(id, FLASH, oneRequest, after).allowed, true);
  });

  test("Pacific reset follows 23-hour and 25-hour DST days", () => {
    for (const [midnight, nextMidnight, hours, day] of [
      ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00.000Z", 23, "2026-03-08"],
      ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00.000Z", 25, "2026-11-01"],
    ] as const) {
      const start = Date.parse(midnight);
      const projection = quota.getGeminiDailyQuotaProjection("unknown", {}, start);
      assert.equal(projection.day, day);
      assert.equal(projection.resetAt, nextMidnight);
      assert.equal((Date.parse(projection.resetAt) - start) / 3_600_000, hours);
    }
  });

  test("usage survives closing and reopening the database", async () => {
    const id = await seedConnection("persistence");
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    core.resetDbInstance();
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 2);
    assert.equal(quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW).status?.used, 3);
  });

  test("structural recovery preserves connection quotas alongside credentials", async (t) => {
    const id = await seedConnection("structure-repair");
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    const db = core.getDbInstance();
    if (db.driver === "sql.js") {
      t.skip("Recovery probe simulation requires independently opened native SQLite handles");
      return;
    }
    const prototype = Object.getPrototypeOf(db.raw) as {
      prepare: (...args: unknown[]) => unknown;
    };
    const originalPrepare = prototype.prepare;
    core.resetDbInstance();
    let failedProbe = false;
    const mocked = mock.method(prototype, "prepare", function (this: unknown, ...args: unknown[]) {
      if (
        !failedProbe &&
        typeof args[0] === "string" &&
        args[0].includes("name='schema_migrations'")
      ) {
        failedProbe = true;
        throw new Error("Forced structural probe failure for quota preservation test");
      }
      return originalPrepare.apply(this, args);
    });
    try {
      assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 2);
      assert.equal(failedProbe, true);
      assert.equal(quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW).status?.used, 3);
    } finally {
      mocked.mock.restore();
    }
  });

  test("deleting a connection removes its daily counters", async () => {
    const id = await seedConnection("deleted-connection");
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    await providersDb.deleteProviderConnection(id);
    assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 0);
  });

  test("projection displays only observed models for the current Pacific day", async () => {
    const id = await seedConnection("projection");
    const previousDay = Date.parse("2026-10-10T12:00:00Z");
    quota.reserveGeminiDailyRequest(id, "gemini-2.5-flash", POLICY, previousDay);
    assert.deepEqual(quota.getGeminiDailyQuotaProjection(id, POLICY, NOW).models, []);
    quota.reserveGeminiDailyRequest(id, FLASH, POLICY, NOW);
    quota.reserveGeminiDailyRequest(id, LITE, POLICY, NOW);
    const projection = quota.getGeminiDailyQuotaProjection(id, POLICY, NOW);
    assert.equal(projection.enabled, true);
    assert.equal(projection.timeZone, "America/Los_Angeles");
    assert.equal(projection.flashRpd, 20);
    assert.equal(projection.flashLiteRpd, 500);
    assert.equal(projection.disableMinuteLimits, true);
    assert.deepEqual(
      projection.models.map(({ model, used }) => ({ model, used })),
      [
        { model: FLASH, used: 1 },
        { model: LITE, used: 1 },
      ]
    );
    assert.deepEqual(quota.getGeminiDailyQuotaProjection(id, {}, NOW).models, []);
  });

  test(
    "parallel processes cannot reserve beyond the shared daily limit",
    { timeout: 60_000 },
    async (t) => {
      const id = await seedConnection("parallel-processes");
      if (core.getDbInstance().driver === "sql.js") {
        t.skip("Cross-process SQLite locking requires a native SQLite driver");
        return;
      }
      const accepted = await Promise.all(Array.from({ length: 4 }, () => runCounterWorker(id)));
      assert.equal(
        accepted.reduce((sum, count) => sum + count, 0),
        20
      );
      assert.equal(quota.getGeminiDailyQuotaStatus(id, FLASH, POLICY, NOW)?.used, 20);
    }
  );
}
