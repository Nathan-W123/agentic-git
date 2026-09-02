### 0.5.13 — say which agents this machine is actually running

The Agents menu said "Running agents on this machine" whether it had found
both your CLIs or one of them, and the worker log never mentioned the
subject at all. That mattered more than it sounds. The list of CLIs this
machine reports is exactly what the control plane uses to decide whether an
agent is reachable — so a machine that found only one of two would take
work for that one and, for the other, tell the room "no machine is running
Kumi" and offer to install a CLI already sitting on the disk. Nothing
failed, and the only two places that could have said so said nothing.

The menu now names them. The worker log names them on every start, and if
the list is empty — which is a worker that will never be given a single
task, however healthy it looks — it says so outright, with both halves of
the comparison printed so you can see which one is short.

Also: Claude installed natively is now Claude the app can see.

An agent whose CLI this app cannot find is an agent the control plane
draws as having no machine at all. It goes grey, a mention brings up
"nothing will pick this up yet", and the app offers to install a CLI that
is already on the computer.

That is what happened to Claude on Windows. The app looks along PATH and
then in the standard install directories, and the Windows list named
Node's own folder and npm's global folder but not the one a *native*
installer uses — `%USERPROFILE%\.local\bin`, where Claude Code now puts
`claude.exe`. Every other platform's list had it. Windows now does too.

### 0.5.12 — your project's tools, on your say-so

A project can now give its agents MCP servers — a Linear server, a Sentry
server, a GitHub server — from Settings → Project controls. Approving one
there is a recorded decision about the project's agents. It is not a decision
about your computer, and this app treats the two differently.

The first time a task arrives carrying a server your computer has not agreed
to, the agent runs without it and this app asks you: here is what would start
here, or what would be talked to, under your account. Say yes and the next
task runs with it; say not now and nothing changes. What you agree to is that
exact server — if the project later changes what `github` runs, you are asked
again, and told that it moved rather than that something new appeared. Agents
→ Forget Allowed MCP Servers takes every yes back.

Nothing about this runs on the server. The control plane keeps the server's
definition and its sealed secrets, and hands them only to the machine of the
person who submitted the task; the program itself starts on that machine, as
the agent always has.

Also in this build: a message that opens with "can you" and does not end in a
question mark is treated as an instruction, not a question, so it gets a
thread and starts at once instead of being answered in the channel minutes
later. Questions your machine answers now show in the worker log, answered or
failed, so a quiet channel is no longer a mystery.

Two things to know. Codex can be handed a bearer token and nothing else, so an
http server that needs some other header runs only under Claude. And this app
now speaks worker protocol 4: it still works against a control plane on 3, it
just runs without tools until that control plane is updated — the thread says
so when it happens.

### 0.5.11 — your machine runs four agents, not one

Send three requests and one of them ran. The other two sat in the queue until
you stopped the first by hand, which reads as a coordinator that has stopped
rather than as a machine that is full.

It was neither. A run on the server takes as many tasks as a repository allows
and works them together; this app took one, waited for it, and only then looked
for the next. Moving the agents onto your own machine — which is what keeps
your work and your logins on it — quietly took that back down to one task at a
time, and nothing said so.

Your machine now holds as many as it has memory for, and never fewer than four.
There is nothing to turn on. `COORD_WORKER_CONCURRENCY` sets a different
number if you want one; `1` is what this app did before.

### 0.5.0 — one sign-in

Connecting an agent used to sign you into the vendor twice. Once to give this
deployment a credential, and once more to the CLI on your own machine — and on
a deployment that runs agents locally, only the second one ever mattered. The
first stored a secret the worker never reads, because the CLI runs under your
machine's own login.

It was also, accidentally, what made an agent exist: the roster was built by
walking the credential store. That is why a failing agent was told to
"reconnect from Settings → Agents", a remedy that could not possibly have
helped a CLI that was not signed in.

An agent is now a record of its own. Connecting creates it, then finishes on
your machine — installing the CLI if it is missing, and opening its sign-in.
One sign-in, the one that decides whether anything works.

The vendor sign-in is still there, as what it actually buys: your remaining
usage on the agent card, and server-side execution for a deployment that wants
it. It is a "Link for usage" button on an agent you already have, rather than a
gate you pass before finding out whether your CLI is installed.

Deployments that run agents on the server are unchanged.

### 0.4.9 — connecting an agent finishes the job

Connecting an agent used to do half of what its name promised. It signed you
into the vendor, which gives Kumi an agent — and stopped, without ever
mentioning that the CLI that agent actually runs as was not on your machine.
You found out later, when you @mentioned it and nothing happened.

Connecting now checks this machine as its last step. If the CLI is missing it
offers to install it, shows exactly what it will run, runs it, and opens a
terminal for the sign-in. If it is already here it offers to check that
sign-in, because nothing can tell from outside whether a CLI is logged in.

Either way you finish where you started, with an agent that works.

### 0.4.8 — Cursor runs, the repository stays, and setup explains itself

**Cursor works.** It ships no CLI binary at all: `agent.cmd` runs PowerShell,
which runs a script, which picks the newest version directory and runs that
copy's own `node.exe`. Two shims and an interpreter — and the first is a batch
file, which on Windows cannot carry an argument containing a quote or a
newline. Cursor sends its whole prompt that way, so every task failed. The
adapter now skips the shims and calls the interpreter directly.

**The repository is kept between tasks.** Every task used to pull the whole
repository from the deployment — 41 MB for a modest one — unpack it, and delete
it when the task ended, so the next mention paid for all of it again. That is
the entire reason a local agent felt slower than a server one: the server reads
a clone off its own disk. Now so does your machine. The first task on a machine
still transfers everything; every task after it transfers a few commits.

**An agent that cannot run says what to install.** Kumi runs agents using the
vendor's own CLI on your machine, and nothing in the product said so — an agent
with no CLI looked exactly like one that worked, took the mention, and left the
task waiting forever. When an agent goes grey it now shows the install command
for its vendor, and in the app there is a button that runs it for you, after
showing you exactly what will run. When it finishes, another opens a terminal
already running the CLI so its sign-in starts.

Only commands published by each vendor are offered. The app decides what a
vendor name means; the page can only ask by name, so a command never travels
from a web page to your shell.

### 0.4.7 — Codex runs, Cursor is called what Cursor calls it

**Codex could not start, and said so precisely.** It resolved to `codex.cmd`,
the npm shim, which has to run through `cmd.exe` — and Codex's own arguments
contain a quote that cannot safely go on a `cmd.exe` command line. The native
lookup added in 0.4.6 checked a fixed list of paths and a real install was not
on it: npm nests the platform package inside `@openai/codex` rather than beside
it. The directory is read now instead of guessed, so however npm arranges it,
the native `codex.exe` is found.

**Cursor's CLI is `agent`, not `cursor-agent`.** 0.4.5 renamed it on the
strength of a "spawn agent ENOENT", reading that as the adapter naming a
binary nobody ships. It was the opposite: the name was right and the CLI
simply was not installed. Renaming it broke Cursor on every machine that had
it. Reverted, and both spellings are now accepted when detecting.

**A run says what it is doing while it plans.** Progress forwarding landed in
0.4.6, but the listener was attached after a plan was admitted — so the ten
minutes an agent spends reading the repository, which is exactly when somebody
is watching, still reported nothing. It listens from the moment the session
opens now.

**An agent whose CLI is not installed no longer accepts work.** Availability
was answered per person: once any machine of yours was listening, every agent
you owned looked available — including ones for CLIs that were never
installed. They took mentions and left the task in a queue nothing would ever
claim, behind a message saying work had begun. Availability is per agent now.

**And quitting no longer leaves agents running.** The app killed the worker but
not the worker's children, and on Windows nothing inherits a kill. Every quit
and every restart orphaned a running agent, still working and still spending
its owner's quota. One machine was found with twelve of them.

### 0.4.6 — sign-in works, and a run says what it is doing

**Connecting an agent failed on Windows with "Get an app to open this 'about'
link".** The sign-in flow claims a browser tab during the click that starts it —
a tab opened after the wait would be a blocked popup — and an empty URL is
`about:blank`. The app forwarded every `window.open` straight to the operating
system, so Windows was asked to find an application for `about:` links, and the
cancelled tab meant the real sign-in page never opened either. Only `http` and
`https` reach the OS now, and when the claimed tab does not survive, the sign-in
page is opened directly once its URL is known.

**A run on your own machine now says what it is doing.** The agent's progress —
its own words, as it works — was only ever emitted by the server-side runner. A
task executing on your desktop went from "I've taken this task" to its ending
with nothing in between, for the entire time the work was happening, and read as
hung. The worker forwards it now, so the liveness comes from the machine doing
the work and costs nothing on the server.

**And a failure no longer blames your sign-in for someone else's problem.** The
test for an expired session matched a bare `401` anywhere in the text — a lease
id, a byte count, a version, a line number — and reported it as an expired
sign-in. That is a confidently wrong answer with a remedy that takes minutes and
cannot work. It is bounded now. When the sign-in really has expired and agents
run locally, the message points at the CLI on this machine rather than at a
Settings page that does not hold that credential.

### 0.4.5 — the agents actually run

0.4.4 made the CLI findable. It turned out finding it was only the first of
four things standing between a task and a vendor CLI on Windows, and the other
three were each enough on their own.

**Codex could not run through its npm shim at all.** A `.cmd` has to go through
`cmd.exe`, and Kumi refuses to put a quote on a `cmd.exe` command line rather
than attempt shell escaping — while every Windows Codex invocation carries
`-c windows.sandbox="…"`, which contains one. So a found shim would have failed
on the quoting guard instead of on ENOENT. Codex now resolves to its native
`codex.exe`, the way Claude already did, using the path Codex's own launcher
uses. No `cmd.exe`, no guard.

**Cursor was being started by the wrong name.** Its default command was
`agent` — not a program any vendor ships. That is the whole of
"spawn agent ENOENT", on machines where Cursor was installed and working. It is
`cursor-agent` now.

**The worker offered to run agents this machine does not have.** The project
config gets a default agent backfilled for every vendor it lacks, which is
right for a deployment and wrong for a laptop, so a worker registered for
Cursor and Kiro whether or not they were installed — was handed their work, and
could only fail it. The app now tells the worker what it actually found, and
registration is the intersection.

And when a batch shim genuinely is the only thing available, the refusal says
so, and says to point the agent at the native executable, instead of reporting
an unexplained quoting error.

### 0.4.4 — the CLI is found once, not twice

0.4.3 taught the launcher to resolve a bare `codex` the way a shell does, and
Windows still answered `spawn codex ENOENT`. The lookup was the wrong thing to
fix twice: the app had *already* walked `PATH` and found the file — that is how
it knew to advertise Codex at all — and then threw that answer away and asked a
child process, under a stripped environment, to find it again.

Now the path it found is what gets written down, so nothing has to be looked up
a second time. The config that records it is also reconciled on every start
rather than frozen at first run, so installing a CLI later is enough, and one
that moves or is removed no longer leaves an entry behind.

Two things that were spawning without those rules now use them: the generic CLI
adapter, which owns its own child and was the source of `spawn agent ENOENT`;
and every remaining Windows `ENOENT`, which now says how many `PATH` directories
were searched and for which suffixes — the difference between a CLI that is not
installed and one this process cannot see.

### 0.4.3 — agents can actually start on Windows

Every agent failed on Windows, and it was one missing lookup rather than three
broken vendors. A shell finds `codex` by walking `PATH` and trying each
`PATHEXT` suffix; `spawn` does neither, and every vendor CLI installed by npm
is a `.cmd` shim — so there was no file of that name to start. Detection found
the shim and said "Running agents on this machine" while every task came back
`spawn codex ENOENT`.

Failures also say why now. One of the six places that record a failed task
wrote its reason under a key the channel never read, which happened to be the
one a desktop worker uses — so every failure it reported arrived as "I could
not finish this." with nothing after it. And a streaming CLI that dies writes
its error at the end of its output while the first line is a banner naming a
temp directory; that banner was what got shown.

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
