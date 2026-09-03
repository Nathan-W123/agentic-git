/**
 * Reading a field out of a request body, or refusing the request.
 *
 * Every validator here throws `HttpError` rather than returning a result,
 * because a route that forgets to check a returned error still sends a 200.
 * Throwing makes the omission impossible.
 */

import type { McpServerScope } from "@coord/persistence";
import {
  uniqueStrings,
  type McpServerTransport,
} from "@coord/shared-types";

import { API_PREFIX } from "./http-util.js";
import { EDITOR_VENDORS, type EditorVendor } from "./mcp-work.js";

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A colour, accepted only as `#rrggbb`.
 *
 * The value is written into a `style` attribute by the dashboard, so anything
 * looser than an exact hex triple is an injection point: `red;background:url()`
 * is a perfectly good CSS colour prefix. Validating at the edge means the
 * browser never has to sanitise it.
 */
export function hexColorField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.trim())) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} must be a #rrggbb colour`,
    );
  }
  return value.trim().toLowerCase();
}

/**
 * How long one message may be, per place a person writes one.
 *
 * Named rather than repeated at each route, because these numbers are also
 * what the composer counts down to: the dashboard carries the same three
 * figures, and a limit only one side knows is a limit somebody meets as a
 * failed send. See `messageLimitFor` in the browser's `data.js`.
 */
export const CHANNEL_MESSAGE_MAX_CHARS = 10_000;
export const DIRECT_MESSAGE_MAX_CHARS = 8_000;
/** One turn typed to a provider, in the private agent panel. */
export const AGENT_CHAT_MAX_CHARS = 10_000;
/**
 * How many turns of that conversation may be replayed with a request.
 *
 * The panel posts the whole conversation each time, so this is a ceiling on
 * the transcript rather than on what was just typed. Far above any real
 * session: it is here so a runaway client cannot post an unbounded array,
 * not to end a long conversation.
 */
export const AGENT_CHAT_MAX_MESSAGES = 500;

/** `1234` as `1,234`, so a limit in a sentence reads as a number. */
export function countedChars(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * The conversation posted with one private-chat turn.
 *
 * Only two things are checked here, and both of them are things a person can
 * do something about: how long the turn they just typed is, and how much
 * transcript is being replayed with it. Everything else about a message —
 * roles, ordering, provider-specific shapes — belongs to the adapter that
 * speaks to the provider, and is left to it.
 */
export function chatMessagesField(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const entries = value as readonly unknown[];
  if (entries.length > AGENT_CHAT_MAX_MESSAGES) {
    throw new HttpError(
      400,
      "invalid_request",
      `This conversation is ${countedChars(
        entries.length - AGENT_CHAT_MAX_MESSAGES,
      )} messages over the ${countedChars(
        AGENT_CHAT_MAX_MESSAGES,
      )}-message limit — start a new chat to carry on`,
    );
  }
  for (const entry of entries) {
    const content: unknown =
      typeof entry === "object" && entry !== null
        ? (entry as { content?: unknown }).content
        : undefined;
    if (typeof content !== "string") {
      continue;
    }
    const length = content.trim().length;
    if (length > AGENT_CHAT_MAX_CHARS) {
      throw new HttpError(
        400,
        "invalid_request",
        `A message is ${countedChars(
          length - AGENT_CHAT_MAX_CHARS,
        )} characters over the ${countedChars(
          AGENT_CHAT_MAX_CHARS,
        )}-character limit (this one is ${countedChars(length)})`,
      );
    }
  }
  return value;
}

export function stringField(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional === true) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `${field} must be a string`);
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;
  if (trimmed.length < min) {
    throw new HttpError(
      400,
      "invalid_request",
      min === 1
        ? `${field} cannot be empty`
        : `${field} must be at least ${countedChars(min)} characters`,
    );
  }
  // The number, and how far over it this is. The old wording named neither,
  // and reached the sender as "could not send" with nothing to act on: no cap
  // to write to, and no idea how much had to come out.
  if (trimmed.length > max) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} is ${countedChars(trimmed.length - max)} characters over the ` +
        `${countedChars(max)}-character limit ` +
        `(this one is ${countedChars(trimmed.length)})`,
    );
  }
  return trimmed;
}

export function emailField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const email = stringField(value, "email", {
    max: 320,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    email !== undefined &&
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)
  ) {
    throw new HttpError(400, "invalid_email", "email is not valid");
  }
  return email?.toLowerCase();
}

export function slugField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const slug = stringField(value, "slug", {
    max: 80,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    slug !== undefined &&
    !/^[a-z0-9][a-z0-9._-]*$/iu.test(slug)
  ) {
    throw new HttpError(
      400,
      "invalid_slug",
      "slug must start alphanumeric and contain only letters, digits, dot, dash, or underscore",
    );
  }
  return slug?.toLowerCase();
}

export function booleanField(
  value: unknown,
  field: string,
  optional = true,
): boolean | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${field} must be a boolean`);
  }
  return value;
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

/**
 * What a vendor config will call an MCP server: a bare key in Codex's TOML
 * and in Claude's JSON, nothing that needs quoting in either. The same
 * expression the Codex adapter applies again before writing the file, so a
 * name this route accepts is one the adapter will not refuse later, when the
 * person who typed it is no longer looking.
 */
export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/**
 * A stdio server's executable, in the two shapes `spawn` resolves without a
 * shell: a bare name looked up on the worker's PATH, or an absolute path.
 * A relative path with a directory in it is refused — it would resolve
 * against whatever working directory the worker happened to have, which is
 * a workspace the agent writes to.
 */
export const MCP_BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;
export const MCP_ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;
/**
 * Nothing that means something to a shell or to cmd.exe. The worker never
 * starts a shell, but a `.cmd` shim on Windows does — the process runner
 * refuses the same tokens at spawn time for exactly that reason — and a
 * command that would be refused on the machine it was meant for should be
 * refused here, where the person configuring it can still read the answer.
 */
export const MCP_UNSAFE_COMMAND_TOKEN = /[\0\r\n\t"'`$&|;<>^%!(){}[\]*?#~]/u;

/** An environment variable or HTTP header name, as either side will take it. */
export const MCP_VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u;

export const MCP_MAX_ARGS = 32;
export const MCP_MAX_ARG_LENGTH = 512;
export const MCP_MAX_VALUES = 32;
export const MCP_MAX_VALUE_LENGTH = 4_096;
export const MCP_MAX_SECRETS = 16;
export const MCP_MAX_SECRET_LENGTH = 4_096;
export const MCP_MAX_REPOSITORIES = 64;

export function mcpServerNameField(value: unknown): string {
  const name = stringField(value, "name", { max: 64 }) ?? "";
  if (!MCP_SERVER_NAME.test(name)) {
    throw new HttpError(
      400,
      "invalid_request",
      "name must be lower-case letters, digits, dash, or underscore, " +
        "starting with a letter or digit, up to 64 characters",
    );
  }
  return name;
}

export function mcpTransportField(
  value: unknown,
  optional: boolean,
): McpServerTransport | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  if (value !== "stdio" && value !== "http") {
    throw new HttpError(
      400,
      "invalid_request",
      'transport must be "stdio" or "http"',
    );
  }
  return value;
}

/** `null` clears the field on an edit; absent leaves it alone. */
export function mcpCommandField(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  const command = stringField(value, "command", { max: 1_024, optional: true });
  if (command === undefined) {
    return undefined;
  }
  if (
    MCP_UNSAFE_COMMAND_TOKEN.test(command) ||
    !(MCP_BARE_EXECUTABLE.test(command) || MCP_ABSOLUTE_PATH.test(command))
  ) {
    throw new HttpError(
      400,
      "invalid_command",
      "command must be a bare executable name or an absolute path, with no " +
        "quotes, spaces in a bare name, or shell control characters",
    );
  }
  return command;
}

export function mcpArgsField(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MCP_MAX_ARGS) {
    throw new HttpError(
      400,
      "invalid_request",
      `args must be an array of at most ${MCP_MAX_ARGS} strings`,
    );
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length > MCP_MAX_ARG_LENGTH ||
      entry.includes("\0")
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        `each arg must be a string of at most ${MCP_MAX_ARG_LENGTH} characters`,
      );
    }
    return entry;
  });
}

/**
 * Whether a URL is Kumi's own MCP endpoint, on this deployment or another.
 *
 * An agent handed this deployment's MCP server could submit work to itself:
 * a task that dispatches a task that dispatches a task, each on a teammate's
 * laptop, each billed. The exact path is refused on every host, because a
 * host name is not an identity — the same deployment answers on every name
 * that resolves to it, on loopback from its own machine, and behind whatever
 * a proxy calls it — and another Kumi's endpoint is the same loop one hop
 * longer. The suffix is refused only on this deployment's own names, for the
 * case where it is mounted under a path prefix.
 */
/**
 * The editor a token is being minted for, or nothing.
 *
 * Anything unrecognised reads as "not an editor" rather than as an error: the
 * value decides who does somebody's work, and an unknown one must fall back to
 * asking rather than name an agent nobody has.
 */
export function optionalEditorVendor(value: unknown): EditorVendor | undefined {
  return typeof value === "string"
    ? EDITOR_VENDORS.find((vendor) => vendor === value.trim().toLowerCase())
    : undefined;
}

export function mcpUrlLoopsBack(url: URL, ownHosts: readonly string[]): boolean {
  const pathname = url.pathname.replace(/\/+$/u, "");
  const endpoint = `${API_PREFIX}/mcp`;
  if (pathname === endpoint) {
    return true;
  }
  return (
    pathname.endsWith(endpoint) && ownHosts.includes(url.host.toLowerCase())
  );
}

export function mcpUrlField(
  value: unknown,
  ownHosts: readonly string[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  const raw = stringField(value, "url", { max: 2_048, optional: true });
  if (raw === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_url", "url must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpError(
      400,
      "invalid_url",
      "url must not carry credentials; put them in secrets as a header",
    );
  }
  // Plain HTTP only to the worker's own machine. A secret header travels on
  // every request to this URL, and a loopback listener is the one place it
  // cannot be read off the wire.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HttpError(
      400,
      "invalid_url",
      "url must use https, or http to localhost only",
    );
  }
  if (mcpUrlLoopsBack(url, ownHosts)) {
    throw new HttpError(
      400,
      "mcp_loop",
      "url is Kumi's own MCP endpoint; an agent given it could dispatch " +
        "work to itself",
    );
  }
  return url.toString();
}

/** Plain, non-secret environment or header values. */
export function mcpValuesField(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectBody(value);
  const entries = Object.entries(record);
  if (entries.length > MCP_MAX_VALUES) {
    throw new HttpError(
      400,
      "invalid_request",
      `values may hold at most ${MCP_MAX_VALUES} entries`,
    );
  }
  const values: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (!MCP_VALUE_NAME.test(name)) {
      throw new HttpError(
        400,
        "invalid_request",
        `${name} is not a valid environment variable or header name`,
      );
    }
    if (
      typeof entry !== "string" ||
      entry.length > MCP_MAX_VALUE_LENGTH ||
      /[\0\r\n]/u.test(entry)
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        `values.${name} must be a single-line string of at most ` +
          `${MCP_MAX_VALUE_LENGTH} characters`,
      );
    }
    values[name] = entry;
  }
  return values;
}

/**
 * Secrets as they arrive: plaintext, to be sealed before anything stores
 * them. `null` removes one on an edit and is refused on create, where there
 * is nothing to remove.
 */
export function mcpSecretsField(
  value: unknown,
  options: { allowNull: boolean },
): Record<string, string | null> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectBody(value);
  const entries = Object.entries(record);
  if (entries.length > MCP_MAX_SECRETS) {
    throw new HttpError(
      400,
      "invalid_request",
      `secrets may hold at most ${MCP_MAX_SECRETS} entries`,
    );
  }
  const secrets: Record<string, string | null> = {};
  for (const [name, entry] of entries) {
    if (!MCP_VALUE_NAME.test(name)) {
      throw new HttpError(
        400,
        "invalid_request",
        `${name} is not a valid environment variable or header name`,
      );
    }
    if (entry === null && options.allowNull) {
      secrets[name] = null;
      continue;
    }
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MCP_MAX_SECRET_LENGTH ||
      /[\0\r\n]/u.test(entry)
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        `secrets.${name} must be a non-empty single-line string of at most ` +
          `${MCP_MAX_SECRET_LENGTH} characters`,
      );
    }
    secrets[name] = entry;
  }
  return secrets;
}

export function mcpScopeField(value: unknown): McpServerScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "project" && value !== "repository") {
    throw new HttpError(
      400,
      "invalid_request",
      'scope must be "project" or "repository"',
    );
  }
  return value;
}

export function mcpRepositoryIdsField(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MCP_MAX_REPOSITORIES) {
    throw new HttpError(
      400,
      "invalid_request",
      `repositoryIds must be an array of at most ${MCP_MAX_REPOSITORIES} ids`,
    );
  }
  return uniqueStrings(
    value.map((entry) => stringField(entry, "repositoryIds[]", { max: 200 }) ?? ""),
  );
}

/**
 * The secrets in a create or edit body must not also be plain values, and
 * the other way round. Both end up in the same environment or header set,
 * secrets winning — so a name in both is a value that silently does nothing,
 * and the person who set it would find out on a machine they cannot see.
 */
export function assertMcpNamesDisjoint(
  values: Record<string, string> | undefined,
  secrets: Record<string, string | null> | undefined,
): void {
  for (const name of Object.keys(secrets ?? {})) {
    if (values !== undefined && name in values) {
      throw new HttpError(
        400,
        "invalid_request",
        `${name} cannot be both a value and a secret`,
      );
    }
  }
}
