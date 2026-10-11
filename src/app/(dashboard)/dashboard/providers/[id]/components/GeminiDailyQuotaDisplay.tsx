"use client";

import { useTranslations } from "next-intl";
import type { GeminiDailyQuotaProjection } from "@/lib/db/geminiDailyQuota";

export default function GeminiDailyQuotaDisplay({
  status,
}: {
  status?: GeminiDailyQuotaProjection;
}) {
  const t = useTranslations("providers");
  if (!status) return null;
  if (!status.enabled) {
    return (
      <p className="mt-2 text-xs text-text-muted">
        {t("geminiDailyQuotaTitle")} · {t("toggleOffShort")}
      </p>
    );
  }
  const resetTime = new Intl.DateTimeFormat("en-US", {
    timeZone: status.timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(status.resetAt));
  return (
    <div className="mt-2 space-y-1 text-xs" aria-label={t("geminiDailyQuotaTitle")}>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-text-muted">
        <span>
          {t("geminiDailyQuotaTitle")} · {t("toggleOnShort")}
        </span>
        <span>{t("geminiDailyQuotaReset", { time: resetTime })}</span>
      </div>
      <p className="text-text-muted">
        Flash: {status.flashRpd} RPD · Flash-Lite: {status.flashLiteRpd} RPD
      </p>
      {status.models.length === 0 ? (
        <p className="text-text-muted">{t("geminiDailyQuotaEmpty")}</p>
      ) : (
        status.models.map((model) => (
          <div
            key={model.model}
            className={`flex flex-wrap gap-x-2 ${model.exhausted ? "text-amber-600 dark:text-amber-400" : "text-text-muted"}`}
          >
            <span className="font-mono break-all">{model.model}</span>
            <span>
              {t("geminiDailyQuotaUsage", {
                used: model.used,
                limit: model.limit,
                remaining: model.remaining,
              })}
            </span>
            {model.exhausted && <span>{t("codexPoolQuotaExhausted")}</span>}
          </div>
        ))
      )}
    </div>
  );
}
