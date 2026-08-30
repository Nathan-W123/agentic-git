Kumi as a desktop app: the machine that runs your agents.

This is the release where that changes. Earlier builds were a window onto your
deployment; this one carries the worker too, so agents execute here, on the
Claude and Codex logins already signed in on this machine. Your code and your
vendor session stay on it — the deployment only ever learns which files an
agent asked to hold.

Nothing to switch on. Install it, sign in, and it starts. The menu bar says
whether it is running, and names the reason if it is not — an agent CLI that
is not installed or not signed in here is the usual one.

The dashboard still lives on your server, so improvements to Kumi itself reach
you the moment they are deployed; you only need a new download when the app
around it changes.

## What it does not do

It cannot work while the machine is asleep. Windows stops desktop applications
for the whole of modern standby and no application can override a closed lid,
so a task submitted while this machine is shut waits for it rather than running
somewhere else. **Agents** › **Don't Sleep While Idle** keeps a plugged-in
machine from dropping off on its own, which covers being away from the desk
but not the lid.

On battery it does not take work at all. A laptop that claims a task and then
loses its network holds that task until the lease expires, and waiting visibly
is the better failure.

## Which file

| Your machine | The one with this in its name |
| --- | --- |
| Mac, Apple silicon (M1 and later) | `mac-arm64` — `.dmg` |
| Mac, Intel | `mac-x64` — `.dmg` |
| Windows | `win-x64` — `.exe` |
| Linux | `linux` — `.AppImage`, or `.deb` on Debian and Ubuntu |

Your own Kumi picks the right one for you: open **/download** on your
deployment — the same address you sign in at — and it offers the file that
matches the machine you are reading it on.

The `.zip` files are the same Mac app without the disk image, for anyone who
prefers to unpack it themselves.

## First launch

These builds are not signed, which means every operating system will say so
once. Nothing here is a bug, and none of it repeats after the first launch.

**macOS.** Open it, let the warning appear, then go to **System Settings →
Privacy & Security** and choose **Open Anyway** next to Kumi. From a terminal,
`xattr -dr com.apple.quarantine /Applications/Kumi.app` does the same thing.

**Windows.** SmartScreen shows *Windows protected your PC*. Choose **More
info**, then **Run anyway**. It installs for you alone and never asks for an
administrator.

**Linux.** `chmod +x` the AppImage and run it, or install the `.deb` with
`sudo apt install ./<file>.deb`.

## Signing in

Kumi already knows which deployment it belongs to, so there is nothing to
configure. It opens your browser, you approve the app while signed in as
yourself, and the window loads. Nothing is copied or pasted, and no token is
ever shown.

The app can do what you do in a working day — read the room, start and answer
work, manage channels, and push to or sync from GitHub. It cannot add or
remove people, or change what they may do. Revoke it any time in **Settings → Advanced →
App tokens**.

If you ever need to start over, **Help → Sign Out and Restart** or **Help →
Change Server…**.

## Updates

There are none that install themselves. An unsigned app is not allowed to
replace its own binary, and pretending otherwise would only fail quietly.
**Help → Check for Updates…** opens this page; download the new file and
install over the old one.
