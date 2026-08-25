/*
 * Moved out of the page it belongs to, and it has to stay out.
 *
 * The control plane serves `script-src 'self'` with no `'unsafe-inline'`, so
 * an inline <script> in a served document is not executed and not reported —
 * the page renders its static markup, the buttons have no listeners, and
 * clicking them does nothing at all. That is exactly what this file's contents
 * did while they were inline: the approve page came up looking correct and
 * inert. `page-scripts.test.ts` fails if any served page grows an inline
 * script again.
 */

/**
 * The page an app sends somebody to so they can say yes.
 *
 * Deliberately its own document rather than a route in the dashboard.
 * It is reached from outside — a desktop app opens it — and it must be
 * legible and decidable on its own: one thing being asked for, by name,
 * with the two buttons that answer it. Loading the whole control room to
 * render a confirmation would also mean every one of its modules runs
 * before the person can read the question.
 */
const params = new URLSearchParams(window.location.search);
const redirectUri = params.get("redirect_uri") ?? "";
const state = params.get("state") ?? "";
const name = (params.get("name") ?? "").trim() || "A Kumi app";

const heading = document.getElementById("heading");
const note = document.getElementById("note");
const approve = document.getElementById("approve");
const cancel = document.getElementById("cancel");
document.getElementById("app-name").textContent = name;

/**
 * The same check the server makes, made again here.
 *
 * Not a substitute for it — the server's is the one that matters, and it
 * refuses anything else — but a person should be told the address is
 * wrong before they approve it, rather than after.
 */
function isLoopback(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function csrfToken() {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("coord_csrf="))
      ?.slice("coord_csrf=".length) ?? ""
  );
}

if (!isLoopback(redirectUri)) {
  heading.textContent = "This sign-in link is not valid";
  note.textContent =
    "An app can only be approved for an address on this machine. " +
    "Start the sign-in again from the app itself.";
  approve.disabled = true;
  cancel.textContent = "Close";
}

cancel.addEventListener("click", () => {
  window.location.assign("/");
});

approve.addEventListener("click", async () => {
  approve.disabled = true;
  note.textContent = "Approving…";
  try {
    const response = await fetch(
      "/api/v1/auth/app-authorization/approve",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({ name, redirectUri, state }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        // Signing in is the missing step, not a failure. Come back here
        // afterwards so the app is not left waiting for nothing.
        const back = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.assign(`/#auth?next=${back}`);
        return;
      }
      throw new Error(
        data?.error?.message ?? `Approval failed (${response.status})`,
      );
    }
    heading.textContent = "Approved";
    note.textContent = "Returning you to the app…";
    // The address the server built, not the one this page was handed:
    // it was checked on that side, and this is what keeps the browser
    // from being sent somewhere the check never saw.
    window.location.assign(data.redirectTo);
  } catch (error) {
    approve.disabled = false;
    note.textContent = error.message;
  }
});
