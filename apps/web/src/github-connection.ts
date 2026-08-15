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
 * The token is a personal access token the user mints on github.com and
 * pastes once. GitHub does offer real OAuth apps, but registering one binds
 * the deployment to a client id and a redirect URL nobody has stood up; the
 * pasted-token shape is the one every other connection here already has, and
 * it scopes exactly right by construction — the token can only reach what
 * its owner can.
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
}

export interface GitHubConnectionServiceOptions {
  credentials: UserCredentialStore;
  /**
   * Injectable for tests, which must not talk to github.com. Everything else
   * uses the platform fetch.
   */
  fetchImpl?: typeof fetch;
}

const GITHUB_API_USER = "https://api.github.com/user";

/**
 * Proves a token before storing it, exactly like the provider connections:
 * a credential that is merely stored looks connected in Settings and fails
 * much later, mid-push, where the error surfaces as a failed agent action
 * rather than a typo at connect time.
 */
export class GitHubConnectionService {
  private readonly credentials: UserCredentialStore;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: GitHubConnectionServiceOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async status(input: {
    userId: string;
  }): Promise<GitHubConnectionStatus> {
    const credential = await this.credentials.summary(input.userId, "github");
    if (credential === undefined) {
      return { connected: false };
    }
    return {
      connected: true,
      // The verified account name is kept in the summary's label — see
      // `connect` — so the screen can say which GitHub identity pushes will
      // carry, not merely that some token exists.
      ...(credential.label === undefined ? {} : { login: credential.label }),
      credential,
    };
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
