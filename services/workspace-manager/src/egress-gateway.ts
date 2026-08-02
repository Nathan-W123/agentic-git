import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "@coord/repository-service";

import type { ProcessRunner } from "./docker-workspace-manager.js";

/**
 * Per-task egress allowlist for sandboxed containers.
 *
 * The sandbox's default is `--network none`, which is the right posture for an
 * agent that needs nothing off-host. A vendor CLI needs exactly one thing: its
 * own provider's API. Widening the container to a bridged network to get that
 * would trade deny-default egress for unrestricted egress, so instead the agent
 * is put on an `--internal` network — which has no route off the host at all —
 * together with one proxy container that is also attached to a bridged network.
 * The proxy is therefore the only way out, and it serves `CONNECT` only, to
 * allowlisted hosts only.
 *
 * Two layers, and the outer one does not depend on the agent's cooperation.
 * The proxy environment variables are what make the allowed traffic *work*; the
 * internal network is what makes everything else *fail*. A CLI that ignored
 * `HTTPS_PROXY` entirely would reach nothing rather than reaching everything,
 * so a client that does not honour the convention is a functionality problem
 * and never a containment one.
 *
 * What this cannot do is bound a request within an allowed host. `CONNECT`
 * carries a host and a port and the tunnel is opaque afterwards, which is the
 * same property that keeps the proxy from seeing credentials in flight.
 */
export interface EgressGatewayOptions {
  /**
   * Hosts the container may reach. An entry starting with `.` matches
   * subdomains of it but not the bare apex.
   */
  allow: readonly string[];
  /** Image the proxy runs in. Needs `node` on PATH and nothing else. */
  image: string;
  docker?: string;
  /** Host path of `egress-proxy.mjs`. Resolved from this package when omitted. */
  proxyScriptPath?: string;
  /** Port the proxy listens on inside the network. Defaults to 3128. */
  listenPort?: number;
  /** Destination ports the proxy will dial. Defaults to `[443]`. */
  destinationPorts?: readonly number[];
  memory?: string;
  cpus?: string;
  /** How long to wait for the proxy to report itself listening. */
  readyTimeoutMs?: number;
}

/** What a started gateway hands to {@link DockerWorkspaceManager}. */
export interface EgressBinding {
  /** Internal Docker network the agent container must join. */
  network: string;
  /** Proxy URL, as the agent container resolves it. */
  proxyUrl: string;
  /** Destinations that must bypass the proxy. */
  noProxy: string;
}

/** DNS alias the proxy answers to on the internal network. */
const PROXY_ALIAS = "egress-proxy";
const CONTAINER_SCRIPT_PATH = "/opt/coord/egress-proxy.mjs";
const LABEL = "coord.egress-gateway";

const HOSTNAME_PATTERN =
  /^\.?(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/**
 * Validates one allowlist entry.
 *
 * Deliberately refuses IP literals and anything carrying a scheme, port, or
 * path. The proxy matches the CONNECT authority as a string, so an entry it
 * could never equal is a configuration error that would otherwise present as
 * an unexplained network failure at run time.
 */
export function assertAllowlistEntry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("Egress allowlist entries must not be empty");
  }
  if (!HOSTNAME_PATTERN.test(normalized)) {
    throw new Error(
      `Egress allowlist entries must be hostnames, optionally dot-prefixed ` +
        `for subdomains: ${value}`,
    );
  }
  if (normalized === ".") {
    throw new Error("Egress allowlist entry \".\" would match every host");
  }
  return normalized;
}

function assertName(value: string, label: string): string {
  if (value.length === 0 || /[\s\0]/u.test(value) || value.startsWith("-")) {
    throw new Error(`Egress gateway ${label} is not a usable Docker token: ${value}`);
  }
  return value;
}

/**
 * Locates `infrastructure/docker/egress-proxy.mjs` by walking up from this
 * module.
 *
 * Resolved by search rather than by a fixed relative path because this file is
 * imported from `dist/` after a build and from `src/` under the test runner,
 * and those sit at different depths below the repository root.
 */
export async function resolveProxyScriptPath(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(
      directory,
      "infrastructure",
      "docker",
      "egress-proxy.mjs",
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(
          "Could not locate infrastructure/docker/egress-proxy.mjs; pass " +
            "proxyScriptPath explicitly",
        );
      }
      directory = parent;
    }
  }
}

interface ResolvedGatewayOptions {
  allow: readonly string[];
  image: string;
  docker: string;
  proxyScriptPath: string | undefined;
  listenPort: number;
  destinationPorts: readonly number[];
  memory: string;
  cpus: string;
  readyTimeoutMs: number;
}

export class EgressGateway {
  private readonly options: ResolvedGatewayOptions;
  private readonly id: string;
  private readonly networkName: string;
  private readonly containerName: string;
  private started = false;

  public constructor(
    options: EgressGatewayOptions,
    private readonly runner: ProcessRunner = runProcess,
  ) {
    if (options.allow.length === 0) {
      throw new Error(
        "An egress gateway needs at least one allowed host; omit the gateway " +
          "entirely to keep --network none",
      );
    }
    const listenPort = options.listenPort ?? 3128;
    if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65_535) {
      throw new Error("Egress gateway listen port must be a valid TCP port");
    }
    const destinationPorts = options.destinationPorts ?? [443];
    for (const port of destinationPorts) {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error("Egress gateway destination ports must be valid TCP ports");
      }
    }

    this.options = {
      allow: options.allow.map(assertAllowlistEntry),
      image: assertName(options.image, "image"),
      docker: options.docker ?? "docker",
      proxyScriptPath: options.proxyScriptPath,
      listenPort,
      destinationPorts,
      memory: assertName(options.memory ?? "256m", "memory limit"),
      cpus: assertName(options.cpus ?? "1", "cpu limit"),
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
    };

    this.id = randomBytes(6).toString("hex");
    this.networkName = `coord-egress-${this.id}`;
    this.containerName = `coord-egress-proxy-${this.id}`;
  }

  /** What the agent container joins. Valid only after {@link start}. */
  public binding(): EgressBinding {
    if (!this.started) {
      throw new Error("The egress gateway has not been started");
    }
    return {
      network: this.networkName,
      proxyUrl: `http://${PROXY_ALIAS}:${this.options.listenPort}`,
      noProxy: `localhost,127.0.0.1,${PROXY_ALIAS}`,
    };
  }

  public async start(): Promise<EgressBinding> {
    if (this.started) {
      throw new Error("The egress gateway is already started");
    }
    const scriptPath =
      this.options.proxyScriptPath ?? (await resolveProxyScriptPath());
    const mountSource = path.resolve(scriptPath).replaceAll("\\", "/");

    // The internal network first: if anything below fails, the agent has no
    // network to be placed on, so a half-built gateway cannot present as a
    // working one.
    await this.docker([
      "network",
      "create",
      "--internal",
      "--label",
      `${LABEL}=${this.id}`,
      this.networkName,
    ]);

    try {
      // Started on the default bridge, which is the proxy's route out. The
      // internal network is attached afterwards so that the proxy — and only
      // the proxy — is on both.
      await this.docker([
        "run",
        "--detach",
        "--name",
        this.containerName,
        "--label",
        `${LABEL}=${this.id}`,
        "--network",
        "bridge",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        this.options.memory,
        "--cpus",
        this.options.cpus,
        "--pids-limit",
        "128",
        "--env",
        `COORD_EGRESS_ALLOW=${this.options.allow.join(",")}`,
        "--env",
        `COORD_EGRESS_PORT=${this.options.listenPort}`,
        "--env",
        `COORD_EGRESS_PORTS=${this.options.destinationPorts.join(",")}`,
        "--volume",
        `${mountSource}:${CONTAINER_SCRIPT_PATH}:ro`,
        "--entrypoint",
        "node",
        this.options.image,
        CONTAINER_SCRIPT_PATH,
      ]);

      await this.docker([
        "network",
        "connect",
        "--alias",
        PROXY_ALIAS,
        this.networkName,
        this.containerName,
      ]);

      await this.waitUntilListening();
    } catch (error) {
      // A gateway that failed to come up must not leave a network and a dead
      // container behind for the next run to collide with.
      await this.cleanup();
      throw error;
    }

    this.started = true;
    return this.binding();
  }

  public async stop(): Promise<void> {
    await this.cleanup();
    this.started = false;
  }

  /** Proxy decisions so far, one JSON object per line. */
  public async auditLog(): Promise<string> {
    const result = await this.runner(
      this.options.docker,
      ["logs", this.containerName],
      { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
    );
    return `${result.stdout}${result.stderr}`;
  }

  private async waitUntilListening(): Promise<void> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    let lastLogs = "";
    for (;;) {
      lastLogs = await this.auditLog();
      if (lastLogs.includes('"event":"listening"')) {
        return;
      }
      // A proxy that rejected its own configuration exits immediately; polling
      // for a line it will never print would burn the whole timeout instead of
      // surfacing the reason it refused to start.
      const running = await this.runner(
        this.options.docker,
        ["inspect", "--format", "{{.State.Running}}", this.containerName],
        { timeoutMs: 10_000, maxOutputBytes: 4096 },
      );
      if (running.stdout.trim() === "false") {
        throw new Error(
          `The egress proxy exited before listening: ${lastLogs.trim() || "no output"}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The egress proxy did not start within ${this.options.readyTimeoutMs}ms: ` +
            `${lastLogs.trim() || "no output"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * Removes the container and network, ignoring "already gone".
   *
   * Both are attempted even if the first fails, because leaving the network
   * behind would block the next gateway that happens to draw the same id and
   * would keep an internal network attached to nothing.
   */
  private async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const args of [
      ["rm", "--force", "--volumes", this.containerName],
      ["network", "rm", this.networkName],
    ]) {
      try {
        await this.runner(this.options.docker, args, {
          timeoutMs: 30_000,
          maxOutputBytes: 65_536,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 2) {
      throw new AggregateError(errors, "Egress gateway cleanup failed");
    }
  }

  private async docker(args: readonly string[]): Promise<string> {
    const result = await this.runner(this.options.docker, args, {
      timeoutMs: 60_000,
      maxOutputBytes: 262_144,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `docker ${args[0]} ${args[1] ?? ""} failed: ` +
          `${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
      );
    }
    return result.stdout.trim();
  }
}
