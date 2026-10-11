"use client";

import { useTranslations } from "next-intl";
import { Input, Toggle } from "@/shared/components";
import type { GeminiDailyQuotaPolicy } from "@/shared/utils/geminiDailyQuota";

export default function GeminiDailyQuotaSettings({
  value,
  onChange,
}: {
  value: GeminiDailyQuotaPolicy;
  onChange: (next: GeminiDailyQuotaPolicy) => void;
}) {
  const t = useTranslations("providers");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <Toggle
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
        label={t("geminiDailyQuotaTitle")}
        description={t("geminiDailyQuotaDescription")}
      />
      {value.enabled && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={`Flash · ${t("rateLimitOverridesRpdLabel")}`}
              type="number"
              min={1}
              max={10_000_000}
              step={1}
              required
              value={value.flashRpd}
              onChange={(event) => onChange({ ...value, flashRpd: Number(event.target.value) })}
            />
            <Input
              label={`Flash-Lite · ${t("rateLimitOverridesRpdLabel")}`}
              type="number"
              min={1}
              max={10_000_000}
              step={1}
              required
              value={value.flashLiteRpd}
              onChange={(event) => onChange({ ...value, flashLiteRpd: Number(event.target.value) })}
            />
          </div>
          <Toggle
            size="sm"
            checked={value.disableMinuteLimits}
            onChange={(disableMinuteLimits) => onChange({ ...value, disableMinuteLimits })}
            label={t("geminiDailyQuotaMinuteLimits")}
            description={t("geminiDailyQuotaMinuteLimitsDescription")}
          />
        </>
      )}
    </div>
  );
}
