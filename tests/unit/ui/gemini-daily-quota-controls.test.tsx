// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeminiDailyQuotaProjection } from "@/lib/db/geminiDailyQuota";
import type { ConnectionRowConnection } from "@/app/(dashboard)/dashboard/providers/[id]/components/ConnectionRow";

const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/store/notificationStore", () => ({ useNotificationStore: () => notifications }));
vi.mock("next-intl", async () => {
  const { default: messages } = await import("@/i18n/messages/en.json");
  return {
    useTranslations:
      (namespace: "providers" | "common") => (key: string, values?: Record<string, unknown>) => {
        const catalog = messages[namespace] as Record<string, string>;
        let value = catalog[key] ?? key;
        for (const [name, replacement] of Object.entries(values ?? {}))
          value = value.replaceAll(`{${name}}`, String(replacement));
        return value;
      },
  };
});

import GeminiDailyQuotaDisplay from "@/app/(dashboard)/dashboard/providers/[id]/components/GeminiDailyQuotaDisplay";
import GeminiDailyQuotaSettings from "@/app/(dashboard)/dashboard/providers/[id]/components/modals/GeminiDailyQuotaSettings";
import GeminiDailyQuotaBulkButton from "@/app/(dashboard)/dashboard/providers/[id]/components/GeminiDailyQuotaBulkButton";
import {
  mergeGeminiDailyQuotaStatuses,
  useGeminiDailyQuotaPolling,
} from "@/app/(dashboard)/dashboard/providers/[id]/hooks/useGeminiDailyQuotaPolling";
import { getProxyConnectionRefreshKey } from "@/app/(dashboard)/dashboard/providers/[id]/hooks/providerConnectionRefreshKey";
import { resolveGeminiDailyQuotaPolicy } from "@/shared/utils/geminiDailyQuota";

const projection: GeminiDailyQuotaProjection = {
  enabled: true,
  flashRpd: 20,
  flashLiteRpd: 500,
  disableMinuteLimits: true,
  timeZone: "America/Los_Angeles",
  day: "2026-10-11",
  resetAt: "2026-10-12T07:00:00.000Z",
  models: [
    {
      model: "gemini-2.5-flash",
      used: 20,
      limit: 20,
      remaining: 0,
      exhausted: true,
      day: "2026-10-11",
      resetAt: "2026-10-12T07:00:00.000Z",
    },
    {
      model: "gemini-3-flash-preview",
      used: 1,
      limit: 20,
      remaining: 19,
      exhausted: false,
      day: "2026-10-11",
      resetAt: "2026-10-12T07:00:00.000Z",
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  notifications.success.mockClear();
  notifications.error.mockClear();
});

describe("Gemini daily request controls", () => {
  it("merges only quota counts while keeping edit state and proxy refresh keys stable", () => {
    const current: ConnectionRowConnection[] = [
      { id: "g1", provider: "gemini", name: "current", proxyEnabled: true },
    ];
    const refreshed = mergeGeminiDailyQuotaStatuses(current, [
      { id: "g1", name: "stale", geminiDailyQuotaStatus: projection },
    ]);
    expect(refreshed[0].name).toBe("current");
    expect(refreshed[0].geminiDailyQuotaStatus).toEqual(projection);
    expect(getProxyConnectionRefreshKey(refreshed)).toBe(getProxyConnectionRefreshKey(current));
    expect(mergeGeminiDailyQuotaStatuses(refreshed, refreshed)).toBe(refreshed);
  });

  it("shows each actual model independently and the Pacific midnight reset", () => {
    render(<GeminiDailyQuotaDisplay status={projection} />);
    expect(screen.getByText("gemini-2.5-flash")).toBeTruthy();
    expect(screen.getByText("20/20 used · 0 remaining")).toBeTruthy();
    expect(screen.getByText("1/20 used · 19 remaining")).toBeTruthy();
    expect(screen.getByText("Quota exhausted")).toBeTruthy();
    expect(screen.getByText("Resets 10/12, 00:00 PT")).toBeTruthy();
  });

  it("starts disabled and enables editable daily limits explicitly", () => {
    function Settings() {
      const [value, setValue] = useState(resolveGeminiDailyQuotaPolicy(undefined));
      return <GeminiDailyQuotaSettings value={value} onChange={setValue} />;
    }
    render(<Settings />);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Daily request limits" }));
    expect(
      screen.getByRole("spinbutton", { name: "Flash · RPD (Requests/day)" }).getAttribute("value")
    ).toBe("20");
    expect(
      screen
        .getByRole("spinbutton", { name: "Flash-Lite · RPD (Requests/day)" })
        .getAttribute("value")
    ).toBe("500");
    expect(
      screen
        .getByRole("switch", { name: "Skip local RPM / TPM limits" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("bulk apply sends only daily configuration to Gemini connections and refreshes after partial failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <GeminiDailyQuotaBulkButton
        connections={[
          { id: "g1", provider: "gemini" },
          { id: "g2", provider: "gemini" },
          { id: "o1", provider: "openai" },
        ]}
        onSaved={onSaved}
      />
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Apply daily limits to all Gemini connections (2)" })
      )
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/providers/g1",
      "/api/providers/g2",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      providerSpecificData: {
        geminiDailyQuota: {
          enabled: true,
          flashRpd: 20,
          flashLiteRpd: 500,
          disableMinuteLimits: true,
        },
      },
    });
    expect(notifications.error).toHaveBeenCalledWith("Updated 1 connections; 1 failed.");
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("polls only the connection endpoint while visible, refreshes on return and stops on unmount", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connections: [{ id: "g1", geminiDailyQuotaStatus: projection }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    function Polling() {
      const [connections, setConnections] = useState<ConnectionRowConnection[]>([
        {
          id: "g1",
          provider: "gemini",
          providerSpecificData: { geminiDailyQuota: { enabled: true } },
        },
      ]);
      useGeminiDailyQuotaPolling("gemini", connections, setConnections);
      return <GeminiDailyQuotaDisplay status={connections[0].geminiDailyQuotaStatus} />;
    }
    const mounted = render(<Polling />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/providers?provider=gemini");
    expect(screen.getByText("20/20 used · 0 remaining")).toBeTruthy();
    visibility = "hidden";
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    mounted.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start polling before daily limits are explicitly enabled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    function Polling() {
      const [connections, setConnections] = useState<ConnectionRowConnection[]>([
        { id: "g1", provider: "gemini" },
      ]);
      useGeminiDailyQuotaPolling("gemini", connections, setConnections);
      return null;
    }
    render(<Polling />);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
