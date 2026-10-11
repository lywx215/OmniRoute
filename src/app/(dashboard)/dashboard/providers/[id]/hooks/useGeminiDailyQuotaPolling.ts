"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { resolveGeminiDailyQuotaPolicy } from "@/shared/utils/geminiDailyQuota";
import type { ConnectionRowConnection } from "../components/ConnectionRow";
import { getProviderConnectionsRequestUrl } from "../../providerPageUtils";

export function mergeGeminiDailyQuotaStatuses(
  current: ConnectionRowConnection[],
  incoming: ConnectionRowConnection[]
): ConnectionRowConnection[] {
  const statuses = new Map(
    incoming.map((connection) => [connection.id, connection.geminiDailyQuotaStatus])
  );
  let changed = false;
  const next = current.map((connection) => {
    if (!statuses.has(connection.id)) return connection;
    const status = statuses.get(connection.id);
    if (JSON.stringify(status) === JSON.stringify(connection.geminiDailyQuotaStatus))
      return connection;
    changed = true;
    return { ...connection, geminiDailyQuotaStatus: status };
  });
  return changed ? next : current;
}

export function useGeminiDailyQuotaPolling(
  providerId: string,
  connections: ConnectionRowConnection[],
  setConnections: Dispatch<SetStateAction<ConnectionRowConnection[]>>
): void {
  const enabled =
    providerId === "gemini" &&
    connections.some(
      (connection) => resolveGeminiDailyQuotaPolicy(connection.providerSpecificData).enabled
    );
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const poll = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const response = await fetch(getProviderConnectionsRequestUrl(providerId), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!disposed && Array.isArray(data.connections)) {
          setConnections((current) => mergeGeminiDailyQuotaStatuses(current, data.connections));
        }
      } catch {
        // Keep the last observed count when a refresh fails; retry on the next tick.
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), 30_000);
    const onVisibilityChange = () => void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, providerId, setConnections]);
}
