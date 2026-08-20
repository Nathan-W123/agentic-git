import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DockerSandboxOptions } from "./docker-workspace-manager.js";
import { EgressGateway, type EgressGatewayOptions } from "./egress-gateway.js";
import {
  resolveVendorCredentials,
  type CredentialMountMode,
  type VendorCliKind,
} from "./vendor-credentials.js";

/**
 * Starting allowlists for each vendor CLI.
 *
 * These are a **starting point, not a specification**. No vendor documents the
 * full set of hosts its CLI dials, and the set changes with releases, so a
 * hard-coded list is a guess that ages. What makes that tolerable is the
 * proxy's audit log: every refusal is recorded with the host that was
 * attempted, so the correct list for a given CLI version is read off a run
 * rather than guessed at. Treat a `denied` entry as the instruction to widen
 * this, and prefer adding the exact host over a dot-prefixed parent.
 */
export const DEFAULT_EGRESS_ALLOWLISTS: Record<VendorCliKind, readonly string[]> =
  {
    codex: ["api.openai.com", "auth.openai.com", "chatgpt.com"],
    claude: ["api.anthropic.com", "statsig.anthropic.com"],
    gemini: [
      "generativelanguage.googleapis.com",
      "oauth2.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ],
    cursor: ["api2.cursor.sh", "authenticator.cursor.sh", "cursor.com"],
    copilot: ["api.github.com", "github.com", "api.githubcopilot.com"],
    kiro: [
      "auth.us-east-1.amazoncognito.com",
      "oidc.us-east-1.amazonaws.com",
      "q.us-east-1.amazonaws.com",
    ],
  };

/**
 * Confirms the container is strong enough to be the only security boundary.
 *
 * This is the precondition behind running a vendor CLI with its own sandbox
 * disabled. "Keep sandboxing on" is satisfied by moving which layer provides
 * it, but only if the remaining layer actually provides it — a container with
 * a writable root or retained capabilities does not, and disabling the CLI's
 * own confinement on top of that would remove sandboxing rather than relocate
 * it.
 */
export function assertContainerIsSoleBoundary(
  options: DockerSandboxOptions,
): void {
  const weakened: string[] = [];
  if (options.readOnlyRootFilesystem === false) {
    weakened.push("readOnlyRootFilesystem is disabled");
  }
  if (options.dropCapabilities === false) {
    weakened.push("dropCapabilities is disabled");
  }
  if (options.noNewPrivileges === false) {
    weakened.push("noNewPrivileges is disabled");
  }
  if (options.network !== undefined && options.network !== "none") {
    weakened.push(`network is widened to ${options.network}`);
  }
  if (weakened.length > 0) {
    throw new Error(
      "This sandbox cannot be the sole confinement boundary for a vendor CLI " +
        `because ${weakened.join(", ")}. Restore the sandbox defaults, or run ` +
        "the CLI on the host under its own sandbox instead.",
    );
  }
}

export interface VendorSandboxOptions {
  kind: VendorCliKind;
  /** Sandbox settings from project configuration. */
  base: DockerSandboxOptions;
  /** Hosts the CLI may reach. Defaults to {@link DEFAULT_EGRESS_ALLOWLISTS}. */
  allow?: readonly string[];
  /** `none` skips credential mounting entirely, for API-key deployments. */
  credentialMode?: CredentialMountMode | "none";
  /** Host home to read credentials from. Defaults to the current user's. */
  home?: string;
  containerHome?: string;
  /** Where ephemeral credential copies are staged. Defaults to the temp dir. */
  stagingRoot?: string;
  gateway?: Partial<EgressGatewayOptions>;
}

export interface VendorSandbox {
  /** Ready to hand to `new DockerWorkspaceManager(...)`. */
  options: DockerSandboxOptions;
  /** Hosts the gateway admits, after defaults are applied. */
  allow: readonly string[];
  /** Proxy decisions so far, one JSON object per line. */
  auditLog(): Promise<string>;
  /** Stops the gateway and discards staged credentials. */
  release(): Promise<void>;
}

/**
 * Brings up the egress gateway and credential mounts one vendor CLI needs.
 *
 * The returned options are the project's sandbox settings plus an internal
 * network, an allowlisting proxy, and one or two credential files — nothing
 * else is relaxed. Callers must `release()` when the task ends, or a proxy
 * container and an internal network are left behind.
 */
export async function openVendorSandbox(
  options: VendorSandboxOptions,
): Promise<VendorSandbox> {
  assertContainerIsSoleBoundary(options.base);

  const allow = options.allow ?? DEFAULT_EGRESS_ALLOWLISTS[options.kind];
  const credentialMode = options.credentialMode ?? "ephemeral-copy";
  const containerHome = options.containerHome ?? "/home/agent";

  const stagingDir =
    credentialMode === "ephemeral-copy"
      ? await mkdtemp(
          path.join(options.stagingRoot ?? os.tmpdir(), "coord-vendor-cred-"),
        )
      : undefined;

  const discard = async (): Promise<void> => {
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  };

  let credentials;
  try {
    credentials =
      credentialMode === "none"
        ? { mounts: [], env: {}, tmpfs: [containerHome], missing: [] }
        : await resolveVendorCredentials(options.kind, {
            ...(options.home === undefined ? {} : { home: options.home }),
            containerHome,
            mode: credentialMode,
            ...(stagingDir === undefined ? {} : { stagingDir }),
          });
  } catch (error) {
    await discard();
    throw error;
  }

  const gateway = new EgressGateway({
    ...options.gateway,
    allow,
    image: options.base.image,
    ...(options.base.docker === undefined ? {} : { docker: options.base.docker }),
  });

  let binding;
  try {
    binding = await gateway.start();
  } catch (error) {
    await discard();
    throw error;
  }

  // `network` is dropped rather than passed through: the gateway supplies the
  // network, and DockerWorkspaceManager refuses both at once.
  const { network: _ignored, ...base } = options.base;

  return {
    options: {
      ...base,
      egress: binding,
      credentialMounts: credentials.mounts,
      tmpfs: [...new Set([...(base.tmpfs ?? ["/tmp"]), ...credentials.tmpfs])],
      env: { ...credentials.env, ...(base.env ?? {}) },
    },
    allow,
    auditLog: async () => await gateway.auditLog(),
    release: async () => {
      try {
        await gateway.stop();
      } finally {
        await discard();
      }
    },
  };
}
