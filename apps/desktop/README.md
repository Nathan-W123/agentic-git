# Kumi desktop

A window that loads your Kumi deployment, and the sign-in that gets it a token.

The dashboard itself is not bundled here. It is served by the control plane as
plain ES modules, so the app loads the deployment it was pointed at the way a
browser would — which is what keeps a UI change a one-step deploy rather than a
release. A new installer is needed only when `electron/` changes.

## Running it while developing

Electron is not a dependency of this package on purpose: the monorepo's build
is the deploy pipeline, and a workspace that needed Electron installed to
compile would put a desktop dependency between the server and production.

```
cd apps/desktop
npm i -D electron
npm run desktop
```

Where it looks for a server, in order:

1. `KUMI_SERVER` in the environment — a development override, so a real build
   can be aimed at a local gateway without disturbing the settings a real
   launch wrote
2. what the last successful launch saved
3. `kumi.defaultServer` in `package.json` — the deployment this build was made
   for
4. otherwise it asks, on a first-run window

Set `kumi.defaultServer` for a build of the hosted product: nobody installing
it should be asked to name a server there is only one answer to. Leave it empty
for a self-hosted build, which asks. **Help → Change Server…** escapes a
baked-in address; that is what the `askedToChange` flag in the settings file
is for, and without it the menu item would clear the address, relaunch, fall
straight back to the default, and look broken.

The address is baked into every copy that ships, so a deployment that later
moves leaves old installs pointing at nothing. Prefer a domain you control
over a platform-assigned hostname.

## Signing in

The app opens your browser at `/authorize` on that deployment. You approve it
there — signed in as yourself, reading what is being approved — and the app
receives the result on a listener bound to `127.0.0.1`.

Nothing is copied or pasted. The redirect carries a single-use code rather than
the token, so no credential lands in browser history; the app exchanges that
code over a POST. The token is sealed with `safeStorage`, which uses OS-backed
keys, so the settings file is unreadable on any other machine. It reaches the
page over IPC rather than on the renderer's command line, which anything that
can list processes would be able to read.

Revoke it any time in **Settings → Advanced → App tokens**.

On a Linux machine with no keyring — a headless box, a minimal desktop —
`safeStorage` has nowhere safe to put the token, so nothing is written and the
app asks for approval again next launch. That is the intended trade: a token
written in the clear would be worse than one that has to be re-issued.

## What the app may do

Everything its owner does in a working day — read the room, start and answer
work, review an agent's findings, push to and sync from GitHub — and none of
the administration. `manage_project`, `manage_members` and
`manage_organization` are deliberately absent, so a laptop that is lost or
borrowed cannot rename a project, change who is in the organization, or alter
what they may do.

This is a ceiling rather than a grant: the scope check narrows what a token
may do and never widens it, so the app can never exceed the role of whoever
approved it.

## Getting unstuck

A downloaded copy has no shell to delete a settings file from, so the two
states it cannot recover from on its own are in the menu:

- **Help → Sign Out and Restart** — for a token that was revoked, or one that
  belongs to somebody else.
- **Help → Change Server…** — for a deployment that moved, or an address typed
  wrong and saved.

## Releasing

`.github/workflows/desktop-release.yml` builds macOS, Windows, and Linux
installers and uploads them to the repository named in `package.json` under
`kumi.releasesRepo`. It runs on a tag:

```
# bump "version" in apps/desktop/package.json first — the workflow refuses a
# tag that disagrees with it
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

Running the workflow by hand builds all three and publishes nothing, which is
how to check that packaging still works without cutting a release.

Installer filenames carry no version, on purpose: that is what makes
`releases/latest/download/<file>` a permanent address, and it is what the
download page at `/download` on every deployment links to. Nothing there has
to be edited when a version ships. Before publishing, the workflow checks that
every file that page offers is one this release actually built — `${os}`
expands to `mac` and `win`, not `macos` and `windows`, and a link that spells
it the friendly way looks right and 404s.

Publishing needs a `KUMI_RELEASES_TOKEN` secret: a fine-grained personal access
token with **Contents: write** on the releases repository. The automatic
`GITHUB_TOKEN` cannot be used, because it is scoped to this repository and the
installers go to a different one.

### Unsigned, on purpose for now

No certificate is configured for either macOS or Windows, so each will warn
once on first launch — `RELEASE_NOTES.md` tells people how to get past it, and
those notes become the body of every release.

macOS is *ad-hoc* signed rather than unsigned, which is not the same thing.
Apple silicon refuses outright to launch a binary carrying no signature at all,
and no amount of clicking through System Settings changes that — so
`identity: "-"` gives the app a signature that claims nothing about who made
it. That leaves a Gatekeeper warning a person can wave through, instead of an
app that dies on double-click. `hardenedRuntime` is off for the same reason:
combined with ad-hoc signing it enforces library validation, which rejects the
frameworks Electron itself ships.

The cost of changing that is money and identity, not code: an Apple Developer
account for notarization, and a code-signing certificate for Windows. When
there is one, `identity` and `hardenedRuntime: true` go in
`electron-builder.yml` and nothing else here changes.

Automatic updates are the one thing that stays off regardless. An unsigned app
is not permitted to replace its own binary, so **Help → Check for Updates…**
opens the releases page instead of pretending to do more.
