import { PostgresCoordinationStore } from "./postgres-store.js";
import { SqliteCoordinationStore } from "./sqlite-store.js";
import type { CoordinationStore } from "./store.js";

export interface CoordinationStoreOptions {
  /**
   * Postgres connection URL. When set, it wins over the SQLite path: a shared
   * database server is what lets several devices and users coordinate on the
   * same state. Callers typically pass `COORD_DATABASE_URL` through here.
   */
  databaseUrl?: string | undefined;
  /** SQLite database file used when no database URL is configured. */
  sqlitePath: string;
}

/**
 * Opens the configured store backend: Postgres when a database URL is
 * provided, the local SQLite file otherwise.
 */
export function openCoordinationStore(
  options: CoordinationStoreOptions,
): CoordinationStore {
  const url = options.databaseUrl?.trim() ?? "";
  if (url.length === 0) {
    return SqliteCoordinationStore.open(options.sqlitePath);
  }
  if (!/^postgres(?:ql)?:\/\//iu.test(url)) {
    throw new Error(
      "The coordination database URL must be a postgres:// or postgresql:// URL",
    );
  }
  return PostgresCoordinationStore.open(url);
}
