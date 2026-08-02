import assert from "node:assert/strict";
import test from "node:test";

import type { ProcessOptions, ProcessOutput } from "@coord/repository-service";

import {
  EgressGateway,
  assertAllowlistEntry,
  resolveProxyScriptPath,
} from "./egress-gateway.js";

interface Call {
  executable: string;
  args: string[];
}

/**
 * Stands in for the Docker CLI.
 *
 * `logs` answers with a listening banner by default so `start()` completes;
 * individual tests override the script to drive the failure paths.
 */
function recordingRunner(
  responses: (call: Call) => Partial<ProcessOutput> | undefined = () => undefined,
): { runner: (e: string, a: readonly string[], o?: ProcessOptions) => Promise<ProcessOutput>; calls: Call[] } {
  const calls: Call[] = [];
  const runner = async (
    executable: string,
    args: readonly string[],
  ): Promise<ProcessOutput> => {
    const call = { executable, args: [...args] };
    calls.push(call);
    const override = responses(call);
    const base: ProcessOutput = {
      exitCode: 0,
      stdout: args[0] === "logs" ? '{"event":"listening","port":3128}' : "",
      stderr: "",
      durationMs: 1,
    };
    return { ...base, ...override };
  };
  return { runner, calls };
}

function argsOf(calls: Call[], ...prefix: string[]): string[] | undefined {
  return calls.find((call) =>
    prefix.every((token, index) => call.args[index] === token),
  )?.args;
}

test("allowlist entries are hostnames, dot-prefixed for subdomains", () => {
  assert.equal(assertAllowlistEntry("API.Anthropic.com"), "api.anthropic.com");
  assert.equal(assertAllowlistEntry(" .googleapis.com "), ".googleapis.com");

  for (const rejected of [
    "",
    "   ",
    ".",
    "https://api.anthropic.com",
    "api.anthropic.com:443",
    "api.anthropic.com/v1",
    "api anthropic com",
    "-leading-dash.test",
  ]) {
    assert.throws(
      () => assertAllowlistEntry(rejected),
      /allowlist/iu,
      `expected ${JSON.stringify(rejected)} to be refused`,
    );
  }
});

test("a gateway refuses to exist without an allowlist", () => {
  assert.throws(
    () => new EgressGateway({ allow: [], image: "img" }),
    /at least one allowed host/u,
  );
});

test("the proxy script ships with the repository", async () => {
  const resolved = await resolveProxyScriptPath();
  assert.match(resolved.replaceAll("\\", "/"), /infrastructure\/docker\/egress-proxy\.mjs$/u);
});

test("starting a gateway builds an internal network and a dual-homed proxy", async () => {
  const { runner, calls } = recordingRunner();
  const gateway = new EgressGateway(
    { allow: ["api.anthropic.com"], image: "coord/agent:1", proxyScriptPath: "/tmp/egress-proxy.mjs" },
    runner,
  );

  const binding = await gateway.start();

  const network = argsOf(calls, "network", "create");
  assert.ok(network !== undefined, "no network was created");
  // Without --internal the agent would have a route off the host that does not
  // pass through the proxy, and the allowlist would be advisory.
  assert.ok(network.includes("--internal"), "the network was not internal");
  assert.ok(network.at(-1)?.startsWith("coord-egress-"));

  const run = argsOf(calls, "run");
  assert.ok(run !== undefined, "the proxy container was not started");
  assert.ok(run.includes("--detach"));
  // Started on a bridged network: the proxy is the one container that has one.
  assert.deepEqual(
    run.slice(run.indexOf("--network"), run.indexOf("--network") + 2),
    ["--network", "bridge"],
  );
  assert.ok(run.includes("COORD_EGRESS_ALLOW=api.anthropic.com"));
  assert.ok(run.includes("COORD_EGRESS_PORTS=443"));
  assert.ok(run.includes("--read-only"));
  assert.ok(run.includes("--cap-drop") && run.includes("ALL"));
  assert.ok(
    run.some((arg) => arg.endsWith(":/opt/coord/egress-proxy.mjs:ro")),
    "the proxy script was not mounted read-only",
  );

  const connect = argsOf(calls, "network", "connect");
  assert.ok(connect !== undefined, "the proxy never joined the internal network");
  assert.ok(connect.includes("--alias") && connect.includes("egress-proxy"));

  assert.equal(binding.network, network.at(-1));
  assert.equal(binding.proxyUrl, "http://egress-proxy:3128");
  assert.match(binding.noProxy, /127\.0\.0\.1/u);
});

test("a proxy that exits before listening reports why, and cleans up", async () => {
  const { runner, calls } = recordingRunner((call) => {
    if (call.args[0] === "logs") {
      return { stdout: '{"event":"fatal","reason":"COORD_EGRESS_ALLOW is empty"}' };
    }
    if (call.args[0] === "inspect") {
      return { stdout: "false\n" };
    }
    return undefined;
  });
  const gateway = new EgressGateway(
    { allow: ["api.anthropic.com"], image: "img", proxyScriptPath: "/tmp/p.mjs" },
    runner,
  );

  await assert.rejects(
    async () => await gateway.start(),
    /exited before listening/u,
  );

  // A failed start must not strand an internal network and a dead container.
  assert.ok(argsOf(calls, "rm", "--force") !== undefined, "the container was not removed");
  assert.ok(argsOf(calls, "network", "rm") !== undefined, "the network was not removed");
});

test("a failed docker command surfaces its stderr", async () => {
  const { runner } = recordingRunner((call) =>
    call.args[0] === "network" && call.args[1] === "create"
      ? { exitCode: 1, stderr: "permission denied" }
      : undefined,
  );
  const gateway = new EgressGateway(
    { allow: ["api.anthropic.com"], image: "img", proxyScriptPath: "/tmp/p.mjs" },
    runner,
  );

  await assert.rejects(async () => await gateway.start(), /permission denied/u);
});

test("a binding is unavailable until the gateway has started", () => {
  const { runner } = recordingRunner();
  const gateway = new EgressGateway(
    { allow: ["api.anthropic.com"], image: "img" },
    runner,
  );
  assert.throws(() => gateway.binding(), /has not been started/u);
});
