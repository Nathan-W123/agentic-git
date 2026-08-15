import { randomUUID } from "node:crypto";

import {
  type UserCredentialStore,
  type UserCredentialSummary,
} from "@coord/workspace-manager";

/**
 * A user's own GitHub connection, so a push runs as whoever asked for it.
 *
 * Push authentication used to come from a deployment-wide `GITHUB_TOKEN`,
 * which is a confused deputy: any user's task could publish to any repository
 * that token reached, and every commit carried the token owner's identity.
 * The owner rejected that outright, so there is no environment fallback here
 * — a user who has not connected GitHub is refused by name, not covered for.
 *
 * The token arrives one of two ways and lands in the same vault either way.
 * A deployment with a GitHub OAuth App configured (`COORD_GITHUB_CLIENT_ID`)
 * offers the device sign-in: GitHub shows a short code, the person approves
 * in a browser of their own, and the grant needs no client secret and no
 * redirect URL. Without one, the person mints a personal access token on
 * github.com and pastes it once — a path that also stays for anyone who
 * wants a token scoped tighter than the sign-in's `repo` grant.
 */

/** Mirrors ProviderChatError's shape so the gateway maps it the same way. */
export class GitHubConnectionError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHubConnectionError";
  }
}

/**
 * What the API returns about a connection. The token itself never travels
 * back — `login` and the summary's four-character hint are what a person
 * needs to recognize which account and which secret they stored.
 */
export interface GitHubConnectionStatus {
  connected: boolean;
  /** The GitHub account the token authenticated as, at connect time. */
  login?: string;
  credential?: UserCredentialSummary;
  /**
   * Whether "sign in with GitHub" is offered here, which is a deployment
   * property: the device flow needs a GitHub OAuth App's client id
   * configured. Absent one, the paste-a-token path is the whole story and
   * the UI must not draw a button that can only apologise.
   */
  signInAvailable: boolean;
}

export interface GitHubConnectionServiceOptions {
  credentials: UserCredentialStore;
  /**
   * The GitHub OAuth App this deployment signs users in through, enabling
   * the device flow — the same "enter this code in your browser" shape the
   * Codex connection uses. The deployment owner creates the app once
   * (github.com → Settings → Developer settings → OAuth Apps, with
   * "Enable Device Flow" ticked) and sets `COORD_GITHUB_CLIENT_ID`; the
   * device grant needs no client secret. Unset, connecting falls back to a
   * pasted personal access token.
   */
  deviceClientId?: string;
  /**
   * Injectable for tests, which must not talk to github.com. Everything else
   * uses the platform fetch.
   */
  fetchImpl?: typeof fetch;
}

export interface GitHubDeviceAuthStart {
  flowId: string;
  /** Where the person enters the code — github.com/login/device. */
  verificationUrl: string;
  userCode: string;
  expiresInSeconds: number;
}

export interface GitHubDeviceAuthStatus {
  status: "pending" | "granted" | "failed";
  /** GitHub's own words for a failure — denied, expired, misconfigured. */
  detail?: string;
  /** Set on `granted`: the account the new token authenticated as. */
  login?: string;
}

interface GitHubDeviceFlow {
  id: string;
  userId: string;
  deviceCode: string;
  verificationUrl: string;
  userCode: string;
  expiresAtMs: number;
  /** GitHub's minimum seconds between token polls; below it answers slow_down. */
  intervalMs: number;
  nextPollAtMs: number;
  status: "pending" | "granted" | "failed";
  detail?: string;
  login?: string;
}

/** A string member of a loosely-parsed JSON answer, or nothing. */
function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

const GITHUB_API_USER = "https://api.github.com/user";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
/**
 * `repo` because pushing is the one thing the token is for. An OAuth App
 * token cannot be narrowed per repository the way a fine-grained PAT can —
 * somebody who wants that boundary pastes a PAT instead, and the connect UI
 * says so.
 */
const GITHUB_DEVICE_SCOPE = "repo";

/**
 * Proves a token before storing it, exactly like the provider connections:
 * a credential that is merely stored looks connected in Settings and fails
 * much later, mid-push, where the error surfaces as a failed agent action
 * rather than a typo at connect time.
 */
export class GitHubConnectionService {
  private readonly credentials: UserCredentialStore;
  private readonly deviceClientId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Live device flows, in memory like the provider ones: a flow is a few
   *  minutes of one person's attention, not durable state. */
  private readonly deviceFlows = new Map<string, GitHubDeviceFlow>();

  public constructor(options: GitHubConnectionServiceOptions) {
    this.credentials = options.credentials;
    this.deviceClientId = options.deviceClientId?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async status(input: {
    userId: string;
  }): Promise<GitHubConnectionStatus> {
    const signInAvailable = this.deviceClientId !== undefined;
    const credential = await this.credentials.summary(input.userId, "github");
    if (credential === undefined) {
      return { connected: false, signInAvailable };
    }
    return {
      connected: true,
      // The verified account name is kept in the summary's label — see
      // `connect` — so the screen can say which GitHub identity pushes will
      // carry, not merely that some token exists.
      ...(credential.label === undefined ? {} : { login: credential.label }),
      credential,
      signInAvailable,
    };
  }

  /**
   * Begins a device sign-in: GitHub issues a short code, the person enters
   * it at github.com/login/device on any browser of theirs, and
   * {@link deviceAuthStatus} collects the token when they approve. The same
   * shape as the Codex connection, and for the same reason — nobody should
   * have to go mint a secret when the vendor offers a flow built for
   * exactly this.
   */
  public async startDeviceAuth(input: {
    userId: string;
  }): Promise<GitHubDeviceAuthStart> {
    const clientId = this.deviceClientId;
    if (clientId === undefined) {
      throw new GitHubConnectionError(
        501,
        "signin_unconfigured",
        "This deployment has no GitHub OAuth App configured, so there is " +
          "no sign-in to drive. Paste a personal access token instead, or " +
          "have the deployment owner set COORD_GITHUB_CLIENT_ID.",
      );
    }
    // One flow per user: pressing the button again means the old code is
    // abandoned, not that two codes race.
    for (const flow of this.deviceFlows.values()) {
      if (flow.userId === input.userId) {
        this.deviceFlows.delete(flow.id);
      }
    }
    const answer = await this.deviceRequest(GITHUB_DEVICE_CODE_URL, {
      client_id: clientId,
      scope: GITHUB_DEVICE_SCOPE,
    });
    const deviceCode = stringField(answer, "device_code");
    const userCode = stringField(answer, "user_code");
    const verificationUrl =
      stringField(answer, "verification_uri") ??
      "https://github.com/login/device";
    const expiresIn = numberField(answer, "expires_in") ?? 900;
    const interval = numberField(answer, "interval") ?? 5;
    if (deviceCode === undefined || userCode === undefined) {
      throw new GitHubConnectionError(
        502,
        "github_unreachable",
        "GitHub did not answer the sign-in request with a device code",
      );
    }
    const flow: GitHubDeviceFlow = {
      id: randomUUID(),
      userId: input.userId,
      deviceCode,
      verificationUrl,
      userCode,
      expiresAtMs: Date.now() + expiresIn * 1000,
      intervalMs: interval * 1000,
      nextPollAtMs: Date.now() + interval * 1000,
      status: "pending",
    };
    this.deviceFlows.set(flow.id, flow);
    return {
      flowId: flow.id,
      verificationUrl,
      userCode,
      expiresInSeconds: expiresIn,
    };
  }

  /**
   * One look at a flow, polling GitHub no faster than it asked to be
   * polled. On a grant the token is verified and stored exactly as a pasted
   * one would be — same vault, same label-from-login.
   *
   * A settled outcome is answered twice before the flow is forgotten: the
   * connect screen runs two watchers over the same flow — a background poll
   * and the "I've approved it" button — and whichever of them asks second
   * must still hear the truth, not "unknown flow". A third asker starts
   * fresh.
   */
  public async deviceAuthStatus(input: {
    userId: string;
    flowId: string;
  }): Promise<GitHubDeviceAuthStatus> {
    const flow = this.deviceFlows.get(input.flowId);
    if (flow === undefined || flow.userId !== input.userId) {
      throw new GitHubConnectionError(
        404,
        "unknown_flow",
        "That sign-in is no longer running. Start it again.",
      );
    }
    if (flow.status !== "pending") {
      const done: GitHubDeviceAuthStatus = {
        status: flow.status,
        ...(flow.detail === undefined ? {} : { detail: flow.detail }),
        ...(flow.login === undefined ? {} : { login: flow.login }),
      };
      this.deviceFlows.delete(flow.id);
      return done;
    }
    if (Date.now() >= flow.expiresAtMs) {
      return this.settleFlow(flow, {
        status: "failed",
        detail: "The sign-in code expired before it was entered.",
      });
    }
    if (Date.now() < flow.nextPollAtMs) {
      // The browser polls faster than GitHub allows; answering pending from
      // here keeps the UI responsive without earning a slow_down.
      return { status: "pending" };
    }
    flow.nextPollAtMs = Date.now() + flow.intervalMs;
    const answer = await this.deviceRequest(GITHUB_DEVICE_TOKEN_URL, {
      client_id: this.deviceClientId ?? "",
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const error = stringField(answer, "error");
    if (error === "authorization_pending") {
      return { status: "pending" };
    }
    if (error === "slow_down") {
      flow.intervalMs += 5000;
      flow.nextPollAtMs = Date.now() + flow.intervalMs;
      return { status: "pending" };
    }
    if (error !== undefined) {
      return this.settleFlow(flow, {
        status: "failed",
        detail:
          error === "access_denied"
            ? "The sign-in was declined."
            : error === "expired_token"
              ? "The sign-in code expired before it was entered."
              : `GitHub refused the sign-in: ${error}`,
      });
    }
    const token = stringField(answer, "access_token");
    if (token === undefined || token.length === 0) {
      return this.settleFlow(flow, {
        status: "failed",
        detail: "GitHub answered the sign-in without a token.",
      });
    }
    // The same proof a pasted token gets: the flow ends with a verified
    // identity, or it ends failed — never with a stored mystery.
    let login: string;
    try {
      login = await this.verify(token);
    } catch (verifyError) {
      return this.settleFlow(flow, {
        status: "failed",
        detail:
          verifyError instanceof Error
            ? verifyError.message
            : String(verifyError),
      });
    }
    await this.credentials.put(flow.userId, "github", {
      // An OAuth grant, not a pasted key — the kind records how the secret
      // came to exist, and Settings reads it back.
      kind: "oauth_token",
      secret: token,
      origin: "device_auth",
    });
    await this.credentials.markVerified(flow.userId, "github", login);
    return this.settleFlow(flow, { status: "granted", login });
  }

  /**
   * Records a flow's outcome and answers with it. The record outlives this
   * call by exactly one read — see {@link deviceAuthStatus} on why the
   * second watcher matters.
   */
  private settleFlow(
    flow: GitHubDeviceFlow,
    outcome: GitHubDeviceAuthStatus,
  ): GitHubDeviceAuthStatus {
    flow.status = outcome.status;
    if (outcome.detail !== undefined) {
      flow.detail = outcome.detail;
    }
    if (outcome.login !== undefined) {
      flow.login = outcome.login;
    }
    return outcome;
  }

  public async cancelDeviceAuth(input: {
    userId: string;
    flowId: string;
  }): Promise<void> {
    const flow = this.deviceFlows.get(input.flowId);
    if (flow !== undefined && flow.userId === input.userId) {
      this.deviceFlows.delete(flow.id);
    }
  }

  /** One GitHub OAuth endpoint call: form-encoded in, JSON out. */
  private async deviceRequest(
    url: string,
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "coord-dashboard",
        },
        body: new URLSearchParams(body).toString(),
      });
    } catch (error) {
      throw new GitHubConnectionError(
        502,
        "github_unreachable",
        `GitHub could not be reached for the sign-in: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (parsed === undefined) {
      throw new GitHubConnectionError(
        502,
        "github_unreachable",
        `GitHub answered the sign-in with ${response.status} and no JSON`,
      );
    }
    return parsed;
  }

  public async connect(input: {
    userId: string;
    token: string;
  }): Promise<GitHubConnectionStatus> {
    const token = input.token.trim();
    if (token.length === 0) {
      throw new GitHubConnectionError(
        400,
        "invalid_secret",
        "Paste a GitHub personal access token",
      );
    }
    if (/[\s]/u.test(token)) {
      throw new GitHubConnectionError(
        400,
        "invalid_secret",
        "A GitHub token is a single unbroken string — this one contains " +
          "whitespace, so it is probably not the token itself",
      );
    }

    const login = await this.verify(token);

    await this.credentials.put(input.userId, "github", {
      kind: "api_key",
      secret: token,
      origin: "pasted",
    });
    // The login lands in the label so the connection reads as an identity
    // ("pushes as octocat") rather than as an anonymous secret.
    await this.credentials.markVerified(input.userId, "github", login);
    return await this.status({ userId: input.userId });
  }

  public async disconnect(input: { userId: string }): Promise<void> {
    await this.credentials.delete(input.userId, "github");
  }

  /**
   * The submitter's stored token, for the push path.
   *
   * `undefined` means not connected, which the caller must refuse in its own
   * words — the distinction between "you haven't connected GitHub" and "this
   * deployment has no token" is the whole reason this store exists.
   */
  public async tokenFor(
    userId: string,
  ): Promise<{ token: string; login: string | undefined } | undefined> {
    const credential = await this.credentials.get(userId, "github");
    if (credential === undefined) {
      return undefined;
    }
    return { token: credential.secret, login: credential.label };
  }

  /** Notes that a stored token failed a live push, for Settings to show. */
  public async noteAuthFailure(userId: string, reason: string): Promise<void> {
    await this.credentials.markUnusable(userId, "github", reason);
  }

  /** Asks GitHub who the token is, and refuses tokens GitHub refuses. */
  private async verify(token: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(GITHUB_API_USER, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          // GitHub's API refuses anonymous user agents outright.
          "user-agent": "coord-dashboard",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      throw new GitHubConnectionError(
        502,
        "github_unreachable",
        "GitHub could not be reached to verify the token, so nothing was " +
          `stored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitHubConnectionError(
        409,
        "credential_rejected",
        "GitHub rejected that token, so it was not stored. Mint a personal " +
          "access token with access to the repositories you push to.",
      );
    }
    if (!response.ok) {
      throw new GitHubConnectionError(
        502,
        "github_unreachable",
        `GitHub answered ${response.status} while verifying the token, so ` +
          "nothing was stored",
      );
    }
    const body = (await response.json().catch(() => undefined)) as
      | { login?: unknown }
      | undefined;
    const login = typeof body?.login === "string" ? body.login.trim() : "";
    if (login.length === 0) {
      // A 200 with no login is not a user token — an installation or app
      // token can end up here, and a push would then carry an identity
      // nobody recognized in Settings.
      throw new GitHubConnectionError(
        409,
        "credential_rejected",
        "That token authenticated but names no GitHub user, so it was not " +
          "stored. Use a personal access token from your own account.",
      );
    }
    return login;
  }
}
