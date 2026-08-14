import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const LOCK_FILE = "control-plane.lock";
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

interface LockOwner {
  instanceId: string;
  pid: number;
  startedAt: string;
  /**
   * Which machine wrote it. A pid is only meaningful on the host that issued
   * it, and this lock lives on a volume that outlives the container holding
   * it -- so a redeploy read the previous container pid and tested it in its
   * own namespace, where low pids always exist. A container is pid 1, so the
   * arriving instance found *itself* and refused to start, every time.
   */
  hostname?: string;
}

export interface ControlPlaneLock {
  path: string;
  release(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (
      typeof parsed.instanceId !== "string" ||
      parsed.instanceId.length === 0 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) < 1 ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return parsed as LockOwner;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  const owner = await readOwner(lockPath);
  // Only ask about a pid this machine could have issued. Asking otherwise is
  // not merely unreliable, it is reliably wrong: the lock outlives the
  // container that wrote it, every container starts at pid 1, and the
  // arriving instance therefore finds a live process every time and refuses
  // to start — a permanent crash loop on redeploy, cleared only by deleting
  // the file by hand.
  //
  // A lock with no hostname is the case that matters most, because it is the
  // one already sitting on the volume: it was written by the build that had
  // this bug. Assuming it came from this machine sends exactly that lock back
  // down the path that crashes, so the pid is not trusted there either.
  //
  // What a pid can still settle is the negative. A pid that is *not* running
  // means the holder is gone whatever wrote it, and the lock is safe to clear.
  // Only "the pid is alive" is ambiguous without a hostname, and that falls
  // through to age below.
  const foreignHost =
    owner === undefined || owner.hostname !== os.hostname();
  const trustPid = owner !== undefined && owner.hostname === os.hostname();
  if (owner !== undefined && trustPid && processIsRunning(owner.pid)) {
    throw new Error(
      `A coordinator control plane is already running for this project ` +
        `(PID ${owner.pid}, started ${owner.startedAt})`,
    );
  }
  if (owner !== undefined && foreignHost && processIsRunning(owner.pid)) {
    // The pid looks alive but nothing says it belongs to this machine, so it
    // proves nothing — a fresh container answers for its own pid 1. Age
    // decides instead, and a lock older than the grace window is treated as
    // abandoned. Reclaiming one that is genuinely held is a smaller failure
    // than refusing to start forever, which is what the alternative was.
    const metadata = await stat(lockPath).catch(() => undefined);
    if (
      metadata !== undefined &&
      Date.now() - metadata.mtimeMs < INCOMPLETE_LOCK_GRACE_MS
    ) {
      throw new Error(
        `A coordinator control plane on ${owner.hostname ?? "another host"} ` +
          "holds this project and is still reporting",
      );
    }
  }
  if (owner === undefined) {
    try {
      const metadata = await stat(lockPath);
      if (Date.now() - metadata.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new Error(
          "Another coordinator control plane is currently starting for this project",
        );
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
}

/**
 * Prevents two control planes from recovering or coordinating the same store.
 *
 * The file is durable so a second process fails before crash recovery can
 * mutate live run state. A dead owner's file is removed on the next start.
 */
export async function acquireControlPlaneLock(
  projectDirectory: string,
): Promise<ControlPlaneLock> {
  await mkdir(projectDirectory, { recursive: true });
  const lockPath = path.join(projectDirectory, LOCK_FILE);
  const owner: LockOwner = {
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  };
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(lockPath);
    }
  }
  if (handle === undefined) {
    throw new Error(`Could not acquire coordinator control-plane lock at ${lockPath}`);
  }

  let released = false;
  return {
    path: lockPath,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await handle?.close();
      const current = await readOwner(lockPath);
      if (current?.instanceId !== owner.instanceId) {
        return;
      }
      try {
        await unlink(lockPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}
