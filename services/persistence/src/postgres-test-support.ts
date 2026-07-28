import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import pg from "pg";

const { Client } = pg;
const run = promisify(execFile);

/**
 * A real Postgres server for the contract tests.
 *
 * The suite prefers an explicit `COORD_TEST_POSTGRES_URL` (an admin-capable
 * URL, e.g. `postgresql://postgres:secret@127.0.0.1:5432/postgres`); without
 * one it manages a dockerized server. Each test creates and drops its own
 * database, so tests are isolated the same way each SQLite test gets a fresh
 * temporary file.
 */

const DEFAULT_CONTAINER = "coord-postgres-contract";
const IMAGE = "postgres:16-alpine";
const PASSWORD = "coordinator-contract";
const READY_TIMEOUT_MS = 90_000;

export interface PostgresTestServer {
  /** Connection URL for the admin `postgres` database. */
  adminUrl: string;
  /** Stops the dockerized server if this process started it. */
  stop(): Promise<void>;
}

export interface PostgresTestServerOptions {
  /**
   * Container name for the dockerized server. Suites that can run
   * concurrently (turbo runs packages in parallel) must use distinct names,
   * because each suite stops the container it started.
   */
  containerName?: string;
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 180_000 });
  return stdout.trim();
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker("version", "--format", "{{.Server.Version}}");
    return true;
  } catch {
    return false;
  }
}

async function containerRunning(container: string): Promise<boolean> {
  try {
    return (
      (await docker("inspect", "--format", "{{.State.Running}}", container)) ===
      "true"
    );
  } catch {
    return false;
  }
}

async function mappedPort(container: string): Promise<number> {
  // May report several bindings (IPv4 and IPv6); any line carries the port.
  const output = await docker("port", container, "5432/tcp");
  const first = output.split(/\r?\n/u)[0] ?? "";
  const port = Number.parseInt(first.slice(first.lastIndexOf(":") + 1), 10);
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new Error(`Could not determine the mapped Postgres port: ${output}`);
  }
  return port;
}

async function waitUntilReady(adminUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  // Poll with a real connection: pg_isready can answer during the image's
  // initialization phase, before the server restarts into its final state.
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: adminUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(
    `Postgres test server did not become ready within ${READY_TIMEOUT_MS}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Ensures a Postgres server is reachable and returns its admin URL.
 *
 * Returns `undefined` only when Docker itself is unavailable and no
 * `COORD_TEST_POSTGRES_URL` is configured; any failure after Docker is
 * detected throws, so a broken environment fails the suite instead of
 * silently skipping the backend.
 */
export async function startPostgresTestServer(
  options: PostgresTestServerOptions = {},
): Promise<PostgresTestServer | undefined> {
  const configured = process.env["COORD_TEST_POSTGRES_URL"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return { adminUrl: configured, stop: async () => undefined };
  }

  if (!(await dockerAvailable())) {
    return undefined;
  }

  const container = options.containerName ?? DEFAULT_CONTAINER;
  let startedByUs = false;
  if (!(await containerRunning(container))) {
    // A stopped leftover container (created without --rm by a crashed run of
    // an older revision) would block the name; clear it before creating.
    await docker("rm", "-f", container).catch(() => undefined);
    await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1:0:5432",
      IMAGE,
    );
    startedByUs = true;
  }

  const port = await mappedPort(container);
  const adminUrl = `postgresql://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
  await waitUntilReady(adminUrl);
  return {
    adminUrl,
    stop: async () => {
      if (startedByUs) {
        await docker("rm", "-f", container).catch(() => undefined);
      }
    },
  };
}

async function withAdmin<T>(
  adminUrl: string,
  body: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

export interface ScratchDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Creates a uniquely named empty database and a way to drop it. */
export async function createScratchDatabase(
  adminUrl: string,
): Promise<ScratchDatabase> {
  const name = `coord_contract_${randomUUID().replaceAll("-", "")}`;
  await withAdmin(adminUrl, (client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      // FORCE evicts any connection a failed test left behind.
      await withAdmin(adminUrl, (client) =>
        client.query(`DROP DATABASE ${name} WITH (FORCE)`),
      );
    },
  };
}
