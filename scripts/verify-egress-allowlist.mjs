#!/usr/bin/env node
/**
 * Live verification for the per-task egress allowlist and credential mounts.
 *
 * The allowlist *decision* — which hosts the proxy admits — is unit-tested in
 * process over real sockets by `services/workspace-manager` and needs no
 * daemon. What only a live daemon can answer is the containment claim: that a
 * container on the gateway's internal network has no route off the host except
 * through the proxy, so an agent that ignores the proxy variables reaches
 * nothing rather than everything.
 *
 * That is what this script checks, and it does it with DNS and TCP probes
 * rather than any model call, so it costs nothing but a few containers.
 *
 * Usage:
 *   docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
 *   npm run verify:egress
 *
 * Environment:
 *   COORD_AGENT_IMAGE  Image to verify. Defaults to coord/reference-agent:1.
 *   COORD_EGRESS_HOST  Allowlisted host to probe. Defaults to api.anthropic.com.
 *   COORD_BLOCKED_HOST Host that must stay unreachable. Defaults to example.com.
 *
 * The allowlisted probe opens a TCP connection and closes it without sending a
 * request, so it authenticates nothing and spends nothing.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DockerWorkspaceManager,
  EgressGateway,
  openVendorSandbox,
  resolveVendorCredentials,
} from "@coord/workspace-manager";

const IMAGE = process.env.COORD_AGENT_IMAGE ?? "coord/reference-agent:1";
const ALLOWED_HOST = process.env.COORD_EGRESS_HOST ?? "api.anthropic.com";
const BLOCKED_HOST = process.env.COORD_BLOCKED_HOST ?? "example.com";

let failures = 0;

function report(name, ok, detail) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

async function check(name, run) {
  try {
    report(name, true, await run());
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** Runs a Node snippet in a container on the gateway's network. */
async function probe(manager, source) {
  const result = await manager.runInWorkspace(undefined, {
    command: "node",
    args: ["-e", source],
  });
  return `${result.stdout}${result.stderr}`;
}

/**
 * Connects to `host:443` and reports whether the TCP handshake completed.
 *
 * Run through the proxy variables the container was given, so this exercises
 * the same path a vendor CLI would take.
 */
function tcpProbeSource(host) {
  return `
const net = require('node:net');
const url = new URL(process.env.HTTPS_PROXY);
const socket = net.connect(Number(url.port), url.hostname);
let buffer = '';
socket.setTimeout(15000, () => { process.stdout.write('TIMEOUT'); process.exit(0); });
socket.on('connect', () => {
  socket.write('CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n');
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (buffer.includes('\\r\\n')) {
    process.stdout.write(buffer.split('\\r\\n')[0]);
    socket.destroy();
    process.exit(0);
  }
});
socket.on('error', (e) => { process.stdout.write('PROXY_UNREACHABLE:' + e.code); process.exit(0); });
`;
}

/** Tries to reach a host directly, bypassing the proxy entirely. */
function directProbeSource(host) {
  return `
const net = require('node:net');
const dns = require('node:dns');
dns.lookup('${host}', (err, address) => {
  if (err) { process.stdout.write('DNS_DENIED:' + err.code); process.exit(0); }
  const socket = net.connect(443, address);
  socket.setTimeout(8000, () => { process.stdout.write('TCP_DENIED:timeout'); process.exit(0); });
  socket.on('connect', () => { process.stdout.write('REACHED'); process.exit(0); });
  socket.on('error', (e) => { process.stdout.write('TCP_DENIED:' + e.code); process.exit(0); });
});
`;
}

async function main() {
  console.log(`Verifying the egress allowlist with image ${IMAGE}\n`);

  const gateway = new EgressGateway({ allow: [ALLOWED_HOST], image: IMAGE });

  await check("docker daemon is reachable", async () => {
    await new DockerWorkspaceManager({ image: IMAGE }).assertAvailable();
    return "docker version responded";
  });
  if (failures > 0) {
    console.log("\nDocker is unavailable; skipping the remaining checks.");
    process.exitCode = 1;
    return;
  }

  let binding;
  await check("the egress gateway starts", async () => {
    binding = await gateway.start();
    return `network ${binding.network}, proxy ${binding.proxyUrl}`;
  });
  if (binding === undefined) {
    process.exitCode = 1;
    return;
  }

  const manager = new DockerWorkspaceManager({ image: IMAGE, egress: binding });

  try {
    await check(`the allowlisted host ${ALLOWED_HOST} is reachable`, async () => {
      const output = await probe(manager, tcpProbeSource(ALLOWED_HOST));
      if (!output.includes("200")) {
        throw new Error(`expected a 200 from the proxy, saw: ${output.trim()}`);
      }
      return "the proxy established a tunnel";
    });

    await check(`the non-allowlisted host ${BLOCKED_HOST} is refused`, async () => {
      const output = await probe(manager, tcpProbeSource(BLOCKED_HOST));
      if (output.includes("200")) {
        throw new Error("the proxy tunnelled a host that is not allowlisted");
      }
      if (!output.includes("403")) {
        throw new Error(`expected a 403 from the proxy, saw: ${output.trim()}`);
      }
      return "the proxy answered 403";
    });

    // The load-bearing one. Everything above tests the proxy's manners; this
    // tests that the proxy cannot simply be stepped around.
    await check("a container cannot bypass the proxy", async () => {
      const output = await probe(manager, directProbeSource(ALLOWED_HOST));
      if (output.includes("REACHED")) {
        throw new Error(
          "the container opened a direct connection off the host; the " +
            "network is not internal and the allowlist is only advisory",
        );
      }
      return `direct egress refused (${output.trim()})`;
    });

    await check("the proxy audit log records both decisions", async () => {
      const log = await gateway.auditLog();
      if (!log.includes('"event":"allowed"')) {
        throw new Error("no admitted host was recorded");
      }
      if (!log.includes('"event":"denied"')) {
        throw new Error("no refusal was recorded");
      }
      return "allow and deny are both auditable";
    });
  } finally {
    await gateway.stop();
  }

  // Credential mounting, checked against a fake home so no real token is
  // copied anywhere by this script.
  await check("only the named credential file is mounted", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coord-verify-home-"));
    try {
      await writeFile(path.join(home, "decoy.json"), "SHOULD NOT APPEAR", "utf8");
      const codexDir = path.join(home, ".codex");
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        path.join(codexDir, "auth.json"),
        '{"probe":"credential-visible"}',
        "utf8",
      );

      const plan = await resolveVendorCredentials("codex", {
        home,
        mode: "read-only",
      });
      const mounted = new DockerWorkspaceManager({
        image: IMAGE,
        credentialMounts: plan.mounts,
        tmpfs: ["/tmp", ...plan.tmpfs],
        env: plan.env,
      });

      const seen = await probe(
        mounted,
        "const fs=require('node:fs');" +
          "process.stdout.write(fs.readFileSync('/home/agent/.codex/auth.json','utf8'));" +
          "process.stdout.write('|'+fs.readdirSync('/home/agent').join(','));",
      );
      if (!seen.includes("credential-visible")) {
        throw new Error(`the credential was not readable: ${seen.trim()}`);
      }
      if (seen.includes("decoy.json")) {
        throw new Error("the whole home directory was exposed");
      }
      return "the credential is present and the rest of the home is not";
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  await check("openVendorSandbox composes the gateway and the mounts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coord-verify-home2-"));
    try {
      const codexDir = path.join(home, ".codex");
      await mkdir(codexDir, { recursive: true });
      await writeFile(path.join(codexDir, "auth.json"), "{}", "utf8");

      const vendor = await openVendorSandbox({
        kind: "codex",
        base: { image: IMAGE },
        allow: [ALLOWED_HOST],
        home,
      });
      try {
        const composed = new DockerWorkspaceManager(vendor.options);
        const output = await probe(composed, tcpProbeSource(BLOCKED_HOST));
        if (!output.includes("403")) {
          throw new Error(`expected a refusal, saw: ${output.trim()}`);
        }
        return `allowlist ${vendor.allow.join(", ")} enforced through the composed sandbox`;
      } finally {
        await vendor.release();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  console.log(
    `\n${failures === 0 ? "All egress checks passed." : `${failures} check(s) failed.`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
