/**
 * Which agent vendors exist, what they are called, and how their usage reads.
 *
 * The label and the setup line are data rather than branching because every
 * screen that names a vendor must name it identically - an agent called
 * "Claude" in one room and "claude-code" in another reads as two agents.
 */

import type {
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
} from "./codex-subscription-usage.js";
import { firstWord } from "./text.js";

/**
 * The vendor CLI behind each provider id, for @mention dispatch: a task runs
 * under a vendor (`SubmitTaskInput.vendor`/`openSubmitterCredentialHome`),
 * not under the dashboard's provider id. Mirrors `PROVIDER_VENDORS` in
 * `apps/web/src/providers.ts`, which cannot be imported here without coupling
 * the gateway to that implementation.
 */
export type AgentVendor =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "copilot"
  | "kiro";

/**
 * How a person installs the CLI an agent needs, on the machine that runs it.
 *
 * Local execution means the vendor's own CLI has to be on the machine, signed
 * in, before an agent can do anything — and until this existed, nothing said
 * so. An agent with no CLI looked exactly like one that was working: it took
 * the mention, said it had started, and the task waited forever. Finding out
 * why cost an afternoon of reading process lists.
 *
 * Only commands verified against the vendor's own published instructions are
 * here. A wrong install command is worse than none: it sends somebody to a
 * package that is not the CLI — npm has one called `cursor-agent` that is
 * somebody else's project entirely — and the result looks like the agent
 * being broken rather than the advice being wrong. A vendor missing from this
 * table gets its documentation link and no command.
 */
export const VENDOR_CLI_SETUP: Record<
  string,
  { windows?: string; posix?: string; docs: string; signIn: string }
> = {
  claude: {
    windows: "npm install -g @anthropic-ai/claude-code",
    posix: "npm install -g @anthropic-ai/claude-code",
    docs: "https://docs.claude.com/en/docs/claude-code/overview",
    signIn: "claude",
  },
  codex: {
    windows: "npm install -g @openai/codex",
    posix: "npm install -g @openai/codex",
    docs: "https://developers.openai.com/codex",
    signIn: "codex",
  },
  cursor: {
    windows: "irm 'https://cursor.com/install?win32=true' | iex",
    posix: "curl https://cursor.com/install -fsS | bash",
    docs: "https://cursor.com/docs/cli/installation",
    signIn: "agent",
  },
};

export const PROVIDER_TO_VENDOR: Record<string, AgentVendor> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  cursor: "cursor",
  copilot: "copilot",
  kiro: "kiro",
};

/** People say "Claude", not "Anthropic" — mirrors `AGENT_LABEL` in data.js. */
export const AGENT_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
  cursor: "Cursor",
  copilot: "Copilot",
  kiro: "Kiro",
};

export interface ProviderUsageWindow {
  label: string;
  percentUsed: number;
  resetsAt?: string;
  /** The CLI's own reset time, so the browser can say "in 42 minutes". */
  resetsAtEpoch?: number;
  /** Window length in minutes, the number the label is derived from. */
  windowDurationMins?: number;
}

export interface ProviderUsageReport {
  source: string;
  windows: ProviderUsageWindow[];
  unavailableReason?: string;
  /** The subscription tier, when the account reports one. */
  planType?: string;
  /** Credits remaining, when the account holds a credit balance. */
  creditBalance?: number;
}

export function hasUsageWindows(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    Array.isArray((value as { windows?: unknown }).windows) &&
    ((value as { windows: unknown[] }).windows.length > 0)
  );
}

export function codexWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) {
    return fallback;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? "day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

export function codexUsageWindow(
  window: CodexRateLimitWindow,
  fallback: string,
): ProviderUsageWindow {
  let resetsAt: string | undefined;
  let resetsAtEpoch: number | undefined;
  if (window.resetsAt !== undefined) {
    const reset = new Date(window.resetsAt * 1_000);
    if (Number.isFinite(reset.getTime())) {
      resetsAt = reset.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      resetsAtEpoch = window.resetsAt;
    }
  }
  return {
    label: codexWindowLabel(window.windowDurationMins, fallback),
    percentUsed: window.usedPercent,
    ...(resetsAt === undefined || resetsAtEpoch === undefined
      ? {}
      : { resetsAt, resetsAtEpoch }),
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
  };
}

export function codexUsageReport(
  snapshot: CodexRateLimitSnapshot,
): ProviderUsageReport {
  return {
    source:
      snapshot.planType === undefined || snapshot.planType.trim() === ""
        ? "Codex account rate limits"
        : `Codex account rate limits (${snapshot.planType})`,
    windows: [
      codexUsageWindow(snapshot.primary, "primary"),
      codexUsageWindow(snapshot.secondary, "secondary"),
    ],
    ...(snapshot.planType === undefined || snapshot.planType.trim() === ""
      ? {}
      : { planType: snapshot.planType.trim() }),
    ...(snapshot.creditBalance === undefined
      ? {}
      : { creditBalance: snapshot.creditBalance }),
  };
}

/**
 * What an agent is called in a channel before any per-channel rename.
 *
 * The call sign wins: it is handed out once, when the account connects, and
 * is the agent's name everywhere — every channel, every screen, and the text
 * an @mention is matched against. The vendor label plus its owner is only the
 * fallback for a connection made before agents were named.
 *
 * It lives in one function because three callers need the same answer and one
 * of them did not have it: the roster route rebuilt the vendor label directly
 * and never looked at `callSign`, so a deployment came back from a restart
 * showing "Claude (Nathan)" and "Codex (Nathan)" in every channel while the
 * settings screen — which reads the connection itself — still showed Athena.
 * The browser takes the roster's resolved name as the single authority
 * (`channelAgentsFor` in data.js), so that one omission renamed every agent in
 * every room, including the viewer's own.
 */
export function defaultChannelAgentName(connection: {
  userName: string;
  provider: string;
  callSign?: string;
}): string {
  const label = AGENT_LABEL[connection.provider] ?? connection.provider;
  // No owner in brackets on a call sign: it is already unique across the
  // deployment, and "Athena (Bob)" reads as a disambiguation of something that
  // was never ambiguous.
  return connection.callSign ?? `${label} (${firstWord(connection.userName)})`;
}

/**
 * Whether an agent has a machine that can actually run it.
 *
 * A set of owners was not enough, and the gap was not academic. A worker
 * registers the adapters its machine has — one with Claude installed and
 * nothing else registers exactly `claude` — but liveness was answered per
 * *person*, so every agent that person owned read as online the moment any
 * machine of theirs was listening. An agent for a CLI that was never
 * installed was therefore drawn as available, took a mention, posted "I've
 * taken this task and I'm working on it", and left the task in a queue no
 * worker would ever claim. Nothing was hung and nothing failed; the work
 * simply waited forever behind a sentence saying it had begun.
 *
 * Answered per adapter now, which is the question the dispatch actually
 * asks. An agent whose CLI is on nobody's machine reads as offline, which
 * is what the offline prompt is for.
 */
export function agentIsLive(
  live: Map<string, Set<string>>,
  userId: string,
  provider: string,
): boolean {
  const advertised = live.get(userId);
  if (advertised === undefined) {
    return false;
  }
  const vendor = PROVIDER_TO_VENDOR[provider];
  // A provider this build has no vendor CLI for cannot be checked against
  // what a worker advertises. Falling back to "the owner is listening" keeps
  // such an agent exactly as available as it was before adapters were
  // consulted, rather than making it silently unmentionable.
  return vendor === undefined ? true : advertised.has(vendor);
}
