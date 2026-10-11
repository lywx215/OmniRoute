import type { ConnectionRowConnection } from "../components/ConnectionRow";

/** Daily usage changes do not require reloading per-connection proxy assignments. */
export function getProxyConnectionRefreshKey(connections: ConnectionRowConnection[]): string {
  return connections
    .map(
      (connection) => `${connection.id}:${connection.proxyEnabled}:${connection.perKeyProxyEnabled}`
    )
    .join("|");
}
