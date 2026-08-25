Kumi as a desktop app: a window onto your own deployment, signed in through
your browser.

The dashboard still lives on your server. This is the window that loads it, so
updates to Kumi itself reach you the moment they are deployed — you only need a
new download when the window changes, which is rare.

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

The app is granted `view` and `run_task` — enough to read the room and start
work, deliberately not everything you can do. Revoke it any time in
**Settings → Advanced → App tokens**.

If you ever need to start over, **Help → Sign Out and Restart** or **Help →
Change Server…**.

## Updates

There are none that install themselves. An unsigned app is not allowed to
replace its own binary, and pretending otherwise would only fail quietly.
**Help → Check for Updates…** opens this page; download the new file and
install over the old one.
