#!/usr/bin/env node

import path from "node:path";

import { CoordinatorProject } from "@coord/cli/project";

import { WorkerClient } from "./client.js";
import { Worker } from "./worker.js";

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required to start a worker`);
  }
  return value;
}

async function main(): Promise<void> {
  const serverUrl = required("COORD_SERVER");
  const token = required("COORD_TOKEN");
  const project = await CoordinatorProject.open(
    process.env["COORD_PROJECT_ROOT"] ?? process.cwd(),
  );

  const worker = new Worker({
    client: new WorkerClient({ serverUrl, token }),
    project,
    organizationId: required("COORD_ORGANIZATION"),
    workspaceRoot:
      process.env["COORD_WORKER_ROOT"] ??
      path.join(project.directory, "worker"),
    ...(process.env["COORD_WORKER_NAME"] === undefined
      ? {}
      : { name: process.env["COORD_WORKER_NAME"] }),
    ...((process.env["COORD_PROJECT_ID"] ?? process.env["COORD_PROJECT"]) ===
    undefined
      ? {}
      : {
          projectId:
            process.env["COORD_PROJECT_ID"] ??
            process.env["COORD_PROJECT"] ??
            "",
        }),
    ...(process.env["COORD_REPOSITORY"] === undefined
      ? {}
      : { repositoryId: process.env["COORD_REPOSITORY"] }),
  });

  const id = await worker.register();
  console.log(`Worker ${id} polling ${serverUrl}`);

  // A planned shutdown hands the lease back so the task is picked up again
  // immediately, instead of waiting out the expiry.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void worker.stop().then(() => process.exit(0));
    });
  }
  await worker.run();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
