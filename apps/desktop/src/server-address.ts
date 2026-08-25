/**
 * Turning what somebody typed into an address this app can use.
 *
 * The first thing a downloaded copy does is ask for a server, which makes this
 * the first thing that can go wrong for somebody with no terminal to read an
 * error out of. A typo should be a sentence on the setup screen, not a window
 * that opens onto nothing.
 *
 * Here rather than in `electron/main.mjs`, and free of any Electron import,
 * for the same reason the sign-in flow is: the part with the edge cases is the
 * part worth testing, and it is testable only while it is ordinary Node.
 */

/** Either the address is fine, or there is a sentence saying why it is not. */
export type ServerCheck = { ok: true } | { ok: false; message: string };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * An origin, or nothing if what was typed could not be one.
 *
 * A bare host is read as `https`, because that is what a deployment address
 * looks like and demanding the scheme would turn somebody away for a reason
 * they cannot see. A path is kept, so a Kumi served under one still works.
 */
export function normalizeServer(raw: string | undefined): string | undefined {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/\/+$/u, "");
  if (trimmed === "") {
    return undefined;
  }
  const addressed = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(addressed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/**
 * Confirms an address is a Kumi before it is written down.
 *
 * `/health` is the one route that answers without a credential, which is
 * exactly what is needed here: the whole point is to tell a typo from a
 * deployment while nobody is signed in to anything yet.
 */
export async function verifyServer(
  server: string,
  timeoutMs = 12_000,
): Promise<ServerCheck> {
  let response: Response;
  try {
    response = await fetch(`${server}/api/v1/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      message: `Could not reach ${server}. Check the address, and that you are online.`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      message: `${server} answered with ${String(response.status)}. That does not look like a Kumi deployment.`,
    };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { status?: unknown }
    | undefined;
  if (body?.status !== "ok") {
    return {
      ok: false,
      message: `Something answered at ${server}, but it is not a Kumi deployment.`,
    };
  }
  return { ok: true };
}
