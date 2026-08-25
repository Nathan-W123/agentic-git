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
 * Where somebody sends a colleague to get the app.
 *
 * Its own document rather than a screen in the dashboard, and reachable
 * without signing in: the people who need it most are the ones who do
 * not have an account here yet. Loading the whole control room to render
 * a download button would also mean every one of its modules runs before
 * a stranger can read what this is.
 *
 * The links go to `releases/latest/download/<file>`, which GitHub
 * redirects to whatever the newest release calls that file. That is why
 * the installers are named without a version in them — see
 * `apps/desktop/electron-builder.yml`. Nothing on this page has to be
 * edited when a new version ships.
 *
 * The repository is named here and in `apps/desktop/package.json`, and
 * `download-links.test.ts` fails if the two ever disagree — which is not
 * hypothetical, since it has already been renamed once.
 */
const RELEASES = "https://github.com/Nathan-W123/Kumi/releases";
const asset = (file) => `${RELEASES}/latest/download/${file}`;

/**
 * Every build the release workflow produces, in the order to offer them.
 *
 * The `mac` and `win` in these names are not abbreviations somebody
 * chose: `${os}` in the artifact template expands to electron-builder's
 * own configuration key for the platform, which is `mac`, `win`, and
 * `linux`. Spelling them out here would produce links that 404. The
 * release workflow checks every name on this page against the files it
 * actually built, before it publishes any of them.
 */
const BUILDS = [
  { file: "Kumi-mac-arm64.dmg", label: "macOS", detail: "Apple silicon" },
  { file: "Kumi-mac-x64.dmg", label: "macOS", detail: "Intel" },
  { file: "Kumi-win-x64.exe", label: "Windows", detail: "64-bit" },
  { file: "Kumi-linux-x86_64.AppImage", label: "Linux", detail: "AppImage" },
  { file: "Kumi-linux-amd64.deb", label: "Linux", detail: "Debian, Ubuntu" },
];

const primary = document.getElementById("primary");
const alt = document.getElementById("alt");
const note = document.getElementById("note");

document.getElementById("all").innerHTML = BUILDS.map(
  (build) =>
    `<li><a href="${asset(build.file)}">${build.label} — ${build.detail}</a>
     <span>${build.file.split(".").pop()}</span></li>`,
).join("");

const agent = navigator.userAgent;
const handheld = /Android|iPhone|iPad|iPod/i.test(agent);
const system = handheld
  ? "handheld"
  : /Mac/i.test(agent)
    ? "macos"
    : /Win/i.test(agent)
      ? "windows"
      : /Linux|X11|CrOS/i.test(agent)
        ? "linux"
        : "unknown";

function offer(file, label, aside = "") {
  primary.href = asset(file);
  primary.textContent = label;
  alt.textContent = "";
  alt.innerHTML = aside;
}

if (system === "macos") {
  // Every browser on an Apple silicon Mac still reports "Intel Mac OS X"
  // in its user agent, so the architecture cannot be read from it. Nearly
  // every Mac sold since 2020 is Apple silicon, so that is the offer, and
  // Intel sits beside it in one click rather than behind a wrong guess.
  offer(
    "Kumi-mac-arm64.dmg",
    "Download for Mac",
    `Apple silicon. <a href="${asset("Kumi-mac-x64.dmg")}">Intel Mac</a>`,
  );
  // Chromium can be asked directly, and is worth asking: it is most of
  // the Macs that will see this page.
  void navigator.userAgentData
    ?.getHighEntropyValues(["architecture"])
    .then((values) => {
      if (values.architecture === "x86") {
        offer(
          "Kumi-mac-x64.dmg",
          "Download for Mac",
          `Intel. <a href="${asset("Kumi-mac-arm64.dmg")}">Apple silicon</a>`,
        );
      }
    })
    .catch(() => {
      // An older Chromium, or one that declines. The default stands.
    });
} else if (system === "windows") {
  offer("Kumi-win-x64.exe", "Download for Windows", "64-bit installer");
} else if (system === "linux") {
  offer(
    "Kumi-linux-x86_64.AppImage",
    "Download for Linux",
    `AppImage. <a href="${asset("Kumi-linux-amd64.deb")}">.deb for Debian and Ubuntu</a>`,
  );
} else if (system === "handheld") {
  primary.href = RELEASES;
  primary.textContent = "See all downloads";
  alt.textContent =
    "Kumi's app is for Mac, Windows and Linux. Kumi itself works in this browser.";
} else {
  primary.href = RELEASES;
  primary.textContent = "See all downloads";
  alt.textContent = "Pick the one that matches your machine.";
}

note.innerHTML =
  "Kumi is not signed by Apple or Microsoft yet, so the first launch " +
  "shows a warning once. The " +
  `<a href="${RELEASES}/latest">release notes</a> say how to get past ` +
  "it on each system.";
