#!/usr/bin/env node
/**
 * Manual verification for the Docker workspace backend.
 *
 * Everything the Docker path can be checked for without a daemon is covered by
 * the unit tests in services/workspace-manager. This script covers what only a
 * real daemon can answer: that the confinement flags are accepted, that the
 * bind mount round-trips, that --network none actually denies egress, and that
 * a full coordinated benchmark completes with the agent inside a container.
 *
 * Usage:
 *   docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
 *   npm run verify:docker
 *
 * Environment:
 *   COORD_AGENT_IMAGE  Image to verify. Defaults to coord/reference-agent:1.
 *   COORD_AGENT_USER   Passed through as --user. Needed on Linux when the
 *                      container uid cannot write the host worktree.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DockerWorkspaceManager } from "@coord/workspace-manager";
import { createBenchmarkFixture } from "@coord/cli/dist/fixture.js";
import { OVERLAP_SCENARIO } from "@coord/cli/dist/scenarios.js";
import { runCoordinatedFixture } from "@coord/cli/dist/benchmark.js";

const IMAGE = process.env.COORD_AGENT_IMAGE ?? "coord/reference-agent:1";
const USER = process.env.COORD_AGENT_USER;

let failures = 0;

function report(name, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function check(name, run) {
  try {
    const detail = await run();
    report(name, true, detail);
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error));
  }
}

function sandboxOptions() {
  return {
    image: IMAGE,
    ...(USER === undefined ? {} : { user: USER }),
  };
}

async function main() {
  console.log(`Verifying Docker sandbox with image ${IMAGE}\n`);

  const root = await mkdtemp(path.join(os.tmpdir(), "coord-docker-verify-"));
  try {
    const fixture = await createBenchmarkFixture(root, "verify", {
      scenario: OVERLAP_SCENARIO,
      liveAgent: {
        command: "node",
        args: ["/opt/agent/reference-agent.mjs"],
        taskIds: ["task_cap_value"],
        sandbox: sandboxOptions(),
      },
    });
    const docker = fixture.sandbox;
    if (!(docker instanceof DockerWorkspaceManager)) {
      throw new Error("The fixture did not build a Docker workspace manager");
    }

    await check("docker daemon is reachable", async () => {
      await docker.assertAvailable();
      return "docker version responded";
    });
    if (failures > 0) {
      console.log("\nDocker is unavailable; skipping the remaining checks.");
      process.exitCode = 1;
      return;
    }

    const baseVersion = await fixture.repositories.getCanonicalVersion(
      fixture.repository,
    );
    const workspace = await fixture.workspaces.create({
      taskId: "task_verify",
      rootPath: fixture.workspaceRoot,
      repository: fixture.repository,
      baseVersion,
    });

    try {
      await check("the workspace bind mount is readable", async () => {
        const result = await docker.runInWorkspace(workspace, {
          command: "node",
          args: [
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/workspace/src/counter.js','utf8'))",
          ],
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
        }
        if (!result.stdout.includes("export function increment")) {
          throw new Error("the worktree contents were not visible");
        }
        return "src/counter.js visible inside the container";
      });

      await check("the workspace bind mount is writable", async () => {
        const result = await docker.runInWorkspace(workspace, {
          command: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('/workspace/sandbox-probe.txt','written-in-container')",
          ],
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `${result.stderr.trim() || `exit ${result.exitCode}`}. ` +
              "On Linux set COORD_AGENT_USER to a uid that can write the host worktree.",
          );
        }
        const written = await readFile(
          path.join(workspace.path, "sandbox-probe.txt"),
          "utf8",
        );
        if (written !== "written-in-container") {
          throw new Error("the host did not observe the container's write");
        }
        return "container writes are visible on the host";
      });

      await check("outbound network access is denied", async () => {
        const result = await docker.runInWorkspace(workspace, {
          command: "node",
          args: [
            "-e",
            "require('node:dns').lookup('example.com',(e)=>{process.stdout.write(e?'DENIED':'REACHED');});",
          ],
        });
        if (result.stdout.includes("REACHED")) {
          throw new Error("the container resolved an external host");
        }
        if (!result.stdout.includes("DENIED")) {
          throw new Error(
            result.stderr.trim() || "the probe produced no verdict",
          );
        }
        return "--network none blocked DNS resolution";
      });

      await check("the worktree git pointer is masked", async () => {
        const result = await docker.runInWorkspace(workspace, {
          command: "node",
          args: [
            "-e",
            "const fs=require('node:fs');const s=fs.statSync('/workspace/.git');" +
              "process.stdout.write((s.isDirectory()?'DIR':'FILE')+':'+fs.readdirSync('/workspace/.git').length);",
          ],
        });
        if (!result.stdout.startsWith("DIR:0")) {
          throw new Error(
            `expected an empty directory, saw ${result.stdout || result.stderr.trim()}`,
          );
        }
        return "no host path is exposed through .git";
      });

      await check("the container root filesystem is read-only", async () => {
        const result = await docker.runInWorkspace(workspace, {
          command: "node",
          args: [
            "-e",
            "try{require('node:fs').writeFileSync('/rootfs-probe','x');" +
              "process.stdout.write('WRITABLE');}catch{process.stdout.write('READONLY');}",
          ],
        });
        if (!result.stdout.includes("READONLY")) {
          throw new Error("the container root filesystem accepted a write");
        }
        return "--read-only is in effect outside the workspace";
      });
    } finally {
      await fixture.workspaces.destroy(workspace);
    }

    await check("a coordinated run completes with a containerized agent", async () => {
      const result = await runCoordinatedFixture(fixture);
      if (result.metrics.tasksCompleted !== result.metrics.tasksPlanned) {
        throw new Error(
          `only ${result.metrics.tasksCompleted}/${result.metrics.tasksPlanned} tasks integrated`,
        );
      }
      const source = await fixture.repositories.readFile(
        fixture.repository,
        result.run.canonicalVersion.revision,
        "src/counter.js",
      );
      if (!/Math\.min\(Number\(value\) \+ 1, 10\)/u.test(source)) {
        throw new Error(`unexpected canonical source: ${source.trim()}`);
      }
      return `${result.metrics.tasksCompleted} tasks integrated`;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? "All sandbox checks passed." : `${failures} check(s) failed.`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
