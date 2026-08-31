/**
 * Sending desktop browsers to the installer instead of the dashboard.
 *
 * ### What this is, and what it is not
 *
 * It is a signpost. The only thing separating the app from a browser on the
 * same machine is a marker the app puts in its own User-Agent, and a
 * User-Agent is client-supplied text that anybody can copy out of their own
 * install and paste into a browser. Somebody who wants past this will be past
 * it in under a minute, and no amount of sniffing changes that.
 *
 * That is the right shape for the job. The job is not to keep people out — it
 * is to stop a desktop browser being the path of least resistance, so that
 * "how do I run this" has one answer. The thing that actually protects the
 * hosting bill is `COORD_LOCAL_AGENTS_ONLY`, which refuses to execute agents
 * at all; this only decides which page somebody lands on. Treat it as
 * navigation, never as a control, and do not let anything security-shaped
 * come to depend on it.
 *
 * ### Why phones are let through
 *
 * There is no phone build to send anybody to. A worker on a phone is not a
 * thing that can exist — the vendor CLIs need to spawn processes and run the
 * project's toolchain — so the documented arrangement is that the desktop
 * does the work and the phone is a browser that dispatches and watches. Until
 * there are native mobile apps, blocking mobile browsers would remove that
 * workflow and offer nothing in its place.
 */

/** Appended by the desktop app to its own User-Agent. See `main.mjs`. */
export const DESKTOP_APP_MARKER = "KumiDesktop/";

/**
 * Windows Phone is deliberately absent from the tablet/phone list below: it
 * carries "Windows" too, and matching it would take every Windows desktop
 * with it. It has no meaningful install base to lose.
 */
const MOBILE_HINTS = [
  "Android",
  "iPhone",
  "iPad",
  "iPod",
  "Mobile",
  "Silk",
  "Kindle",
  "Opera Mini",
  "Opera Mobi",
];

export type Client = "app" | "mobile" | "desktop-browser";

/**
 * What kind of client sent this, as far as it is willing to say.
 *
 * Order matters. The app is Chromium and carries a desktop User-Agent under
 * its marker, so it has to be recognised before anything else looks at the
 * rest of the string.
 */
export function classifyClient(userAgent: string | undefined): Client {
  const value = userAgent ?? "";
  if (value.includes(DESKTOP_APP_MARKER)) {
    return "app";
  }
  if (MOBILE_HINTS.some((hint) => value.includes(hint))) {
    return "mobile";
  }
  return "desktop-browser";
}

/**
 * Whether this deployment sends desktop browsers to the download page.
 *
 * Off by default. A self-hosted install where the browser is the only client
 * anybody has must keep working, and this is a decision about how one product
 * is distributed rather than anything the software needs to be correct.
 */
export function desktopAppOnly(): boolean {
  return process.env["COORD_DESKTOP_APP_ONLY"] === "1";
}

/**
 * Whether this particular request for the dashboard should be redirected.
 *
 * Only the dashboard document. Assets, the API and every other route are
 * untouched: the app loads all of them from the same origin, and a gate that
 * caught them would break the very client it exists to favour.
 */
export function shouldRedirectToDownload(
  userAgent: string | undefined,
): boolean {
  return desktopAppOnly() && classifyClient(userAgent) === "desktop-browser";
}
