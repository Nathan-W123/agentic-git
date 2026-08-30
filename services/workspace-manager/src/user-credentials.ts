import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
 * Everything a personal credential can authenticate to.
 *
 * The vendor CLIs came first and gave this store its shape. GitHub joins them
 * because a push must run as whoever submitted the task — the same property
 * per-user CLI credentials exist for, wanting the same storage: submitter
 * scoping, encryption at rest, and the stored-versus-usable bookkeeping. The
 * difference is confined to delivery: a GitHub token never launches a CLI and
 * never stages a credential home ({@link openCredentialHome} still takes only
 * a {@link VendorCliKind}); the push path reads the secret and sends it as
 * HTTP auth to the remote.
 */
export type CredentialService = VendorCliKind | "github";

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

/**
 * Who may task this agent through a shared repository channel.
 *
 * `personal` (the default, and what every connection had before this field
 * existed) means only the connecting user can task it — nobody else even sees
 * it as more than "connected" in the roster. `org` means anyone with access
 * to a repository this agent works in may task it there too, by @mentioning
 * it in that repository's channel. This is metadata about who may *dispatch
 * work*, not a secret: it is safe to return in a {@link UserCredentialSummary}
 * to any caller who may already see the vendor name, including a teammate
 * reading the channel roster.
 */
export type CredentialVisibility = "personal" | "org";

export interface UserCredentialInput {
  kind: UserCredentialKind;
  secret: string;
  /** Free text the user supplies to tell their own connections apart. */
  label?: string;
  origin?: CredentialOrigin;
  /**
   * Omitted keeps whatever the stored credential already says, and means
   * `"personal"` when nothing is stored — see {@link CredentialVisibility}.
   */
  visibility?: CredentialVisibility;
}

/** Everything but the secret. Safe to return to a browser. */
export interface UserCredentialSummary {
  /**
   * Named for the three CLIs the store began with; `github` is the one
   * service here that is not a CLI vendor. Kept as `vendor` because it is a
   * stored field and a wire field, and renaming it would strand every
   * existing record and client for a word.
   */
  vendor: CredentialService;
  kind: UserCredentialKind;
  label: string | undefined;
  origin: CredentialOrigin;
  createdAt: string;
  lastVerifiedAt: string | undefined;
  /**
   * Set when this credential has been seen to fail authentication. Stored
   * and usable are different things, and a screen that shows only the first
   * reports an agent as connected while everything it is asked to do fails.
   */
  unusableReason?: string;
  /** Last four characters, so a user can recognize which secret is stored. */
  hint: string;
  /**
   * Always present, defaulting to `"personal"` for every connection made
   * before this field existed — see {@link CredentialVisibility}. Unlike
   * `label`, this is safe to show to someone other than the owner: it is
   * exactly what a channel roster needs to tell a pingable agent from a
   * visible-only one.
   */
  visibility: CredentialVisibility;
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
  /** Why this credential stopped working, when it has. */
  unusableReason?: string;
  unusableAt?: string;
  hint: string;
  /** Absent means `"personal"` — see {@link CredentialVisibility}. */
  visibility?: CredentialVisibility;
  /** AES-256-GCM, all base64. */
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredFile {
  version: 1;
  users: Record<string, Partial<Record<CredentialService, StoredRecord>>>;
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
let capturedCredentialKey: string | undefined;

/**
 * Takes the configured key out of the process environment and holds it here.
 *
 * Every child this control plane spawns used to inherit `COORD_CREDENTIAL_KEY`
 * — the one key that decrypts every user's stored vendor and GitHub
 * credential — so an agent CLI, a repository's own test command or a preview
 * server could read it. The child environment is now built from an allow-list
 * that excludes it, and this removes the second copy: after boot the variable
 * is simply not in `process.env` for anything to read, deliberately or by
 * accident.
 *
 * Held in a module slot rather than threaded through every caller because the
 * ordering is the hazard. A store opened lazily *after* the delete would find
 * no key, fall back to generating one beside the ciphertext, and then fail to
 * decrypt credentials written under the configured key — a data outcome, not
 * an error message. Capturing it here means every store, eager or lazy, in
 * this process or any other that imports this module, resolves the same key
 * whenever it happens to open.
 *
 * Calling this is optional and idempotent. A caller that passes an explicit
 * `environment` to {@link resolveCredentialKey} still wins over the capture,
 * which is what keeps tests and embedded runtimes able to name their own key.
 */
export function captureCredentialKey(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const configured = environment["COORD_CREDENTIAL_KEY"];
  if (configured === undefined || configured.trim().length === 0) {
    return;
  }
  capturedCredentialKey = configured;
  delete environment["COORD_CREDENTIAL_KEY"];
}

export async function resolveCredentialKey(input: {
  keyFilePath: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<Buffer> {
  // The capture backs the *ambient* environment only. A caller that names its
  // own environment is saying which key to use, and an empty one means "none",
  // which is how a test asks for the generated-key path.
  const configured =
    input.environment === undefined
      ? (process.env["COORD_CREDENTIAL_KEY"] ?? capturedCredentialKey)
      : input.environment["COORD_CREDENTIAL_KEY"];
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
  /**
   * Live CLI homes keyed by the account they spend.
   *
   * Task homes are readers because one coordinator stages all of them before
   * it starts any work. Dashboard completions are writers: they must wait for
   * those task homes to close before copying a rotating session file, or a
   * reply can launch from the task's now-stale refresh token and retire a
   * perfectly healthy agent as soon as the vendor rejects that copy.
   */
  private readonly credentialUses = new Map<
    string,
    {
      readers: number;
      writer: boolean;
      waiting: Array<{ mode: "shared" | "exclusive"; resolve: () => void }>;
    }
  >();

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

  /**
   * Reserves one user's vendor session until its temporary home is closed.
   *
   * New task readers may join existing readers even when a writer is queued.
   * `runPendingTasks` opens every task home before running the coordinator, so
   * making that writer-preferring would deadlock: the first staged task could
   * only close after the later task had got past the queued writer.
   */
  /**
   * One write at a time per credential, so concurrent rotations queue rather
   * than overwrite each other mid-write. Deliberately not the reader/writer
   * lock above: a rotation happens while its own home still holds that lock.
   */
  private readonly credentialWrites = new Map<string, Promise<void>>();

  private async acquireCredentialUse(
    userId: string,
    vendor: VendorCliKind,
    mode: "shared" | "exclusive",
  ): Promise<() => void> {
    const key = `${userId}\0${vendor}`;
    const state = this.credentialUses.get(key) ?? {
      readers: 0,
      writer: false,
      waiting: [],
    };
    this.credentialUses.set(key, state);

    const available =
      mode === "shared"
        ? !state.writer
        : !state.writer && state.readers === 0 && state.waiting.length === 0;
    if (!available) {
      await new Promise<void>((resolve) => {
        state.waiting.push({ mode, resolve });
      });
    } else if (mode === "shared") {
      state.readers += 1;
    } else {
      state.writer = true;
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (mode === "shared") {
        state.readers -= 1;
      } else {
        state.writer = false;
      }
      this.drainCredentialUses(key, state);
    };
  }

  private drainCredentialUses(
    key: string,
    state: {
      readers: number;
      writer: boolean;
      waiting: Array<{ mode: "shared" | "exclusive"; resolve: () => void }>;
    },
  ): void {
    if (state.writer || state.readers > 0) {
      return;
    }
    const first = state.waiting.shift();
    if (first === undefined) {
      this.credentialUses.delete(key);
      return;
    }
    if (first.mode === "exclusive") {
      state.writer = true;
      first.resolve();
      return;
    }
    state.readers += 1;
    first.resolve();
    while (state.waiting[0]?.mode === "shared") {
      const reader = state.waiting.shift();
      if (reader !== undefined) {
        state.readers += 1;
        reader.resolve();
      }
    }
  }

  /**
   * Opens a stored credential only after reserving its rotating session.
   *
   * The credential is read after the wait, so a completion queued behind a
   * task receives the token that task wrote back, not the snapshot that was
   * current when the person pressed Reply. Closing persists any new rotation
   * before releasing the reservation to the next CLI.
   */
  public async openCredentialHome(input: {
    userId: string;
    vendor: VendorCliKind;
    baseEnv?: NodeJS.ProcessEnv;
    mode?: "shared" | "exclusive";
  }): Promise<CredentialHome | undefined> {
    const release = await this.acquireCredentialUse(
      input.userId,
      input.vendor,
      input.mode ?? "exclusive",
    );
    try {
      // Copilot's own sign-in first, then the user's GitHub token; every
      // other vendor has only itself to read.
      let credential: UserCredential | undefined;
      for (const source of credentialSourcesFor(input.vendor)) {
        credential = await this.get(input.userId, source);
        if (credential !== undefined) {
          break;
        }
      }
      if (credential === undefined) {
        release();
        return undefined;
      }
      const home = await openCredentialHome({
        vendor: input.vendor,
        credential,
        ...(input.baseEnv === undefined ? {} : { baseEnv: input.baseEnv }),
      });
      let closing:
        | Promise<{ rotatedSecret?: string; usageSnapshot?: string }>
        | undefined;
      return {
        ...home,
        close: async () => {
          closing ??= (async () => {
            try {
              const result = await home.close();
              if (result.usageSnapshot !== undefined) {
                await this.putUsageSnapshot(
                  input.userId,
                  input.vendor,
                  result.usageSnapshot,
                ).catch(() => undefined);
              }
              if (result.rotatedSecret !== undefined) {
                // Serialised against the other homes rotating the same
                // credential, without touching the reader/writer hold this
                // home is already inside.
                //
                // A `session_file` credential is handed to every concurrent
                // task at once — the hold is shared and admits unlimited
                // readers — and each rotates it and writes the result back as
                // it closes. Those closes happen together, and each is a
                // read-modify-write of the whole record, so they interleaved:
                // the stored bytes were whichever landed last, in whatever
                // order the filesystem settled. The store's own docblock
                // assumes the case that breaks — "a single control plane holds
                // the project lock, so there is no concurrent writer to lose".
                //
                // A separate queue rather than upgrading the hold: dropping
                // the shared hold to take an exclusive one lets a waiting
                // exclusive reader in *before* this write lands, which is the
                // opposite of what it is waiting for. Three tests said so.
                const rotated = result.rotatedSecret;
                const key = `${input.userId}\u0000${input.vendor}`;
                const queued = (
                  this.credentialWrites.get(key) ?? Promise.resolve()
                )
                  .catch(() => undefined)
                  .then(async () => {
                    await this.put(input.userId, input.vendor, {
                      kind: credential.kind,
                      secret: rotated,
                      ...(credential.label === undefined
                        ? {}
                        : { label: credential.label }),
                      origin: credential.origin,
                      visibility: credential.visibility,
                    }).catch(() => undefined);
                  });
                this.credentialWrites.set(key, queued);
                await queued;
              }
              return result;
            } finally {
              release();
            }
          })();
          return await closing;
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Rate-limit figures are not secrets, so they live in a plain sidecar next
   * to the encrypted store — one file per user and vendor, replaced whole.
   */
  public async putUsageSnapshot(
    userId: string,
    vendor: string,
    snapshot: string,
  ): Promise<void> {
    const file = this.usageSnapshotPath(userId, vendor);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, snapshot, "utf8");
  }

  public async readUsageSnapshot(
    userId: string,
    vendor: string,
  ): Promise<string | undefined> {
    return await readFile(this.usageSnapshotPath(userId, vendor), "utf8").catch(
      () => undefined,
    );
  }

  private usageSnapshotPath(userId: string, vendor: string): string {
    const safe = (value: string) => value.replace(/[^\w.-]/gu, "_");
    return path.join(
      path.dirname(this.filePath),
      "usage",
      `${safe(userId)}-${safe(vendor)}.txt`,
    );
  }

  public async put(
    userId: string,
    vendor: CredentialService,
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
    // Replacing a secret is not a decision about who may spend it. A sign-in
    // that expired and was made again is the same agent coming back, and the
    // reconnect carries no visibility of its own — so rebuilding the record
    // from the input alone quietly sent every org-wide agent back to personal,
    // dropping it out of the channels that had learned to @mention it. The
    // stored choice therefore survives a put that does not state one; a caller
    // that does state one still wins, and {@link setVisibility} is how a
    // change of mind is expressed.
    const previous = file.users[userId]?.[vendor];
    const visibility = input.visibility ?? previous?.visibility;
    const record: StoredRecord = {
      kind: input.kind,
      ...(input.label === undefined || input.label.length === 0
        ? {}
        : { label: input.label }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(visibility === undefined ? {} : { visibility }),
      createdAt: new Date().toISOString(),
      hint: credentialHint(input.kind, secret),
      ...this.encrypt(secret),
    };
    file.users[userId] = { ...file.users[userId], [vendor]: record };
    await this.write(file);
    return summarize(vendor, record);
  }

  /** Records that the credential answered a live call, for the UI to show. */
  /**
   * Records that a stored credential no longer authenticates.
   *
   * Being stored and being usable are different things, and only the first
   * was ever visible: a session whose OAuth refresh has stopped working sits
   * in the vault looking exactly like a working one, so the dashboard went on
   * reporting the agent as connected while every task it was given failed to
   * authenticate. The reason is kept alongside so the screen can say what
   * happened rather than only that something did.
   */
  public async markUnusable(
    userId: string,
    vendor: CredentialService,
    reason: string,
  ): Promise<void> {
    const file = await this.read();
    const record = file.users[userId]?.[vendor];
    if (record === undefined) {
      return;
    }
    delete record.lastVerifiedAt;
    record.unusableReason = reason.slice(0, 300);
    record.unusableAt = new Date().toISOString();
    await this.write(file);
  }

  /**
   * Changes who may spend a stored credential, and nothing else.
   *
   * Separate from {@link put} because that one needs the secret, which a
   * later change of mind does not have: the stored copy is encrypted and the
   * person deciding "everyone can use this" is not re-pasting a token to say
   * so. Refuses when nothing is stored rather than inventing a record — there
   * would be no credential for the new visibility to describe.
   */
  public async setVisibility(
    userId: string,
    vendor: CredentialService,
    visibility: CredentialVisibility,
  ): Promise<UserCredentialSummary> {
    const file = await this.read();
    const record = file.users[userId]?.[vendor];
    if (record === undefined) {
      throw new UserCredentialError(
        "No credential of your own is stored for that vendor",
        "not_connected",
      );
    }
    record.visibility = visibility;
    await this.write(file);
    return summarize(vendor, record);
  }

  public async markVerified(
    userId: string,
    vendor: CredentialService,
    label?: string,
  ): Promise<void> {
    const file = await this.read();
    const record = file.users[userId]?.[vendor];
    if (record === undefined) {
      return;
    }
    record.lastVerifiedAt = new Date().toISOString();
    delete record.unusableReason;
    delete record.unusableAt;
    if (label !== undefined && label.length > 0) {
      record.label = label;
    }
    await this.write(file);
  }

  public async get(
    userId: string,
    vendor: CredentialService,
  ): Promise<UserCredential | undefined> {
    const record = (await this.read()).users[userId]?.[vendor];
    if (record === undefined) {
      return undefined;
    }
    return { ...summarize(vendor, record), secret: this.decrypt(record) };
  }

  public async summary(
    userId: string,
    vendor: CredentialService,
  ): Promise<UserCredentialSummary | undefined> {
    const record = (await this.read()).users[userId]?.[vendor];
    return record === undefined ? undefined : summarize(vendor, record);
  }

  public async list(userId: string): Promise<UserCredentialSummary[]> {
    const connections = (await this.read()).users[userId] ?? {};
    return (Object.keys(connections) as CredentialService[])
      .map((vendor) => {
        const record = connections[vendor];
        return record === undefined ? undefined : summarize(vendor, record);
      })
      .filter((entry): entry is UserCredentialSummary => entry !== undefined);
  }

  public async delete(userId: string, vendor: CredentialService): Promise<void> {
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
  vendor: CredentialService,
  record: StoredRecord,
): UserCredentialSummary {
  return {
    vendor,
    kind: record.kind,
    label: record.label,
    origin: record.origin ?? "pasted",
    createdAt: record.createdAt,
    lastVerifiedAt: record.lastVerifiedAt,
    ...(record.unusableReason === undefined
      ? {}
      : { unusableReason: record.unusableReason }),
    hint: record.hint,
    // Absent on every connection made before this field existed, and on any
    // record whose owner never opened the org-wide choice — both read as
    // "personal", which is the behavior nothing should change under.
    visibility: record.visibility ?? "personal",
  };
}

/* ------------------------------------------------------------ launching --- */

/**
 * How each vendor takes each credential kind.
 *
 * Claude and legacy Gemini API-key records read credentials from the
 * environment. Codex ignores
 * `OPENAI_API_KEY` outright — with only the variable set it sends no
 * credential and the API answers `401 … Missing bearer or basic
 * authentication in header` — so even its API key is written to `auth.json`.
 *
 * Declaration order is meaningful: the first kind listed for a vendor is the
 * one {@link supportedCredentialKinds} recommends, and the connect UI offers
 * it by default. Browser-only providers exclude their delivery-only kinds
 * from that list below.
 */
type CredentialDelivery = { via: "env"; variable: string } | { via: "files" };

const DELIVERY: Record<
  VendorCliKind,
  Partial<Record<UserCredentialKind, CredentialDelivery>>
> = {
  claude: {
    oauth_token: { via: "env", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
    api_key: { via: "env", variable: "ANTHROPIC_API_KEY" },
    // What a browser sign-in leaves behind. `claude auth login` writes into
    // its configuration directory rather than printing a token, so what is
    // captured is the directory itself.
    session_file: { via: "files" },
  },
  codex: {
    api_key: { via: "files" },
    session_file: { via: "files" },
  },
  gemini: {
    api_key: { via: "env", variable: "GEMINI_API_KEY" },
    session_file: { via: "files" },
  },
  // These CLIs intentionally accept no pasted API key here. A connection is
  // the browser session their own login command issued to this deployment.
  cursor: { session_file: { via: "files" } },
  // Copilot authenticates from a GitHub token, and nothing else: its own
  // words when it has none are "Copilot can be authenticated with GitHub
  // using an OAuth Token or a Fine-Grained Personal Access Token". There is
  // no `copilot login` for this to have used instead — the CLI's login is a
  // `/login` slash command inside its interactive session, so the sign-in
  // built on `copilot login` never authenticated anything. The token comes
  // from the user's own GitHub connection; see COPILOT_CREDENTIAL_SOURCE.
  copilot: {
    oauth_token: { via: "env", variable: "COPILOT_GITHUB_TOKEN" },
    api_key: { via: "env", variable: "COPILOT_GITHUB_TOKEN" },
    session_file: { via: "files" },
  },
  kiro: { session_file: { via: "files" } },
};

/**
 * Where a CLI's credential may come from, best first.
 *
 * Only Copilot has more than one source, and it needs one. Its own sign-in
 * stores the token "securely in the system credential store" — a keyring
 * that does not exist in this container — falling back to a plain file under
 * `~/.copilot/` only "if a credential store is not found or there is an issue
 * using it". That is a thin thing to hang a connection on, which is why a
 * sign-in could complete and still leave the CLI reporting "No authentication
 * information found".
 *
 * The vendor's own answer for this case is the environment: "Copilot CLI will
 * use an authentication token found in environment variables. This method is
 * most suitable for headless use such as automation", checking
 * COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN in that order. A GitHub token
 * is exactly what the GitHub connection already holds per user, so Copilot
 * falls back to it and most people never need a separate sign-in at all.
 */
const CREDENTIAL_SOURCES: Partial<
  Record<VendorCliKind, readonly CredentialService[]>
> = {
  copilot: ["copilot", "github"],
};

/** The services whose stored credential can authenticate this CLI, best first. */
export function credentialSourcesFor(
  vendor: VendorCliKind,
): readonly CredentialService[] {
  return CREDENTIAL_SOURCES[vendor] ?? [vendor];
}

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
/**
 * How a captured Claude sign-in travels.
 *
 * `claude auth login` prints no token — it writes into whatever
 * `CLAUDE_CONFIG_DIR` points at, and the file it uses has moved between
 * versions. Rather than encode a guess about that layout, the whole directory
 * is captured as a name-to-contents map and written back verbatim when the
 * CLI is next launched. What makes that safe rather than superstitious is
 * that the capture is verified by asking the CLI itself: `claude auth status
 * --json` reports `loggedIn`, so a layout change surfaces as a refused
 * connection at sign-in time rather than as a credential that stores cleanly
 * and fails silently the first time a task uses it.
 *
 * Directories are skipped and each file is capped: this is a credential
 * store, not a backup, and a session needing megabytes is not one.
 */
export const CLAUDE_SESSION_FILES = "files";
const MAX_CAPTURED_FILE_BYTES = 256 * 1024;
const MAX_CAPTURED_FILES = 128;
const MAX_CAPTURED_TOTAL_BYTES = 4 * 1024 * 1024;

/** Serialises a signed-in configuration directory for the credential store. */
export async function captureClaudeSession(
  configDirectory: string,
): Promise<string> {
  const entries = await readdir(configDirectory, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || Object.keys(files).length >= MAX_CAPTURED_FILES) {
      continue;
    }
    const full = path.join(configDirectory, entry.name);
    if ((await stat(full)).size > MAX_CAPTURED_FILE_BYTES) {
      continue;
    }
    files[entry.name] = await readFile(full, "utf8");
  }
  if (Object.keys(files).length === 0) {
    throw new UserCredentialError(
      "The sign-in completed but wrote nothing to capture",
      "invalid_session_file",
    );
  }
  return JSON.stringify({ [CLAUDE_SESSION_FILES]: files });
}

/** Writes a captured sign-in back into a configuration directory. */
export async function restoreClaudeSession(
  configDirectory: string,
  secret: string,
): Promise<void> {
  const parsed = JSON.parse(secret) as Record<string, Record<string, string>>;
  for (const [name, contents] of Object.entries(
    parsed[CLAUDE_SESSION_FILES] ?? {},
  )) {
    // Flattened deliberately: a captured name is only ever a file at the
    // directory's top level, and honouring a path separator here would let a
    // tampered record write outside the staged home.
    await writeFile(path.join(configDirectory, path.basename(name)), contents, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/**
 * Directories a CLI fills with its *program*, never with a credential.
 *
 * These CLIs ship as a small launcher that unpacks a large payload into the
 * home on first run — Copilot alone writes ~200 files, including an 8.7MB
 * `app.js`, under `.cache/copilot/pkg/`. Walking into that is not merely
 * wasteful, it corrupts the credential: the bounds below stop at 128 files of
 * 256KB, so the small `index.js` is captured while the `app.js` it imports is
 * skipped for size, and the real token is crowded out entirely. Restoring that
 * bundle then leaves a half-extracted package the launcher prefers over a good
 * one, and the CLI dies with ERR_MODULE_NOT_FOUND on its own missing `app.js`.
 *
 * Matched by name at any depth: XDG and macOS caches, npm's own two, and the
 * `pkg`/`versions` directories these launchers unpack into. No vendor stores a
 * sign-in under any of these names.
 */
const PROGRAM_CACHE_DIRECTORIES = new Set([
  ".cache",
  "Caches",
  "node_modules",
  ".npm",
  "pkg",
  "versions",
]);

/**
 * Captures a CLI's isolated login home as a bounded relative-path map.
 *
 * Cursor, Copilot and Kiro do not promise one portable token filename. Their
 * own login is still safe to persist because it runs in an otherwise empty
 * temporary home; this stores only regular files written there, with strict
 * file/count/total bounds, and restores them only beneath another temporary
 * home.
 */
export async function captureBrowserSession(home: string): Promise<string> {
  const files: Record<string, string> = {};
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    if (Object.keys(files).length >= MAX_CAPTURED_FILES) {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!PROGRAM_CACHE_DIRECTORIES.has(entry.name)) {
          await visit(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const size = (await stat(full)).size;
      if (
        size > MAX_CAPTURED_FILE_BYTES ||
        totalBytes + size > MAX_CAPTURED_TOTAL_BYTES ||
        Object.keys(files).length >= MAX_CAPTURED_FILES
      ) {
        continue;
      }
      const relative = path.relative(home, full).split(path.sep).join("/");
      // Auth stores are not guaranteed to be JSON (some releases use a
      // small SQLite/keyring file), so preserve bytes rather than decoding
      // and silently corrupting a binary session.
      files[relative] = `base64:${(await readFile(full)).toString("base64")}`;
      totalBytes += size;
    }
  };
  await visit(home);
  if (Object.keys(files).length === 0) {
    throw new UserCredentialError(
      "The browser sign-in completed but wrote no session to capture",
      "invalid_session_file",
    );
  }
  return JSON.stringify({ [CLAUDE_SESSION_FILES]: files });
}

/** Restores a bounded browser-session bundle beneath an isolated home. */
export async function restoreBrowserSession(
  home: string,
  secret: string,
): Promise<void> {
  const parsed = JSON.parse(secret) as Record<string, Record<string, string>>;
  for (const [relative, contents] of Object.entries(
    parsed[CLAUDE_SESSION_FILES] ?? {},
  )) {
    const normalized = path.posix.normalize(relative.replaceAll("\\", "/"));
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new UserCredentialError(
        "The stored browser session contains an unsafe path",
        "invalid_session_file",
      );
    }
    // Credentials captured before program caches were excluded still carry
    // fragments of the CLI's own payload. Writing those back is what leaves a
    // half-extracted package the launcher then prefers over a good one, so
    // they are dropped here too and the CLI unpacks itself cleanly instead.
    if (
      normalized
        .split("/")
        .slice(0, -1)
        .some((segment) => PROGRAM_CACHE_DIRECTORIES.has(segment))
    ) {
      continue;
    }
    const target = path.join(home, ...normalized.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      contents.startsWith("base64:")
        ? Buffer.from(contents.slice("base64:".length), "base64")
        : contents,
      { mode: 0o600 },
    );
  }
}

export function assertSessionFile(
  vendor: CredentialService,
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

  if (
    vendor === "claude" ||
    vendor === "cursor" ||
    vendor === "copilot" ||
    vendor === "kiro"
  ) {
    const files = record[CLAUDE_SESSION_FILES];
    const valid =
      typeof files === "object" &&
      files !== null &&
      Object.keys(files as Record<string, unknown>).length > 0 &&
      Object.values(files as Record<string, unknown>).every(
        (value) => typeof value === "string",
      );
    if (!valid) {
      throw new UserCredentialError(
        `That is not a captured ${vendor} sign-in. Connect it through the ` +
          "dashboard rather than pasting a file.",
        "invalid_session_file",
      );
    }
    return;
  }

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

/**
 * Where per-task credential homes are created.
 *
 * The Codex CLI refuses to create PATH-alias helper binaries when
 * `CODEX_HOME` sits under a temporary directory such as `/tmp`, which makes
 * `codex exec --sandbox read-only` fail even when authentication succeeds.
 * Staging homes on a writable path outside `/tmp` avoids that refusal.
 */
export function credentialStagingRoot(): string {
  const configured = process.env["COORD_CREDENTIAL_STAGING"];
  return configured !== undefined && configured.length > 0
    ? configured
    : os.tmpdir();
}

/**
 * Where the Copilot CLI may unpack itself: shared, stable, and outside every
 * staged home.
 *
 * The published `@github/copilot` package is a launcher; the program proper is
 * an 8.7MB `app.js` and ~200 sibling files that it extracts on first run. Left
 * to its default it picks `$HOME/.cache/copilot/pkg`, and since each run gets
 * a fresh throwaway home that is a full re-extraction *per invocation* — slow,
 * disk-hungry, and sitting exactly where the credential capture walks.
 *
 * `COPILOT_PKG_CACHE_HOME` is first in the launcher's own search order, so
 * pointing it at one shared directory makes the unpack happen once per
 * container. Nothing secret lives here: it is the program, identical for every
 * user, and each user's *sign-in* stays in their own isolated home.
 */
export function copilotPackageCacheDirectory(): string {
  // The image points this at a directory on the container's own writable layer
  // and owned by the runtime user. Falling back to the temp directory keeps
  // development and tests working, at the cost of re-extracting whenever that
  // is cleared.
  const configured = process.env["COORD_COPILOT_PKG_CACHE"];
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(os.tmpdir(), "coord-copilot-pkg");
}

/**
 * Environment that keeps a vendor CLI's program cache out of a staged home.
 *
 * Applied wherever one of these CLIs is launched against an isolated home —
 * credential probes, real runs, and the browser sign-in that first creates the
 * credential — so all three agree on where the program lives.
 */
export function programCacheEnv(
  vendor: VendorCliKind,
): Record<string, string> {
  if (vendor !== "copilot") {
    return {};
  }
  return {
    COPILOT_PKG_CACHE_HOME: copilotPackageCacheDirectory(),
    // A background version bump mid-probe races the extraction it is reading
    // from, and the image already pins the version it installed.
    COPILOT_AUTO_UPDATE: "false",
  };
}

/** Every variable that could carry a credential into one of these CLIs. */
const ALL_CREDENTIAL_VARIABLES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CURSOR_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "KIRO_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

/**
 * Two ways a GitHub secret comes to exist, and the kind records which: a
 * personal access token the user mints and pastes is `api_key`; the grant a
 * device sign-in collects — GitHub is the one connectable service here whose
 * vendor offers a real device flow this deployment can drive — is
 * `oauth_token`. There is still no session file to capture.
 */
const GITHUB_CREDENTIAL_KINDS: readonly UserCredentialKind[] = [
  "api_key",
  "oauth_token",
];

export function supportsUserCredential(
  service: CredentialService,
  kind: UserCredentialKind,
): boolean {
  if (service === "github") {
    return GITHUB_CREDENTIAL_KINDS.includes(kind);
  }
  return DELIVERY[service][kind] !== undefined;
}

/**
 * The credential kinds a vendor accepts, most-recommended first.
 *
 * The connect UI offers `[0]` by default, so the order is a product decision
 * and not incidental — see the note on {@link DELIVERY}.
 */
/**
 * Kinds a sign-in flow produces, which a user cannot supply by hand.
 *
 * Claude's session file is captured from a browser sign-in this deployment
 * ran; there is no file on the user's machine that is one. Offering it in the
 * paste dropdown would invite somebody to hunt for a file that does not
 * exist, so {@link supportedCredentialKinds} — which is what the connect UI
 * lists — leaves it out while the store and delivery still accept it.
 */
const CAPTURE_ONLY_KINDS: Partial<
  Record<VendorCliKind, readonly UserCredentialKind[]>
> = {
  claude: ["session_file"],
  // Gemini's browser sign-in is no longer open to individuals -- Google now
  // answers it with "IneligibleTierError: This client is no longer supported
  // for Gemini Code Assist for individuals" -- so an API key is the route
  // most people have, and the connect screen offers it again. The session
  // file stays capture-only: it is what a sign-in produces, not something to
  // type in.
  gemini: ["session_file"],
  cursor: ["session_file"],
  copilot: ["session_file", "oauth_token", "api_key"],
  kiro: ["session_file"],
};

/** The kinds the connect UI offers, in the order it should offer them. */
export function supportedCredentialKinds(
  service: CredentialService,
): UserCredentialKind[] {
  if (service === "github") {
    return [...GITHUB_CREDENTIAL_KINDS];
  }
  const captureOnly = new Set(CAPTURE_ONLY_KINDS[service] ?? []);
  return (Object.keys(DELIVERY[service]) as UserCredentialKind[]).filter(
    (kind) => !captureOnly.has(kind),
  );
}

export interface CredentialHome {
  /** Directory the CLI will treat as its configuration home. */
  path: string;
  /** Environment that authenticates as this user and nobody else. */
  env: NodeJS.ProcessEnv;
  /**
   * Reads back anything the CLI rotated, then removes the directory.
   *
   * A stored session file is a snapshot taken once at sign-in. The vendor
   * CLIs refresh their own OAuth tokens mid-run and write the new one into
   * the home they were given — the directory this then deletes. Every
   * refreshed token used to be discarded, so a credential that verified
   * perfectly at sign-in died the moment its original short-lived access
   * token expired, and reconnecting bought about an hour before it happened
   * again.
   *
   * `rotatedSecret` is the replacement to store, and is absent when the CLI
   * left the file alone — which is most runs, and must not cause a write.
   */
  close(): Promise<{ rotatedSecret?: string; usageSnapshot?: string }>;
}

/**
 * Reads a vendor's session file back out of a staged home.
 *
 * Deliberately mirrors where {@link openCredentialHome} wrote it rather than
 * searching: a file that turns up somewhere unexpected is not this user's
 * refreshed credential and must not be stored as one. `undefined` means there
 * is nothing readable there, which is not an error — a CLI that never
 * rotated, or a run that failed before writing, both look like this.
 */
async function readSessionSnapshot(
  vendor: VendorCliKind,
  directory: string,
  configDirectory: string | undefined,
): Promise<string | undefined> {
  try {
    if (vendor === "claude" && configDirectory !== undefined) {
      return await captureClaudeSession(configDirectory);
    }
    if (vendor === "codex" && configDirectory !== undefined) {
      const raw = await readFile(path.join(configDirectory, "auth.json"), "utf8");
      return raw.trim();
    }
    if (vendor === "gemini") {
      const raw = await readFile(
        path.join(directory, ".gemini", "oauth_creds.json"),
        "utf8",
      );
      return raw.trim();
    }
    if (vendor === "cursor" || vendor === "copilot" || vendor === "kiro") {
      return await captureBrowserSession(directory);
    }
  } catch {
    // Missing, unreadable, or — for Claude — nothing worth capturing. All of
    // these mean "no rotation to record", never "lose the credential".
    return undefined;
  }
  return undefined;
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

  const stagingRoot = credentialStagingRoot();
  await mkdir(stagingRoot, { recursive: true }).catch(() => undefined);
  const directory = await mkdtemp(path.join(stagingRoot, "coord-cred-"));

  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  for (const name of ALL_CREDENTIAL_VARIABLES) {
    delete env[name];
  }
  if (delivery.via === "env") {
    env[delivery.variable] = credential.secret;
  }

  const configVariable = CONFIG_DIRECTORY_VARIABLES[vendor];
  // Hoisted out of the block below so the close hook can read the very
  // directory the CLI was handed. It used to guess, and guessed one level
  // too high: Codex was given `<home>/config` and writes its rollouts to
  // `<home>/config/sessions`, while the capture looked in `<home>/sessions`
  // — a directory nothing ever writes to. So the snapshot was never taken,
  // and every usage question on every deployment answered "no snapshot kept
  // from an earlier run", for as long as this has existed.
  let configDirectory: string | undefined;
  if (configVariable !== undefined) {
    configDirectory = path.join(directory, "config");
    await mkdir(configDirectory, { recursive: true });
    env[configVariable] = configDirectory;
    if (vendor === "claude" && credential.kind === "session_file") {
      await restoreClaudeSession(configDirectory, credential.secret);
    }
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
    // These CLIs have no configuration-directory variable, so the whole home is
    // redirected instead. That is blunter but achieves the same thing: the
    // host's ~/.gemini session is not on the path the CLI searches.
    env["HOME"] = directory;
    env["USERPROFILE"] = directory;
    // Redirecting the home also redirects wherever the CLI unpacks itself, so
    // the program cache is pointed back out at a shared directory. Without it
    // Copilot re-extracts ~200 files into every throwaway home.
    const programCache = programCacheEnv(vendor);
    Object.assign(env, programCache);
    if (vendor === "copilot") {
      await mkdir(copilotPackageCacheDirectory(), { recursive: true }).catch(
        () => undefined,
      );
    }
    // Redirecting the home also loses whatever directories the user had
    // marked trusted, and the CLI refuses to run headless in an untrusted
    // directory — it exits 55 naming this variable, before it ever attempts
    // authentication, which would otherwise surface as a confusing
    // "credential rejected".
    if (vendor === "gemini") {
      env["GEMINI_CLI_TRUST_WORKSPACE"] = "true";
    }

    if (vendor === "gemini" && credential.kind === "session_file") {
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
    } else if (vendor === "gemini" && credential.kind === "api_key") {
      // Same reason the session-file branch above writes this: without a
      // declared auth method the CLI refuses to start and names its settings
      // file instead of using the credential sitting next to it. The key
      // itself travels in the environment, and `validateAuthMethod` checks
      // GEMINI_API_KEY for exactly this type.
      const geminiDirectory = path.join(directory, ".gemini");
      await mkdir(geminiDirectory, { recursive: true });
      await writeFile(
        path.join(geminiDirectory, "settings.json"),
        `${JSON.stringify({
          security: { auth: { selectedType: "gemini-api-key" } },
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } else if (credential.kind === "session_file") {
      await restoreBrowserSession(directory, credential.secret);
    }
  }

  return {
    path: directory,
    env,
    close: async () => {
      // Only a session file can rotate. An API key is what the user typed and
      // the CLI never rewrites it, so there is nothing to read back.
      let rotatedSecret: string | undefined;
      if (credential.kind === "session_file") {
        const current = await readSessionSnapshot(
          vendor,
          directory,
          configVariable === undefined
            ? undefined
            : path.join(directory, "config"),
        );
        // Compared against what was written in, not merely checked for
        // existence: an unchanged file rewritten on every run would churn the
        // credential store and re-encrypt a secret that never moved.
        if (current !== undefined && current !== credential.secret.trim()) {
          rotatedSecret = current;
        }
      }
      // Codex records its rate limits only in the session rollouts it writes
      // under this very directory — which is about to be removed. Reading the
      // newest one's tail out first is the only chance the figures get to
      // outlive the run; without this, every home starts empty and every
      // usage question is answered "no session has recorded rate limits yet"
      // on a machine running Codex all day.
      let usageSnapshot: string | undefined;
      if (vendor === "codex") {
        usageSnapshot = await newestRolloutTail(
          path.join(configDirectory ?? directory, "sessions"),
        ).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
      return {
        ...(rotatedSecret === undefined ? {} : { rotatedSecret }),
        ...(usageSnapshot === undefined ? {} : { usageSnapshot }),
      };
    },
  };
}

/** The last 64KB of the most recently written rollout, or nothing. */
async function newestRolloutTail(root: string): Promise<string | undefined> {
  let newest: { path: string; at: number } | undefined;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => undefined);
        if (info !== undefined && (newest === undefined || info.mtimeMs > newest.at)) {
          newest = { path: full, at: info.mtimeMs };
        }
      }
    }
  };
  await walk(root, 0);
  if (newest === undefined) {
    return undefined;
  }
  const contents = await readFile(newest.path, "utf8");
  return contents.length > 65_536 ? contents.slice(-65_536) : contents;
}

/** Runs `use` against an isolated credential home and always cleans up after. */
export async function withCredentialHome<T>(
  input: {
    vendor: VendorCliKind;
    credential: UserCredential;
    baseEnv?: NodeJS.ProcessEnv;
    /**
     * Called when the CLI replaced its own session file during the run, with
     * the replacement to store. Optional so a caller with nowhere to put it
     * — a verification probe, a test — simply lets it go, but a caller that
     * runs real work should persist it or the next run starts from the
     * expired snapshot again.
     */
    onRotate?: (secret: string) => Promise<void> | void;
    /**
     * Called with the tail of the newest Codex rollout, when there is one.
     * Same contract as `onRotate`: persist it or it dies with the directory.
     */
    onUsageSnapshot?: (snapshot: string) => Promise<void> | void;
  },
  use: (home: CredentialHome) => Promise<T>,
): Promise<T> {
  const home = await openCredentialHome(input);
  try {
    return await use(home);
  } finally {
    const { rotatedSecret, usageSnapshot } = await home.close();
    if (usageSnapshot !== undefined && input.onUsageSnapshot !== undefined) {
      await Promise.resolve(input.onUsageSnapshot(usageSnapshot)).catch(
        () => undefined,
      );
    }
    if (rotatedSecret !== undefined && input.onRotate !== undefined) {
      // Never allowed to fail the run it followed: the work is already done,
      // and losing a refreshed token costs one reconnect, while throwing here
      // would discard a result somebody waited for.
      await Promise.resolve(input.onRotate(rotatedSecret)).catch(() => undefined);
    }
  }
}
