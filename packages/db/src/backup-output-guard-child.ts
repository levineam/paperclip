import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { isMainThread } from "node:worker_threads";
import { runDatabaseBackupCore, type BackupCoreOutputGuard } from "./backup-lib.js";
import {
  BackupOutputGuardError,
  assertGuardedPathComponent,
  normalizeExpectedVolumeUuid,
  parseDiskutilInfoPlist,
  serializeGuardError,
  splitGuardedAbsoluteDir,
  validateGuardedFilenamePrefix,
  type GuardedBackupChildRequest,
  type GuardedBackupChildResult,
} from "./backup-output-guard.js";

/** Verified identity of a mounted volume's root directory. */
export type GuardedVolume = {
  mountPoint: string;
  dev: bigint;
  ino: bigint;
};

/** OS boundary: map an expected volume UUID to its verified, currently mounted root. */
export type GuardedVolumeResolver = (expectedVolumeUuid: string) => GuardedVolume;

type Identity = { dev: bigint; ino: bigint };

const DISKUTIL_PATH = "/usr/sbin/diskutil";
const DISKUTIL_TIMEOUT_MS = 10_000;

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}

function lstatOrNull(target: string): BigIntStats | null {
  try {
    return lstatSync(target, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
    throw new BackupOutputGuardError("unverifiable", `Cannot inspect guarded backup path: ${(error as Error).message}`);
  }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Real macOS resolver: bounded diskutil lookup plus device-node and mount-root checks. */
export function resolveMacosVolume(expectedVolumeUuid: string): GuardedVolume {
  if (process.platform !== "darwin") {
    throw new BackupOutputGuardError("unsupported", "Guarded backups are only supported on macOS");
  }
  const uuid = normalizeExpectedVolumeUuid(expectedVolumeUuid);
  let xml: string;
  try {
    xml = execFileSync(DISKUTIL_PATH, ["info", "-plist", uuid], {
      encoding: "utf8",
      timeout: DISKUTIL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  } catch {
    throw new BackupOutputGuardError("volume_absent", "Expected backup volume was not found by diskutil", { uuid });
  }
  const info = parseDiskutilInfoPlist(xml);
  if (info.volumeUuid !== uuid) {
    throw new BackupOutputGuardError("wrong_volume", "diskutil resolved a different volume UUID", { uuid });
  }
  let deviceRdev: bigint;
  try {
    const device = statSync(`/dev/${info.deviceIdentifier}`, { bigint: true });
    if (!device.isBlockDevice()) throw new Error("not a block device");
    deviceRdev = device.rdev;
  } catch {
    throw new BackupOutputGuardError("unverifiable", "Cannot verify the expected volume device node", { uuid });
  }
  const root = lstatOrNull(info.mountPoint);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) {
    throw new BackupOutputGuardError("volume_absent", "Expected backup volume mount point is not a directory", { uuid });
  }
  if (root.dev !== deviceRdev) {
    throw new BackupOutputGuardError("wrong_volume", "Mount point is not backed by the expected volume device", { uuid });
  }
  const parent = statSync(dirname(info.mountPoint), { bigint: true });
  if (parent.dev === root.dev) {
    throw new BackupOutputGuardError("unverifiable", "Expected volume mount point is not a mount root", { uuid });
  }
  return { mountPoint: info.mountPoint, dev: root.dev, ino: root.ino };
}

function cwdIdentity(): BigIntStats {
  try {
    return statSync(".", { bigint: true });
  } catch (error) {
    throw new BackupOutputGuardError("volume_changed", `Pinned backup directory is no longer accessible: ${(error as Error).message}`);
  }
}

function expectCwd(expected: Identity, volumeDev: bigint, stage: string): void {
  const current = cwdIdentity();
  if (!current.isDirectory() || current.dev !== volumeDev || !sameIdentity(current, expected)) {
    throw new BackupOutputGuardError("replaced", `Pinned backup directory identity changed (${stage})`, { stage });
  }
}

/**
 * Pin this process's kernel CWD to `backupDir` on the verified volume, creating
 * missing components one at a time from inside already-pinned directories.
 * Only the isolated guard child may call this: it changes process-wide CWD.
 */
export function pinGuardedOutputDirectory(
  request: Pick<GuardedBackupChildRequest, "backupDir" | "expectedVolumeUuid">,
  resolveVolume: GuardedVolumeResolver,
): BackupCoreOutputGuard {
  if (!isMainThread || typeof process.send !== "function") {
    throw new BackupOutputGuardError("protocol_fault", "Guarded output pinning only runs in the isolated backup child");
  }
  const uuid = normalizeExpectedVolumeUuid(request.expectedVolumeUuid);
  const dirComponents = splitGuardedAbsoluteDir(request.backupDir, "backupDir");
  const volume = resolveVolume(uuid);
  const mountComponents = splitGuardedAbsoluteDir(volume.mountPoint, "volume mount point");
  if (
    dirComponents.length < mountComponents.length
    || mountComponents.some((component, index) => dirComponents[index] !== component)
  ) {
    throw new BackupOutputGuardError("wrong_volume", "Backup directory is not inside the expected volume");
  }
  const relativeComponents = dirComponents.slice(mountComponents.length);

  const rootStat = lstatOrNull(volume.mountPoint);
  const volumeRoot: Identity = { dev: volume.dev, ino: volume.ino };
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory() || !sameIdentity(rootStat, volumeRoot)) {
    throw new BackupOutputGuardError("volume_changed", "Expected volume root changed before pinning");
  }
  // Re-resolve the UUID binding after every chdir, before any effect from that pinned
  // directory: the resolver must still map the UUID to the captured root and the CWD
  // must still be the directory we pinned. Guards the window between the initial
  // resolve and chdir (mount replacement, recycled device numbers, lost verification).
  const renewBinding = (pinnedDir: Identity, stage: string) => {
    let again: GuardedVolume;
    try {
      again = resolveVolume(uuid);
    } catch (error) {
      if (error instanceof BackupOutputGuardError) throw error;
      throw new BackupOutputGuardError("unverifiable", `Cannot re-verify the expected volume (${stage})`, { stage });
    }
    if (again.mountPoint !== volume.mountPoint || again.dev !== volume.dev || again.ino !== volume.ino) {
      throw new BackupOutputGuardError("volume_changed", `Expected volume identity changed (${stage})`, { stage });
    }
    expectCwd(pinnedDir, volume.dev, stage);
  };

  process.chdir(volume.mountPoint);
  expectCwd(volumeRoot, volume.dev, "volume-root");
  renewBinding(volumeRoot, "volume-root");

  const chain: Identity[] = [volumeRoot];
  for (const component of relativeComponents) {
    assertGuardedPathComponent(component, "backupDir");
    let stat = lstatOrNull(component);
    if (!stat) {
      try {
        // Confidential default for directories the guard creates.
        mkdirSync(component, { mode: 0o700 });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      stat = lstatOrNull(component);
    }
    if (!stat) {
      throw new BackupOutputGuardError("replaced", "Guarded backup directory component disappeared", { component });
    }
    if (stat.isSymbolicLink()) {
      throw new BackupOutputGuardError("symlink_escape", "Guarded backup directory component is a symlink", { component });
    }
    if (!stat.isDirectory()) {
      throw new BackupOutputGuardError("invalid_path", "Guarded backup directory component is not a directory", { component });
    }
    if (stat.dev !== volume.dev) {
      throw new BackupOutputGuardError("wrong_volume", "Guarded backup directory crosses onto another device", { component });
    }
    const identity: Identity = { dev: stat.dev, ino: stat.ino };
    process.chdir(component);
    // The CWD is now held by the kernel; refuse to continue unless it is the inode we inspected.
    expectCwd(identity, volume.dev, `component:${component}`);
    renewBinding(identity, `component:${component}`);
    chain.push(identity);
  }
  const pinned = chain[chain.length - 1]!;

  const verifyCheap = (stage: string) => {
    expectCwd(pinned, volume.dev, stage);
    // Read-only path checks detect rename/replacement; effects never use these absolute names.
    const atPath = lstatOrNull(request.backupDir);
    if (!atPath || atPath.isSymbolicLink() || !sameIdentity(atPath, pinned)) {
      throw new BackupOutputGuardError("replaced", `Guarded backup directory path no longer names the pinned directory (${stage})`, { stage });
    }
    const rootNow = lstatOrNull(volume.mountPoint);
    if (!rootNow || rootNow.isSymbolicLink() || !sameIdentity(rootNow, volumeRoot)) {
      throw new BackupOutputGuardError("volume_changed", `Expected volume is no longer mounted at its mount point (${stage})`, { stage });
    }
  };

  const verify = (stage: string) => {
    verifyCheap(stage);
    const again = resolveVolume(uuid);
    if (again.mountPoint !== volume.mountPoint || again.dev !== volume.dev || again.ino !== volume.ino) {
      throw new BackupOutputGuardError("volume_changed", `Expected volume identity changed (${stage})`, { stage });
    }
    let current = volume.mountPoint;
    relativeComponents.forEach((component, index) => {
      current = `${current}/${component}`;
      const stat = lstatOrNull(current);
      if (!stat || stat.isSymbolicLink() || !sameIdentity(stat, chain[index + 1]!)) {
        throw new BackupOutputGuardError("replaced", `Guarded backup directory component changed (${stage})`, { stage, component });
      }
    });
  };

  return { verify, verifyCheap };
}

export async function runGuardedBackupChild(
  request: GuardedBackupChildRequest,
  resolveVolume: GuardedVolumeResolver,
): Promise<GuardedBackupChildResult> {
  if (!request || typeof request !== "object") {
    throw new BackupOutputGuardError("protocol_fault", "Guarded backup child received no request");
  }
  validateGuardedFilenamePrefix(request.filenamePrefix);
  const guard = pinGuardedOutputDirectory(request, resolveVolume);
  const result = await runDatabaseBackupCore(
    {
      connectionString: request.connectionString,
      backupDir: ".",
      retention: request.retention,
      filenamePrefix: request.filenamePrefix,
      connectTimeoutSeconds: request.connectTimeoutSeconds,
      excludeTables: request.excludeTables,
      nullifyColumns: request.nullifyColumns,
      backupEngine: request.backupEngine,
    },
    guard,
  );
  if (basename(result.backupFile) !== result.backupFile) {
    throw new BackupOutputGuardError("protocol_fault", "Guarded backup produced a non-relative artifact name");
  }
  return {
    backupFileName: result.backupFile,
    sizeBytes: result.sizeBytes,
    prunedCount: result.prunedCount,
    ...(result.lockTokenPrefix ? { lockTokenPrefix: result.lockTokenPrefix } : {}),
  };
}

function replyAndExit(message: Record<string, unknown>, exitCode: number): void {
  process.exitCode = exitCode;
  const finish = () => {
    if (process.connected) process.disconnect();
    // Teardown already settled; do not let a stray handle keep the child alive.
    setTimeout(() => process.exit(exitCode), 5_000).unref();
  };
  if (process.connected && typeof process.send === "function") {
    process.send(message, () => finish());
  } else {
    finish();
  }
}

/**
 * IPC loop for the guard child: accepts exactly one run request. If the parent
 * disconnects mid-run, the run still completes its own cleanup and lock release
 * before the child exits.
 */
export function serveGuardedBackupChild(resolveVolume: GuardedVolumeResolver): void {
  if (typeof process.send !== "function") {
    throw new Error("The guarded backup child must be started with an IPC channel");
  }
  let started = false;
  process.on("message", (message: unknown) => {
    if (started) return;
    started = true;
    const request = message && typeof message === "object"
      ? (message as { type?: unknown; request?: unknown })
      : null;
    const run = request?.type === "run"
      ? runGuardedBackupChild(request.request as GuardedBackupChildRequest, resolveVolume)
      : Promise.reject(new BackupOutputGuardError("protocol_fault", "Unexpected guarded backup child message"));
    run.then(
      (result) => replyAndExit({ type: "result", result }, 0),
      (error) => replyAndExit({ type: "error", error: serializeGuardError(error) }, 1),
    );
  });
}
