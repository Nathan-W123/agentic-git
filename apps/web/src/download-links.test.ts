import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The download page and the app have to agree about where releases live.
 *
 * They are two files in two workspaces, and the address between them is the
 * one a stranger clicks and the one a shipped copy checks for updates. The
 * repository has already been renamed once; the failure that would follow a
 * second rename is a download button that silently serves a redirect, or
 * nothing, and nobody would notice until somebody complained.
 *
 * Deliberately a test rather than a shared constant. Wiring the web server's
 * asset loading to another workspace's manifest at runtime would put a real
 * dependency between them to prevent a mistake that a string comparison
 * catches just as well, and this fails on the machine that made it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * Every served file that names a release, read as one thing.
 *
 * The download page and the script beside it are both searched because the
 * links live in whichever of them happens to hold the behaviour, and that
 * moved once already: extracting the script to satisfy the content security
 * policy took every filename with it, and a check that read only the HTML
 * found nothing and said so cheerfully.
 *
 * The marketing site used to be a third copy of these filenames and was
 * checked here too. It now lives in the Kumi-Website repository, which
 * carries the same check in its own suite — the filenames still have to
 * agree with the packager, and the guard went with the pages.
 */
const RELEASE_PAGES = [
  ["download.html"],
  ["download.js"],
];

async function downloadPageSource(): Promise<string> {
  const parts = await Promise.all(
    RELEASE_PAGES.map(async (name) =>
      await readFile(
        path.join(repoRoot, "apps", "web", "public", ...name),
        "utf8",
      ),
    ),
  );
  return parts.join("\n");
}

async function releasesRepoInPage(): Promise<string> {
  const page = await downloadPageSource();
  const named = [
    ...page.matchAll(/https:\/\/github\.com\/([^/"'\s]+\/[^/"'\s]+)\/releases/gu),
  ].map((match) => match[1]);
  assert.ok(named.length > 0, "download.html names no releases repository");
  const distinct = new Set(named);
  assert.equal(
    distinct.size,
    1,
    `download.html names more than one releases repository: ${[...distinct].join(", ")}`,
  );
  return named[0] as string;
}

async function releasesRepoInApp(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "apps", "desktop", "package.json"),
      "utf8",
    ),
  ) as { kumi?: { releasesRepo?: unknown }; homepage?: unknown };
  const named = manifest.kumi?.releasesRepo;
  assert.equal(
    typeof named,
    "string",
    "apps/desktop/package.json has no kumi.releasesRepo",
  );
  return named as string;
}

test("the download page points at the repository the app is released to", async () => {
  assert.equal(await releasesRepoInPage(), await releasesRepoInApp());
});

test("the app's homepage points at the same repository", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "apps", "desktop", "package.json"),
      "utf8",
    ),
  ) as { homepage?: unknown };
  assert.equal(
    manifest.homepage,
    `https://github.com/${await releasesRepoInApp()}`,
  );
});

test("every download the page offers is a file the packager actually builds", async () => {
  // The names come from `artifactName` in `electron-builder.yml`, which is
  // deliberately version-free so these links never expire. A typo here is a
  // 404 nobody sees until somebody clicks it, and a change to the template
  // there is one nobody would think to make here.
  const config = await readFile(
    path.join(repoRoot, "apps", "desktop", "electron-builder.yml"),
    "utf8",
  );
  const template = /^artifactName:\s*(\S+)\s*$/mu.exec(config)?.[1];
  assert.equal(
    template,
    "${productName}-${os}-${arch}.${ext}",
    "the artifact name template changed; the download page's links need to match",
  );

  const page = await downloadPageSource();
  // Collected case-insensitively and compared exactly, which is the whole
  // point: a release asset path is case sensitive, so `KUMI-win-x64.exe` is
  // a 404 and not a spelling preference. Matching only `Kumi-` would let
  // that name through by never seeing it at all — which is how the marketing
  // site once came to ship five links that cannot resolve.
  const offered = new Set(
    [
      ...page.matchAll(
        /(kumi-[a-z0-9_.-]+\.(?:dmg|zip|exe|appimage|deb))/giu,
      ),
    ].map((match) => match[1] as string),
  );
  assert.ok(offered.size > 0, "the download page offers no files");
  // A list this test also wrote can only catch drift between two files, not a
  // name that was never right. The release workflow checks the same names
  // against the artifacts three real runners produced, which is the check that
  // can actually fail on reality; this one fails sooner and on a laptop.

  // Every target in the config, spelled the way the template spells it.
  //
  // `${os}` is not a friendly platform name: it expands to electron-builder's
  // own configuration key, so it is `mac` and `win`, never `macos` or
  // `windows`. Getting that wrong produces links that look right and 404, and
  // it is the mistake this list exists to hold still. The Linux names are odd
  // for a different reason — AppImage and `.deb` each impose their own
  // architecture spelling on top of `${arch}` — and both were taken from a
  // real build rather than guessed.
  const built = new Set([
    "Kumi-mac-arm64.dmg",
    "Kumi-mac-x64.dmg",
    "Kumi-win-x64.exe",
    "Kumi-linux-x86_64.AppImage",
    "Kumi-linux-amd64.deb",
  ]);
  for (const file of offered) {
    assert.ok(built.has(file), `the page offers ${file}, which nothing builds`);
  }
});

test("the address baked into every download is one that could work", () => {
  // Not a check that the deployment is up — that is not a test's business —
  // but that the string shipped inside every copy is an https origin rather
  // than a typo. It cannot be corrected after the fact: an installed app has
  // no redirect to follow, so a wrong address here is a re-download for
  // everybody who already has one.
  const manifest = JSON.parse(
    readFileSync(
      path.join(repoRoot, "apps", "desktop", "package.json"),
      "utf8",
    ),
  ) as { kumi?: { defaultServer?: unknown } };
  const address = manifest.kumi?.defaultServer;
  assert.equal(typeof address, "string");
  if (address === "") {
    // Empty is a legitimate build: it asks on first run instead.
    return;
  }
  const url = new URL(address as string);
  assert.equal(url.protocol, "https:", "a shipped address must not be plain http");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.ok(!(address as string).endsWith("/"), "a trailing slash doubles up in every request path");
});
