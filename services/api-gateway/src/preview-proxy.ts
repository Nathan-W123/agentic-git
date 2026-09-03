/**
 * Serving somebody else's dev server through this origin.
 *
 * A preview is a third-party page rendered under a Kumi URL, which makes
 * every absolute path in it wrong and every hop-by-hop header dangerous to
 * forward. These rewrite the one and strip the other.
 */

import type {
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from "node:http";

import { API_PREFIX } from "./http-util.js";

/**
 * Where a proxied preview lives, from the browser's point of view.
 *
 * The app itself thinks it is at the root of an origin — every framework
 * writes `/assets/index.js` and means "the top of wherever I am served". Here
 * it is served underneath a path, so the top of the origin is the control
 * plane and not the app: a root-absolute asset asked the dashboard for the
 * app's bundle, got this deployment's 404 (or, for an extensionless one, its
 * own index.html), and the page rendered as an empty white document with no
 * error anybody could read.
 *
 * This is the prefix everything the app asks for has to be moved under. One
 * function because three separate readers need the same answer: the `<base>`
 * that fixes relative URLs, the rewrite that fixes root-absolute ones, and
 * the redirect rewrite that fixes the `Location` of a login bounce.
 */
export function previewBaseHref(
  projectId: string,
  repositoryId: string,
): string {
  return (
    `${API_PREFIX}/projects/${encodeURIComponent(projectId)}` +
    `/repositories/${encodeURIComponent(repositoryId)}/preview/app/`
  );
}

/**
 * Whether a path is one the previewed app answers, rather than this one.
 *
 * Tested before routing so the response's headers can be decided before a
 * single one is written — see `securityHeaders`. Kept beside
 * {@link previewBaseHref} because the two describe the same URL shape and
 * drifting apart would mean a preview served under headers meant for the
 * dashboard, which is the failure this file exists to stop repeating.
 */
export const PREVIEW_APP_PATH = new RegExp(
  `^${API_PREFIX}/projects/[^/]+/repositories/[^/]+/preview/app(?:/|$)`,
  "u",
);

/** Attributes whose value is one URL the browser will go and fetch. */
export const PREVIEW_URL_ATTRIBUTES =
  /\b(src|href|action|poster|formaction|data|srcset|imagesrcset)=("|')\/(?!\/)/giu;

/**
 * Moves a previewed page's own addresses under the path it is served from.
 *
 * Two separate repairs, because a page has two kinds of address in it and
 * only one of them is fixable by declaration:
 *
 * - A `<base>` element handles every *relative* URL at once, and also pins
 *   them for a client-side route: an SPA sitting at `…/preview/app/settings`
 *   otherwise resolves `./assets/x.js` against `…/preview/app/`'s child and
 *   asks for a bundle that was never there.
 * - Root-absolute URLs ignore `<base>` entirely — that is the whole point of
 *   the leading slash — so each one is rewritten in place. This is the repair
 *   that matters: `/assets/index.js` is what a built Vite, Next or CRA app
 *   emits, and it is exactly the request that was reaching the control plane
 *   instead of the app.
 *
 * Protocol-relative `//host/…` is deliberately left alone: it names another
 * origin, and moving it under this path would break a page that is correctly
 * asking somewhere else.
 *
 * Nothing here tries to rewrite URLs built by script at runtime. It cannot be
 * done honestly from the outside — a string concatenated in a bundle is not
 * distinguishable from any other string — and the `<base>` plus the document's
 * own paths is what makes the overwhelming majority of apps render. An app
 * that computes absolute paths in JavaScript is still best served by opening
 * the loopback address directly, which is what the title on the link says.
 */
export function rewritePreviewHtml(html: string, base: string): string {
  const rewritten = html.replace(
    PREVIEW_URL_ATTRIBUTES,
    (_match, attribute: string, quote: string) =>
      `${attribute}=${quote}${base}`,
  );
  const baseTag = `<base href="${base}">`;
  // Ahead of anything that could already have been fetched by the time it is
  // read: a `<base>` after the first `<script src>` does not apply to it.
  const head = /<head\b[^>]*>/iu.exec(rewritten);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return rewritten.slice(0, at) + baseTag + rewritten.slice(at);
  }
  const html5 = /<html\b[^>]*>/iu.exec(rewritten);
  if (html5?.index !== undefined) {
    const at = html5.index + html5[0].length;
    return rewritten.slice(0, at) + baseTag + rewritten.slice(at);
  }
  return baseTag + rewritten;
}

/**
 * How much of a preview's document is read before it is rewritten.
 *
 * A page is kilobytes. Anything past this is not a document somebody is
 * reading — a data URL of a video, a generated report — and it is streamed on
 * untouched rather than held whole in this process's memory, where a reader
 * loading their own app could otherwise use it as a way to exhaust the
 * deployment.
 */
export const MAX_REWRITTEN_PREVIEW_BYTES = 4 * 1024 * 1024;

/** Headers that describe one hop and must not be copied onto the next. */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * What to send back for one answer the previewed app gave.
 *
 * Three things this has to get right, all of which were wrong:
 *
 * 1. **The control plane's own policy has to come off.** `securityHeaders`
 *    sets a `Content-Security-Policy` describing *this dashboard* — no inline
 *    script, no `eval`, `base-uri 'none'` — and `X-Frame-Options: DENY`. On a
 *    proxied preview that is a policy about the wrong application: it blocks
 *    the inline bootstrap script every bundler emits, blocks the `<base>` that
 *    makes the rest of the page resolve, and the result is a blank document.
 *    The app's own policy is kept where it sent one; where it did not, a
 *    permissive one is written, because a preview exists to run the app rather
 *    than to sandbox it.
 * 2. **Redirects have to be moved too.** A dev server answering `/` with a 302
 *    to `/login` sends the reader to the dashboard's own `/login`, which is a
 *    different application entirely.
 * 3. **Cookies have to stay in the preview's own path**, so an app that sets
 *    one called `coord_session` cannot sign the reader out of the deployment
 *    they are watching it from.
 */
export function previewProxyHeaders(
  upstream: IncomingHttpHeaders,
  base: string,
  previewOrigin: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    if (lower === "location" && typeof value === "string") {
      headers[name] = rewritePreviewLocation(value, base, previewOrigin);
      continue;
    }
    if (lower === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [String(value)];
      headers[name] = cookies.map((cookie) =>
        /;\s*path=/iu.test(cookie)
          ? cookie.replace(/;\s*path=[^;]*/iu, `; Path=${base}`)
          : `${cookie}; Path=${base}`,
      );
      continue;
    }
    headers[name] = value;
  }
  // Always written, never merely left off: an absent header here would let
  // the control plane's own `setHeader` value survive onto this response,
  // which is the bug rather than the fix.
  const stated = upstream["content-security-policy"];
  headers["content-security-policy"] =
    typeof stated === "string" ? stated : PREVIEW_CONTENT_SECURITY_POLICY;
  // Same origin, so the dashboard may frame its own preview and nobody else
  // may frame either of them. `DENY` — what this deployment sends for its own
  // pages — would also refuse the dashboard.
  headers["x-frame-options"] = "SAMEORIGIN";
  return headers;
}

/**
 * The policy a previewed app runs under when it states none of its own.
 *
 * Deliberately loose, and not a widening of what a previewed app can do. The
 * page is somebody's dev server — inline scripts, `eval` in a bundler's HMR
 * client, `blob:` workers, a font or a stylesheet from a CDN — and every one
 * of those, restricted, is a working app rendered as a white rectangle with a
 * console message no reader of this product will ever open. The app was
 * always able to run its own code here: it is served same-origin, and
 * `script-src 'self'` allowed its bundle. What the strict policy stopped was
 * never an attacker; it was the app.
 *
 * `frame-ancestors 'self'` is kept because it costs the app nothing and is
 * the one clause that is about this deployment rather than about the page.
 */
export const PREVIEW_CONTENT_SECURITY_POLICY =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "frame-ancestors 'self'";

/** Moves a redirect the app issued into the path the app is served under. */
export function rewritePreviewLocation(
  location: string,
  base: string,
  previewOrigin: string,
): string {
  if (location.startsWith(previewOrigin)) {
    return base + location.slice(previewOrigin.length).replace(/^\//u, "");
  }
  if (location.startsWith("/") && !location.startsWith("//")) {
    return base + location.slice(1);
  }
  return location;
}
