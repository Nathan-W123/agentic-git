/**
 * What happens to the control plane when its database blinks.
 *
 * A hosted deployment's Postgres restarts. It is upgraded, it fails over, an
 * administrator terminates a backend, a load balancer reaps a socket that has
 * been idle too long. None of that is unusual and none of it should be
 * interesting: `pg.Pool` discards the dead client and the next query opens a
 * fresh one.
 *
 * It was interesting here, because `pg.Pool` is an `EventEmitter` and reports
 * that discard by emitting `error` — and an `error` event with no listener is
 * not an event, it is a throw. Thrown from a socket callback, with no caller
 * awaiting anything, it reached nothing that could catch it and took the
 * process out. So the entire control plane exited every time its database
 * blinked, over a condition the pool had already recovered from, leaving a
 * stack trace inside `pg-protocol` and nothing at all pointing at the cause.
 *
 * These tests are the real thing rather than a simulation of it: a live
 * connection is terminated from a second session, exactly the way a restart
 * terminates one, and the store is asked to keep working afterwards.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import pg from "pg";

import { PostgresCoordinationStore } from "./postgres-store.js";
import {
  createScratchDatabase,
  startPostgresTestServer,
} from "./postgres-test-support.js";

// Its own container, because `node --test` runs the files in a package
// concurrently and `stop()` is a `docker rm -f`. Sharing the default name
// with `store-contract.test.ts` means whichever of the two finishes first
// destroys the server the other is still using — which is exactly what
// happened: every Postgres test in this package went red on CI while
// passing against a server that was already running locally, because a
// local `COORD_TEST_POSTGRES_URL` never starts or stops a container at all.
// `worker-operations.test.ts` names its own for the same reason.
const server =
  process.env["COORD_SKIP_POSTGRES_TESTS"] === "1"
    ? undefined
    : await startPostgresTestServer({
        containerName: "coord-postgres-resilience",
      });

if (server === undefined) {
  console.warn(
    "postgres: resilience tests skipped (Docker is unavailable and " +
      "COORD_TEST_POSTGRES_URL is not set)",
  );
} else {
  after(async () => {
    await server.stop();
  });

  /** Kills every backend on `database` except the one doing the killing. */
  async function terminateBackends(
    adminUrl: string,
    database: string,
  ): Promise<number> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const killed = await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database],
      );
      return killed.rowCount ?? 0;
    } finally {
      await client.end();
    }
  }

  test("a terminated connection is survived, remembered, and recovered from", async () => {
    const scratch = await createScratchDatabase(server.adminUrl);
    const database = new URL(scratch.url).pathname.slice(1);
    const store = PostgresCoordinationStore.open(scratch.url);
    try {
      // A real query first, so the pool is actually holding a connection to
      // kill. Until something has run, there is nothing for a restart to
      // interrupt and the test would pass over a broken store.
      await store.ping();
      assert.equal(store.lastConnectionLoss(), undefined);

      const killed = await terminateBackends(server.adminUrl, database);
      assert.ok(
        killed > 0,
        "the store should be holding a connection for the restart to take",
      );

      // The event is emitted from a socket callback, so it lands on a turn of
      // its own rather than inside the await above. Give it one.
      await new Promise((resolve) => setImmediate(resolve));

      // Still here. Before the listener existed, the process was already gone
      // by this line and this file reported an uncaught exception.
      const loss = store.lastConnectionLoss();
      assert.notEqual(
        loss,
        undefined,
        "a lost connection should be recorded, not only survived",
      );
      assert.match(loss?.at ?? "", /^\d{4}-\d{2}-\d{2}T/u);
      assert.ok((loss?.message ?? "").length > 0);

      // And the store works again, because the pool opens a fresh connection
      // rather than reusing the one that died. A handler that swallowed the
      // error but left the pool broken would pass every assertion above.
      await store.ping();
    } finally {
      await store.close();
      await scratch.drop();
    }
  });

  test("ping fails rather than lying when the database is gone", async () => {
    // The other half of the contract. A readiness answer built on a probe
    // that cannot fail is worse than no readiness answer: it reports ready
    // through an outage, which is the one moment anybody reads it.
    const scratch = await createScratchDatabase(server.adminUrl);
    const store = PostgresCoordinationStore.open(scratch.url);
    await store.ping();
    await scratch.drop();
    await assert.rejects(async () => {
      await store.ping();
    });
    await store.close();
  });
}
