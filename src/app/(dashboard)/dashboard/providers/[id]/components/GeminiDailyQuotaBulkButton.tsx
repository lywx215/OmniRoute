"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import type { ConnectionRowConnection } from "./ConnectionRow";

export default function GeminiDailyQuotaBulkButton({
  connections,
  onSaved,
}: {
  connections: ConnectionRowConnection[];
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("providers");
  const notify = useNotificationStore();
  const [saving, setSaving] = useState(false);
  const targets = connections.filter(
    (connection) => connection.provider === "gemini" && connection.id
  );
  if (targets.length === 0) return null;
  const apply = async () => {
    setSaving(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (connection) => {
          const response = await fetch(`/api/providers/${connection.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              providerSpecificData: {
                geminiDailyQuota: {
                  enabled: true,
                  flashRpd: 20,
                  flashLiteRpd: 500,
                  disableMinuteLimits: true,
                },
              },
            }),
          });
          if (!response.ok) throw new Error("Could not save daily limits");
        })
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      const message = t("geminiDailyQuotaBulkResult", { count: targets.length - failed, failed });
      if (failed) notify.error(message);
      else notify.success(message);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-3 flex flex-col items-start gap-1">
      <Button size="sm" variant="outline" loading={saving} disabled={saving} onClick={apply}>
        {t("geminiDailyQuotaBulk", { count: targets.length })}
      </Button>
      <p className="text-xs text-text-muted">Flash: 20 RPD · Flash-Lite: 500 RPD</p>
    </div>
  );
}
