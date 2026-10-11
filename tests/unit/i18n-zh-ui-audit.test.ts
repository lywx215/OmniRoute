import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { IntlMessageFormat } from "intl-messageformat";

const repairedKeys = [
  "webhooks.discord.webhookUrl",
  "webhooks.slack.webhookUrl",
  "providers.codexReleaseCooldown",
  "providers.codexReleaseCooldownHint",
  "providers.codexReleasingCooldown",
  "providers.codexCooldownReleased",
  "providers.codexCooldownReleaseFailed",
  "providers.localCatalogFallbackStatus",
  "providers.codexPaidCreditsShort",
  "providers.codexPaidCreditsToggleTitle",
  "providers.codexPaidCreditsEnabled",
  "providers.codexPaidCreditsDisabled",
  "providers.failedUpdateCodexPaidCredits",
  "providers.allowCodexPaidCreditsLabel",
  "providers.rateLimitOverridesModelConcurrencyLabel",
  "providers.rateLimitOverridesModelConcurrencyHint",
  "providers.rateLimitOverridesModelConcurrencyInvalid",
  "settings.proxySubscription.error.CORE_CONFIG_NOT_GENERATED",
  "settings.proxySubscription.error.CORE_RELOAD_UNDECLARED",
  "settings.proxySubscription.error.CORE_RELOAD_FAILED",
  "settings.proxySubscription.coreConfigPath",
  "settings.proxySubscription.coreConfigPathDesc",
  "settings.proxySubscription.lastSwitchKind",
  "settings.proxySubscription.switchKind.ip_quota_429",
  "settings.proxySubscription.switchKind.proxy_unreachable",
  "settings.proxySubscription.switchKind.transport",
  "settings.proxySubscription.switchKind.slow",
  "settings.proxySubscription.coreReloadAppliedBy",
  "settings.semanticCacheRedisUrl",
  "usage.codexPaidCreditsLabel",
  "usage.codexPaidCreditsAvailable",
  "usage.codexPaidCreditsUnavailable",
  "usage.codexPaidCreditsUnlimited",
  "auth.newPasswordPlaceholder",
  "quotaShare.schedulesTitle",
  "quotaShare.schedulesHint",
  "quotaShare.schedulesEmpty",
  "quotaShare.schedulesAdd",
  "quotaShare.schedulesRemove",
  "quotaShare.schedulesEnabled",
  "quotaShare.schedulesMode",
  "quotaShare.schedulesModeAllow",
  "quotaShare.schedulesModeBlock",
  "quotaShare.schedulesFrom",
  "quotaShare.schedulesTo",
  "quotaShare.schedulesReserve",
  "quotaShare.schedulesReserveHint",
  "quotaShare.schedulesReserveNone",
  "quotaShare.schedulesReserveAdd",
  "quotaShare.schedulesReserveRemove",
  "quotaShare.schedulesReserveWindow",
  "quotaShare.schedulesReserveWindowAny",
  "quotaShare.schedulesBudget",
  "quotaShare.schedulesBudgetHint",
  "quotaShare.schedulesBudgetUnit",
  "quotaShare.schedulesBudgetWindow",
  "quotaShare.schedulesTimezone",
  "quotaShare.schedulesPriority",
  "quotaShare.schedulesSaved",
  "quotaShare.schedulesSaveError",
  "quotaShare.schedulesLoadError",
  "requestTimeline.allApiKeys",
  "requestTimeline.mcpTool",
  "requestTimeline.scope",
  "requestTimeline.apiKey",
  "endpoint.obsidianWebdavUrl",
  "settings.cliproxyapiUrl",
  "settings.headroomProxyUrl",
  "embeddedServices.cliproxyUrl",
];
const en = JSON.parse(
  readFileSync(new URL("../../src/i18n/messages/en.json", import.meta.url), "utf8")
);
function value(catalog: Record<string, unknown>, key: string): string {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    assert.ok(node && typeof node === "object" && Object.hasOwn(node, part), key);
    node = (node as Record<string, unknown>)[part];
  }
  assert.equal(typeof node, "string", key);
  return node as string;
}
for (const locale of ["zh-CN", "zh-TW"]) {
  test(locale + " renders repaired UI text in Chinese and preserves runtime arguments", () => {
    const catalog = JSON.parse(
      readFileSync(new URL("../../src/i18n/messages/" + locale + ".json", import.meta.url), "utf8")
    );
    for (const key of repairedKeys) {
      const translated = value(catalog, key);
      const source = value(en, key);
      assert.match(translated, /[\u3400-\u9fff]/u, key + " needs Chinese UI copy");
      assert.notEqual(translated, source, key + " must not be an English copy");
      assert.deepEqual(
        [...translated.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        key + " preserves interpolation"
      );
      const rendered = new IntlMessageFormat(translated, locale).format({
        entry: "gemini=bad",
        max: 3,
        mode: "test",
      });
      assert.equal(typeof rendered, "string");
    }
    assert.match(value(catalog, "providers.codexPaidCreditsToggleTitle"), /額外費用|额外费用/);
    const hint = new IntlMessageFormat(
      value(catalog, "settings.proxySubscription.coreConfigPathDesc"),
      locale
    ).format();
    assert.ok(
      String(hint).includes("<path>.generated"),
      "literal config filename must stay intact"
    );
  });
}
