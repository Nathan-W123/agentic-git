import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { VendorCliKind } from "./vendor-credentials.js";

/**
 * Per-user vendor credentials, so a task runs under the account of whoever
 * submitted it rather than under whatever account the host machine happens to
 * be logged into.
 *
 * ### Why credentials are handed over rather than granted
 *
 * The obvious design is a real OAuth flow: the dashboard registers as an OAuth
 * client, each user authorizes it, and the server holds a per-user grant. Only
 * one of the three vendors offers anything of that shape. Claude Code's login
 * is a PKCE flow bound to Claude Code's *own* client identifier, meant for a
 * CLI on the end user's machine; there is no published client registration and
 * no redirect allowlist a third-party server could join. The Gemini CLI is the
 * same. Driving either from a server would mean impersonating the vendor's own
 * client.
 *
 * So credentials arrive one of three ways, in descending order of quality:
 *
 * 1. **Issued to this deployment.** `codex login --device-auth` runs here,
 *    prints a URL and a one-time code, and the user approves it in their own
 *    browser against their own ChatGPT account. What lands is a session this
 *    deployment owns outright — the closest thing to a real per-user grant any
 *    of the three vendors provides.
 * 2. **Minted by the user for a runner.** `claude setup-token` prints a
 *    long-lived token (`sk-ant-oat…`) that spends the user's Claude
 *    subscription, consumed via `CLAUDE_CODE_OAUTH_TOKEN`. Purpose-built for
 *    exactly this, and separate from the user's own login.
 * 3. **Copied from the user's machine.** An API key, or — for Codex and Gemini
 *    subscriptions, which have no `setup-token` equivalent — the CLI's own
 *    session file. This works and is offered, but the copy shares a rotating
 *    refresh token with its origin: see
 *    {@link SESSION_FILE_SHARES_REFRESH_TOKEN}.
 *
 * Except for (1), this store holds a secret the user supplied rather than a
 * grant the server obtained. The security properties that matter are the same
 * either way and are the ones enforced here: the secret is encrypted at rest,
 * it is never returned to any browser, and it reaches a CLI only through that
 * CLI's own environment or credential file.
 *
 * ### Isolation is the config directory, not the token
 *
 * Passing a user's token is only half the job. Each vendor CLI *also* reads a
 * logged-in session from the host home directory, so a process that inherits
 * the host environment can fall back to the host owner's account — silently,
 * and looking exactly like success. Every launch therefore also redirects the
 * CLI's configuration directory to an empty per-task directory
 * ({@link openCredentialHome}), which removes the host session from reach.
 *
 * Verified against the installed Claude Code CLI: with an isolated
 * `CLAUDE_CONFIG_DIR`, a deliberately invalid token fails
 * `401 OAuth access token is invalid` and no credential fails
 * `Not logged in`, rather than either quietly succeeding as the host owner.
 */

/**
 * How the user obtained the secret, which decides how it is delivered.
 *
 * `session_file` is the whole credential file a vendor CLI writes when the
 * user signs into a *subscription* account — Codex's `auth.json`, Gemini's
 * `oauth_creds.json`. It exists because neither of those vendors offers
 * anything like `claude setup-token`, and it carries a caveat the other kinds
 * do not: see {@link SESSION_FILE_SHARES_REFRESH_TOKEN}.
 */
export type UserCredentialKind = "oauth_token" | "api_key" | "session_file";

/**
 * Why a session file is second-best, stated once so every caller can quote it.
 *
 * A session file contains the same *rotating refresh token* the user's own
 * machine is still using. Whichever side refreshes first invalidates the
 * other's copy, so connecting this way can log the user out of their local
 * CLI, and vice versa. `claude setup-token` avoids this by minting a separate
 * long-lived credential; Codex's device authorization avoids it by issuing
 * this deployment its own independent session. Copying a file cannot.
 */
export const SESSION_FILE_SHARES_REFRESH_TOKEN =
  "This copies the sign-in your own machine is using. Both share one " +
  "refresh token, so signing in here may occasionally log you out of your " +
  "local CLI (and vice versa).";

/**
 * Where a session file came from, which decides whether it shares a refresh
 * token with anything else.
 *
 * `device_auth` sessions are issued to this deployment directly by the vendor
 * and are nobody else's copy, so {@link SESSION_FILE_SHARES_REFRESH_TOKEN}
 * does *not* apply to them. `copied` sessions are the user's own file and it
 * does. The UI must not warn about both alike.
 */
export type CredentialOrigin = "pasted" | "copied" | "device_auth";

export interface UserCredentialInput {
  kind: UserCredentialKind;
  secret: string;
  /** Free text the user supplies to tell their own connections apart. */
  label?: string;
  origin?: CredentialOrigin;
}

/** Everything but the secret. Safe to return to a browser. */
export interface UserCredentialSummary {
  vendor: VendorCliKind;
  kind: UserCredentialKind;
  label: string | undefined;
  origin: CredentialOrigin;
  createdAt: string;
  lastVerifiedAt: string | undefined;
  /** Last four characters, so a user can recognize which secret is stored. */
  hint: string;
}

export interface UserCredential extends UserCredentialSummary {
  secret: string;
}

interface StoredRecord {
  kind: UserCredentialKind;
  label?: string;
  origin?: CredentialOrigin;
  createdAt: string;
  lastVerifiedAt?: string;
  hint: string;
  /** AES-256-GCM, all base64. */
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredFile {
  version: 1;
  users: Record<string, Partial<Record<VendorCliKind, StoredRecord>>>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_SALT = "coord-user-credentials-v1";

export class UserCredentialError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "UserCredentialError";
  }
}

/**
 * Resolves the encryption key.
 *
 * `COORD_CREDENTIAL_KEY` is read first and is the only option that survives
 * moving the project directory or running more than one control plane against
 * shared storage, so it is what a real deployment should set. A base64 or hex
 * 32-byte value is used directly; anything else is stretched with scrypt so an
 * operator who supplies a passphrase gets a usable key rather than an error.
 *
 * With the variable unset, a key is generated once and kept beside the
 * credential file. That keeps a single-host deployment working without setup,
 * and it is honest about what it protects: someone who can read the key file
 * can read the credentials, so encryption at rest here defends against copied
 * backups and stray file reads, not against an attacker who already owns the
 * project directory.
 */
export async function resolveCredentialKey(input: {
  keyFilePath: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<Buffer> {
  const configured = (input.environment ?? process.env)["COORD_CREDENTIAL_KEY"];
  if (configured !== undefined && configured.trim().length > 0) {
    const trimmed = configured.trim();
    for (const encoding of ["base64", "hex"] as const) {
      const decoded = Buffer.from(trimmed, encoding);
      if (
        decoded.length === KEY_BYTES &&
        decoded.toString(encoding).replace(/=+$/u, "") ===
          trimmed.replace(/=+$/u, "")
      ) {
        return decoded;
      }
    }
    return scryptSync(trimmed, SCRYPT_SALT, KEY_BYTES);
  }

  try {
    const existing = (await readFile(input.keyFilePath, "utf8")).trim();
    const decoded = Buffer.from(existing, "base64");
    if (decoded.length === KEY_BYTES) {
      return decoded;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const generated = randomBytes(KEY_BYTES);
  await mkdir(path.dirname(input.keyFilePath), { recursive: true });
  await writeFile(input.keyFilePath, `${generated.toString("base64")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return generated;
}

/**
 * Encrypted per-user credential storage.
 *
 * The whole file is rewritten on every mutation. That is the same approach the
 * dashboard's other secrets file takes and is appropriate at this scale: the
 * record count is bounded by users times vendors, and a single control plane
 * holds the project lock, so there is no concurrent writer to lose.
 */
export class UserCredentialStore {
  public constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== KEY_BYTES) {
      throw new UserCredentialError(
        `The credential key must be ${KEY_BYTES} bytes`,
        "invalid_key",
      );
    }
  }

  /** Opens the store for a project, generating a key file if needed. */
  public static async open(
    secretsDirectory: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<UserCredentialStore> {
    const key = await resolveCredentialKey({
      keyFilePath: path.join(secretsDirectory, "credential-key"),
      ...(environment === undefined ? {} : { environment }),
    });
    return new UserCredentialStore(
      path.join(secretsDirectory, "user-credentials.json"),
      key,
    );
  }

  private async read(): Promise<StoredFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<StoredFile>;
      if (parsed.version !== 1 || typeof parsed.users !== "object") {
        return { version: 1, users: {} };
      }
      return { version: 1, users: parsed.users ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, users: {} };
      }
      throw error;
    }
  }

  private async write(file: StoredFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private encrypt(secret: string): Pick<
    StoredRecord,
    "iv" | "tag" | "ciphertext"
  > {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private decrypt(record: StoredRecord): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // GCM authentication failing means the key changed or the file was
      // edited. Either way the stored bytes are unusable, and saying so beats
      // surfacing a raw cipher error to a dashboard user.
      throw new UserCredentialError(
        "The stored credential could not be decrypted with the current key; " +
          "reconnect the provider to replace it",
        "undecryptable",
      );
    }
  }

  public async put(
    userId: string,
    vendor: VendorCliKind,
    input: UserCredentialInput,
  ): Promise<UserCredentialSummary> {
    const secret = input.secret.trim();
    if (secret.length === 0) {
      throw new UserCredentialError(
        "A credential cannot be empty",
        "invalid_secret",
      );
    }
    if (input.kind === "session_file") {
      assertSessionFile(vendor, secret);
    }
    const file = await this.read();
    const record: StoredRecord = {
      kind: input.kind,
      ...(input.label === undefined || input.label.length === 0
        ? {}
        : { label: input.label }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      createdAt: new Date().toISOString(),
      hint: credentialHint(input.kind, secret),
      ...this.encrypt(secret),
    };
    file.users[userId] = { ...file.users[userId], [vendor]: record };
    await this.write(file);
    return summarize(vendor, record);
  }

  /** Records that the credential answered a live call, for the UI to show. */
  public async markVerified(
    userId: string,
    vendor: VendorCliKind,
    label?: string,
  ): Promise<void> {
    const file = await this.read();
    const record = file.users[userId]?.[vendor];
    if (record === undefined) {
      return;
    }
    record.lastVerifiedAt = new Date().toISOString();
    if (label !== undefined && label.length > 0) {
      record.label = label;
    }
    await this.write(file);
  }

  public async get(
    userId: string,
    vendor: VendorCliKind,
  ): Promise<UserCredential | undefined> {
    const record = (await this.read()).users[userId]?.[vendor];
    if (record === undefined) {
      return undefined;
    }
    return { ...summarize(vendor, record), secret: this.decrypt(record) };
  }

  public async summary(
    userId: string,
    vendor: VendorCliKind,
  ): Promise<UserCredentialSummary | undefined> {
    const record = (await this.read()).users[userId]?.[vendor];
    return record === undefined ? undefined : summarize(vendor, record);
  }

  public async list(userId: string): Promise<UserCredentialSummary[]> {
    const connections = (await this.read()).users[userId] ?? {};
    return (Object.keys(connections) as VendorCliKind[])
      .map((vendor) => {
        const record = connections[vendor];
        return record === undefined ? undefined : summarize(vendor, record);
      })
      .filter((entry): entry is UserCredentialSummary => entry !== undefined);
  }

  public async delete(userId: string, vendor: VendorCliKind): Promise<void> {
    const file = await this.read();
    const connections = file.users[userId];
    if (connections?.[vendor] === undefined) {
      return;
    }
    delete connections[vendor];
    await this.write(file);
  }
}

function summarize(
  vendor: VendorCliKind,
  record: StoredRecord,
): UserCredentialSummary {
  return {
    vendor,
    kind: record.kind,
    label: record.label,
    origin: record.origin ?? "pasted",
    createdAt: record.createdAt,
    lastVerifiedAt: record.lastVerifiedAt,
    hint: record.hint,
  };
}

/* ------------------------------------------------------------ launching --- */

/**
 * How each vendor takes each credential kind.
 *
 * Only Claude reads a credential from the environment. Codex ignores
 * `OPENAI_API_KEY` outright — with only the variable set it sends no
 * credential and the API answers `401 … Missing bearer or basic
 * authentication in header` — so even its API key is written to `auth.json`.
 *
 * Declaration order is meaningful: the first kind listed for a vendor is the
 * one {@link supportedCredentialKinds} recommends, and the connect UI offers
 * it by default. API keys lead for Codex and Gemini because a session file
 * shares a refresh token with the user's own machine.
 */
type CredentialDelivery = { via: "env"; variable: string } | { via: "files" };

const DELIVERY: Record<
  VendorCliKind,
  Partial<Record<UserCredentialKind, CredentialDelivery>>
> = {
  claude: {
    oauth_token: { via: "env", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
    api_key: { via: "env", variable: "ANTHROPIC_API_KEY" },
  },
  codex: {
    api_key: { via: "files" },
    session_file: { via: "files" },
  },
  gemini: {
    api_key: { via: "env", variable: "GEMINI_API_KEY" },
    session_file: { via: "files" },
  },
};

/**
 * Writes the API-key credential file the Codex CLI actually reads.
 *
 * `codex exec` does **not** authenticate from `OPENAI_API_KEY`: with only the
 * variable set it sends no credential at all and the API answers
 * `401 … Missing bearer or basic authentication in header`. With this file
 * present the key is sent and the response becomes a genuine verdict on the
 * key (`invalid_api_key` for a bad one). Verified against the installed CLI —
 * the distinction matters because the env-var-only failure looks like a
 * rejected key rather than a credential that was never delivered.
 */
async function writeCodexAuthFile(
  codexHome: string,
  apiKey: string,
): Promise<void> {
  await writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Checks that a pasted session file is the file the vendor actually wants.
 *
 * A user asked for "the contents of a JSON file" will sometimes supply a
 * neighbouring one — `config.toml`, `google_accounts.json`, the whole
 * directory listing. Catching that here turns a mystified CLI failure minutes
 * later into a precise message at the moment of pasting.
 */
export function assertSessionFile(
  vendor: VendorCliKind,
  secret: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new UserCredentialError(
      `That is not valid JSON. Paste the entire contents of the ${
        vendor === "codex" ? "auth.json" : "oauth_creds.json"
      } file.`,
      "invalid_session_file",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UserCredentialError(
      "A session file must be a JSON object",
      "invalid_session_file",
    );
  }
  const record = parsed as Record<string, unknown>;

  if (vendor === "codex") {
    const tokens = record["tokens"];
    const hasTokens =
      typeof tokens === "object" &&
      tokens !== null &&
      typeof (tokens as Record<string, unknown>)["access_token"] === "string";
    if (!hasTokens && typeof record["OPENAI_API_KEY"] !== "string") {
      throw new UserCredentialError(
        "That JSON is not a Codex auth.json — it has no `tokens.access_token`. " +
          "Copy ~/.codex/auth.json after running `codex login`.",
        "invalid_session_file",
      );
    }
    return;
  }

  if (vendor === "gemini") {
    if (
      typeof record["access_token"] !== "string" ||
      typeof record["refresh_token"] !== "string"
    ) {
      throw new UserCredentialError(
        "That JSON is not a Gemini oauth_creds.json — it has no " +
          "`access_token`/`refresh_token`. Copy ~/.gemini/oauth_creds.json " +
          "after signing in with the Gemini CLI.",
        "invalid_session_file",
      );
    }
    return;
  }

  throw new UserCredentialError(
    `${vendor} does not accept a session file`,
    "unsupported_kind",
  );
}

/**
 * A recognizable fragment of the secret, for the UI to show.
 *
 * The tail of a session file is a closing brace, which identifies nothing, so
 * the hint comes from the token inside it instead.
 */
export function credentialHint(
  kind: UserCredentialKind,
  secret: string,
): string {
  if (kind !== "session_file") {
    return secret.slice(-4);
  }
  try {
    const record = JSON.parse(secret) as Record<string, unknown>;
    const tokens = record["tokens"] as Record<string, unknown> | undefined;
    const token =
      (typeof tokens?.["access_token"] === "string"
        ? (tokens["access_token"] as string)
        : undefined) ??
      (typeof record["access_token"] === "string"
        ? (record["access_token"] as string)
        : undefined);
    return token === undefined ? "file" : token.slice(-4);
  } catch {
    return "file";
  }
}

/** The variable naming each vendor's configuration directory. */
const CONFIG_DIRECTORY_VARIABLES: Partial<Record<VendorCliKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** Every variable that could carry a credential into one of these CLIs. */
const ALL_CREDENTIAL_VARIABLES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

export function supportsUserCredential(
  vendor: VendorCliKind,
  kind: UserCredentialKind,
): boolean {
  return DELIVERY[vendor][kind] !== undefined;
}

/**
 * The credential kinds a vendor accepts, most-recommended first.
 *
 * The connect UI offers `[0]` by default, so the order is a product decision
 * and not incidental — see the note on {@link DELIVERY}.
 */
export function supportedCredentialKinds(
  vendor: VendorCliKind,
): UserCredentialKind[] {
  return Object.keys(DELIVERY[vendor]) as UserCredentialKind[];
}

export interface CredentialHome {
  /** Directory the CLI will treat as its configuration home. */
  path: string;
  /** Environment that authenticates as this user and nobody else. */
  env: NodeJS.ProcessEnv;
  /** Removes the directory and the refreshed tokens the CLI wrote into it. */
  close(): Promise<void>;
}

/**
 * Stages an isolated configuration directory and the environment to use it.
 *
 * The base environment is copied and then *stripped* of every credential
 * variable before the user's own is added. Without that step a stray
 * `ANTHROPIC_API_KEY` in the control plane's own environment would answer for
 * a user whose stored credential had already expired, and the run would look
 * like it succeeded under their account.
 *
 * The directory is a fresh temporary one per launch. The vendor CLIs refresh
 * tokens in place, so a shared directory would accumulate one user's refreshed
 * credentials where the next user's process could read them.
 */
export async function openCredentialHome(input: {
  vendor: VendorCliKind;
  credential: UserCredential;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<CredentialHome> {
  const { vendor, credential } = input;
  const delivery = DELIVERY[vendor][credential.kind];
  if (delivery === undefined) {
    throw new UserCredentialError(
      `The ${vendor} CLI cannot accept a ${credential.kind} per user`,
      "unsupported_kind",
    );
  }
  if (credential.kind === "session_file") {
    assertSessionFile(vendor, credential.secret);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-cred-"));

  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  for (const name of ALL_CREDENTIAL_VARIABLES) {
    delete env[name];
  }
  if (delivery.via === "env") {
    env[delivery.variable] = credential.secret;
  }

  const configVariable = CONFIG_DIRECTORY_VARIABLES[vendor];
  if (configVariable !== undefined) {
    const configDirectory = path.join(directory, "config");
    await mkdir(configDirectory, { recursive: true });
    env[configVariable] = configDirectory;
    if (vendor === "codex") {
      if (credential.kind === "session_file") {
        // The subscription login travels verbatim: it carries `auth_mode`,
        // the token set, and the account id, and re-encoding it risks
        // dropping a field the CLI depends on.
        await writeFile(
          path.join(configDirectory, "auth.json"),
          `${credential.secret.trim()}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } else {
        await writeCodexAuthFile(configDirectory, credential.secret);
      }
    }
  } else {
    // Gemini has no configuration-directory variable, so the whole home is
    // redirected instead. That is blunter but achieves the same thing: the
    // host's ~/.gemini session is not on the path the CLI searches.
    env["HOME"] = directory;
    env["USERPROFILE"] = directory;
    // Redirecting the home also loses whatever directories the user had
    // marked trusted, and the CLI refuses to run headless in an untrusted
    // directory — it exits 55 naming this variable, before it ever attempts
    // authentication, which would otherwise surface as a confusing
    // "credential rejected".
    env["GEMINI_CLI_TRUST_WORKSPACE"] = "true";

    if (credential.kind === "session_file") {
      const geminiDirectory = path.join(directory, ".gemini");
      await mkdir(geminiDirectory, { recursive: true });
      await writeFile(
        path.join(geminiDirectory, "oauth_creds.json"),
        `${credential.secret.trim()}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      // Without a declared auth method the CLI refuses to start, naming its
      // settings file and the API-key variables — it does not infer the
      // method from the credentials sitting next to it. Verified live: this
      // file is what turns "Please set an Auth method" into a real call.
      // `google_accounts.json` and `projects.json` are deliberately not
      // required; the credential authenticates without them.
      await writeFile(
        path.join(geminiDirectory, "settings.json"),
        `${JSON.stringify({
          security: { auth: { selectedType: "oauth-personal" } },
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }

  return {
    path: directory,
    env,
    close: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Runs `use` against an isolated credential home and always cleans up after. */
export async function withCredentialHome<T>(
  input: {
    vendor: VendorCliKind;
    credential: UserCredential;
    baseEnv?: NodeJS.ProcessEnv;
  },
  use: (home: CredentialHome) => Promise<T>,
): Promise<T> {
  const home = await openCredentialHome(input);
  try {
    return await use(home);
  } finally {
    await home.close();
  }
}
