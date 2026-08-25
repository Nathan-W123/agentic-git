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
KUMI_SERVER=https://your-kumi npm run desktop
```

The server address is remembered after the first launch.

## Signing in

On first launch the app opens your browser at `/authorize` on that deployment.
You approve it there — signed in as yourself, reading what is being approved —
and the app receives the result on a listener bound to `127.0.0.1`.

Nothing is copied or pasted. The redirect carries a single-use code rather than
the token, so no credential lands in browser history; the app exchanges that
code over a POST. The token is sealed with `safeStorage`, which uses OS-backed
keys, so the settings file is unreadable on any other machine.

Revoke it any time in **Settings → Advanced → App tokens**.

## What the app may do

`view` and `run_task` — read the room and start work. Deliberately not
everything its owner can do, since the token lives on a laptop rather than in a
session that expires.
