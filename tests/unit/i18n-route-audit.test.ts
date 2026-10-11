import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import { auditRoutes, inspectSource } from "../../scripts/i18n/audit-route-messages.mjs";
import MitmProxyError from "../../src/app/(dashboard)/dashboard/system/mitm-proxy/error";
import { pickMessages } from "../../src/i18n/pickMessages";
import namespaces from "../../src/i18n/routeNamespaces.generated.json";

test("the audit handles hook aliases, casts, multiline namespaces and root rich-text calls", () => {
  const result = inspectSource(`"use client";
    import {useTranslations as useT} from "next-intl";
    function A() { const t = useT(\n "settings" \n) as Translator; return t("title"); }
    function B() { const t = useT(); return t.rich("common.loading", {}); }
  `);
  assert.deepEqual(result.namespaces.sort(), ["common", "settings"]);
  assert.deepEqual(
    result.keys.map((item) => item.key),
    ["settings.title", "common.loading"]
  );
});

test("the audit catches a moved route without a catalog and validates same-level error inheritance", () => {
  const root = mkdtempSync(join(tmpdir(), "i18n-route-audit-"));
  const put = (file: string, text: string) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    put("src/i18n/messages/en.json", JSON.stringify({ home: { title: "Home" }, common: {} }));
    put(
      "src/i18n/routeNamespaces.generated.json",
      JSON.stringify({
        root: ["common"],
        chrome: ["common"],
        home: ["common", "home"],
        sections: {},
      })
    );
    const page = `"use client"; import {useTranslations} from "next-intl";
      export default function Page() { const t = useTranslations("home"); return t("title"); }`;
    put("src/app/(dashboard)/home/page.tsx", page);
    assert.deepEqual(auditRoutes(root).gaps[0].missing, ["home"]);
    put("src/app/(dashboard)/home/layout.tsx", "sectionNamespaces.home");
    put("src/app/(dashboard)/home/error.tsx", page);
    assert.deepEqual(auditRoutes(root).gaps, []);
    put("src/app/(dashboard)/home/page.tsx", page.replace('t("title")', 't("absent")'));
    assert.equal(auditRoutes(root).missingKeys[0].key, "home.absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MITM error UI renders translated copy instead of hardcoded English", () => {
  for (const locale of ["zh-CN", "en"]) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../src/i18n/messages/${locale}.json`, import.meta.url), "utf8")
    );
    const errors: unknown[] = [];
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        {
          locale,
          timeZone: "UTC",
          messages: pickMessages(catalog, namespaces.sections.system),
          onError: (error) => errors.push(error),
        },
        createElement(MitmProxyError, {
          error: Object.assign(new Error("test failure"), { digest: "audit-test-id" }),
          reset: () => {},
        })
      )
    );
    assert.ok(html.includes(catalog.mitm.loadFailed), `${locale}: translated MITM title`);
    assert.ok(html.includes(catalog.common.retry), `${locale}: translated retry button`);
    assert.ok(html.includes("audit-test-id"));
    assert.deepEqual(errors, []);
    assert.doesNotMatch(html, /mitm\.loadFailed|settings\.errorPage/);
  }
});

test("all UI surfaces receive their statically referenced namespaces and message keys", () => {
  const report = auditRoutes();
  assert.ok(report.surfaces > 100);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.missingKeys, []);
  assert.deepEqual(report.dynamicNamespaces, []);
});
