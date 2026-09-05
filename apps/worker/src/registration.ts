/**
 * Getting registered, including when the answer is no.
 *
 * Its own module because `index.ts` runs `main()` at import and so cannot be
 * loaded by a test, and because the behaviour here is the whole difference
 * between a worker that heals itself and one that has to be restarted by
 * hand — which is worth a test rather than a comment.
 */

import { ControlPlaneError } from "./client.js";
import { signalHost, type HostSignal } from "./host-signal.js";

/**
 * How long to wait between attempts at a registration that was refused.
 *
 * A refusal is not a crash, and it is the one failure here that nothing on
 * this machine can fix. Somebody with administrative access has to finish an
 * invitation, renew a subscription or reissue a token, and when they do, the
 * right behaviour is for this worker to notice by itself — the person who
 * fixed it is looking at a billing page, not at somebody else's laptop.
 *
 * Exiting instead is what used to happen, and the supervisor read it as the
 * kind of immediate death that means "misconfigured": four restarts, then
 * "the worker kept exiting immediately and was not restarted", which is both
 * true and useless. So the wait grows to a minute and stays there. A worker
 * that has been refused for an hour is still worth one attempt a minute, and
 * hammering a control plane that has already said no helps nobody.
 */
export const REFUSED_RETRY_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * A control plane that answered, and whose answer was "no".
 *
 * Only these two. A 404 is a wrong address and a 500 is a broken deployment,
 * and neither gets better by asking again politely for an hour.
 */
export function isRefusal(error: unknown): error is ControlPlaneError {
  return (
    error instanceof ControlPlaneError &&
    (error.status === 401 || error.status === 403)
  );
}

/** What the wait between attempts is, by how many have already been refused. */
export function refusedRetryMs(refusals: number): number {
  const index = Math.min(Math.max(refusals, 0), REFUSED_RETRY_MS.length - 1);
  return REFUSED_RETRY_MS[index] ?? 60_000;
}

export interface RegistrationHooks {
  /** How the host is told; the real one posts to the Electron parent port. */
  signal?: (signal: HostSignal) => void;
  /** How the wait happens, so a test does not take a minute to run. */
  wait?: (ms: number) => Promise<void>;
  /** Where the retry countdown is written, which is the log file. */
  report?: (line: string) => void;
}

/**
 * Registers, waiting out a refusal rather than dying of one.
 *
 * Every other failure still throws. An unreachable server, a malformed answer
 * and a bad project root are all things a restart can plausibly fix, and the
 * supervisor is better at restarting than this loop is.
 *
 * `registered` is sent on every success and not only on the ones that follow
 * a refusal: a host that has to work out for itself when to stop believing
 * the last thing it was told is a host that gets it wrong.
 */
export async function registerWhenAllowed(
  register: () => Promise<string>,
  hooks: RegistrationHooks = {},
): Promise<string> {
  const signal = hooks.signal ?? signalHost;
  const wait =
    hooks.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const report = hooks.report ?? ((line: string) => console.error(line));

  for (let refusals = 0; ; refusals += 1) {
    try {
      const identity = await register();
      signal({ type: "registered" });
      return identity;
    } catch (error: unknown) {
      if (!isRefusal(error)) {
        throw error;
      }
      const detail = error.message;
      signal({ type: "registration-refused", detail });
      const ms = refusedRetryMs(refusals);
      report(
        `[worker] Not registered: ${detail} Trying again in ` +
          `${Math.round(ms / 1000)}s.`,
      );
      await wait(ms);
    }
  }
}
