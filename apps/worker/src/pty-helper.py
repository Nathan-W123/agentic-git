"""Allocates a real terminal for a child process, and proxies it over pipes.

Kumi's worker is Node, and Node cannot open a pseudo-terminal without a
native module. `node-pty` is that module, and it is exactly what this avoids:
the desktop app is packaged with no dependencies and therefore nothing to
rebuild, so adding a compiled `.node` binary would mean per-platform builds,
an ABI that has to match Electron's, and a new way for the installer to fail
— to gain full-screen programs in a web page.

The way around it is to let something that *can* allocate a PTY do it, and
speak to that over ordinary pipes. This is that something. It is a text file:
no compiler, no packaging change, no ABI.

What the child gets is a genuine terminal, so `isatty` is true and everything
that rests on it works — colour, line editing, tab completion, full-screen
programs, and Ctrl-C arriving as SIGINT rather than as a byte nobody reads.

Three channels, so that control never has to be escaped out of the data:

  stdin  — bytes to write into the terminal, verbatim
  stdout — bytes the terminal produced, verbatim
  fd 3   — one JSON object per line: {"resize": [cols, rows]}

Exits with the child's status, or 128+signal where it was killed.
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_window_size(fd: int, cols: int, rows: int) -> None:
    """Tells the terminal how big it is.

    Without this a full-screen program draws to 80x24 and wraps everything
    else, which looks like a rendering bug and is really a missing ioctl.
    """
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        # A terminal that will not take a size still works at its default.
        pass


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 3:
        sys.stderr.write("usage: pty-helper.py <cols> <rows> <command> [args...]\n")
        return 2
    cols, rows = int(argv[0]), int(argv[1])
    command = argv[2:]

    pid, master = pty.fork()
    if pid == 0:
        # The child. Its stdin, stdout and stderr are the terminal already;
        # `pty.fork` saw to that. All that is left is to become the shell.
        try:
            os.execvp(command[0], command)
        except OSError as error:
            # Written to what is now the terminal, so it reaches the reader
            # rather than a log nobody has open.
            sys.stderr.write(f"could not start {command[0]}: {error}\n")
            sys.stderr.flush()
            os._exit(127)

    set_window_size(master, cols, rows)

    # The control channel is optional: a caller that never resizes need not
    # open it, and a helper started by hand from a shell has no fd 3 at all.
    try:
        control = os.fdopen(3, "rb", buffering=0)
    except OSError:
        control = None

    stdin_fd = sys.stdin.fileno()
    stdout = sys.stdout.buffer
    watching = [master, stdin_fd] + ([control.fileno()] if control else [])
    pending = b""
    child_gone = False

    while True:
        try:
            readable, _, _ = select.select(watching, [], [], 0.2)
        except (OSError, ValueError):
            break

        if master in readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                # EIO on Linux is how a closed terminal reports itself, which
                # is the ordinary way a shell exiting arrives here.
                chunk = b""
            if not chunk:
                break
            stdout.write(chunk)
            stdout.flush()

        if stdin_fd in readable:
            try:
                chunk = os.read(stdin_fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                # The caller has gone. Hang up on the child rather than
                # leaving a shell holding a terminal nobody is reading.
                try:
                    os.close(master)
                except OSError:
                    pass
                break
            os.write(master, chunk)

        if control is not None and control.fileno() in readable:
            try:
                chunk = control.read(65536)
            except OSError:
                chunk = b""
            if not chunk:
                watching.remove(control.fileno())
                control = None
            else:
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        message = json.loads(line.decode("utf8"))
                    except (ValueError, UnicodeDecodeError):
                        continue
                    size = message.get("resize")
                    if isinstance(size, list) and len(size) == 2:
                        try:
                            set_window_size(master, int(size[0]), int(size[1]))
                            # The convention every terminal follows: tell the
                            # foreground program its world changed shape.
                            os.kill(pid, signal.SIGWINCH)
                        except (OSError, ValueError, TypeError):
                            pass

        if not child_gone:
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
            except OSError:
                break
            if done == pid:
                child_gone = True
                # Drain what the terminal still holds before reporting the
                # exit: a command whose last line is its output would
                # otherwise lose it to the race with its own death.
                while True:
                    try:
                        readable, _, _ = select.select([master], [], [], 0.05)
                        if master not in readable:
                            break
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    stdout.write(chunk)
                    stdout.flush()
                if os.WIFSIGNALED(status):
                    return 128 + os.WTERMSIG(status)
                return os.WEXITSTATUS(status)

    try:
        os.kill(pid, signal.SIGHUP)
        _, status = os.waitpid(pid, 0)
        if os.WIFSIGNALED(status):
            return 128 + os.WTERMSIG(status)
        return os.WEXITSTATUS(status)
    except OSError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
