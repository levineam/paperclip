import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const STORAGE_TRANSACTION_LOCK_SCHEMA = "paperclip.storage-transaction-lock/v1" as const;
export const STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX = ".paperclip-stx-" as const;

const OWNER_NAME = `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}owner`;
const RECOVERY_NAME = `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}recovery`;
const MARKER_NAME = `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}marker`;
const MAX_RECORD_BYTES = 64 * 1024;

export type StorageTransactionOperationKind = "database-backup" | string;

export type StorageTransactionIdentity = {
  machineId: string;
  bootId: string;
  pid: number;
  processStartId: string;
};

export type StorageTransactionLockRecord = StorageTransactionIdentity & {
  schema: typeof STORAGE_TRANSACTION_LOCK_SCHEMA;
  token: string;
  operationKind: StorageTransactionOperationKind;
  acquiredAt: string;
};

export type StorageTransactionParticipationMarker = {
  schema: typeof STORAGE_TRANSACTION_LOCK_SCHEMA;
  state: "active" | "ready";
  token: string;
  updatedAt: string;
};

export type StorageTransactionLiveness =
  | { status: "alive" }
  | { status: "dead" }
  | { status: "foreign_machine" }
  | { status: "eperm" }
  | { status: "unreadable" };

export type StorageTransactionLockDeps = {
  resolveIdentity?: () => StorageTransactionIdentity;
  createToken?: () => string;
  checkLiveness?: (
    record: StorageTransactionLockRecord,
    current: StorageTransactionIdentity,
  ) => StorageTransactionLiveness;
  now?: () => Date;
};

export type AcquireStorageTransactionLockOptions = {
  sourceRoot: string;
  operationKind?: StorageTransactionOperationKind;
  maintainParticipationMarker?: boolean;
  deps?: StorageTransactionLockDeps;
};

export type StorageTransactionLockHandle = {
  readonly sourceRoot: string;
  readonly record: StorageTransactionLockRecord;
  readonly token: string;
  assertOwned(): StorageTransactionLockRecord;
  markParticipationReady(): void;
  release(): void;
};

export class StorageTransactionBusyError extends Error {
  readonly code = "STORAGE_TRANSACTION_BUSY" as const;

  constructor(message = "Storage transaction lock is busy") {
    super(message);
    this.name = "StorageTransactionBusyError";
  }
}

export class StorageTransactionBlockedError extends Error {
  readonly code = "STORAGE_TRANSACTION_BLOCKED" as const;

  constructor(
    readonly reason:
      | "atomicity_unavailable"
      | "eperm"
      | "foreign_machine"
      | "malformed"
      | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "StorageTransactionBlockedError";
  }
}

export class StorageTransactionProtocolFaultError extends Error {
  readonly code = "STORAGE_TRANSACTION_PROTOCOL_FAULT" as const;

  constructor(message: string) {
    super(message);
    this.name = "StorageTransactionProtocolFaultError";
  }
}

type LockPaths = {
  root: string;
  owner: string;
  recovery: string;
  marker: string;
};

type RequiredDeps = {
  resolveIdentity: () => StorageTransactionIdentity;
  createToken: () => string;
  checkLiveness: (
    record: StorageTransactionLockRecord,
    current: StorageTransactionIdentity,
  ) => StorageTransactionLiveness;
  now: () => Date;
};

export function isStorageTransactionReservedArtifact(name: string): boolean {
  return name.startsWith(STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === code,
  );
}

function canonicalPaths(sourceRoot: string): LockPaths {
  mkdirSync(sourceRoot, { recursive: true });
  return pathsForRoot(realpathSync(sourceRoot));
}

function pathsForRoot(root: string): LockPaths {
  return {
    root,
    owner: join(root, OWNER_NAME),
    recovery: join(root, RECOVERY_NAME),
    marker: join(root, MARKER_NAME),
  };
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function readRegularFile(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES")) {
      throw new StorageTransactionBlockedError("eperm", `Cannot inspect storage transaction artifact: ${path}`);
    }
    throw new StorageTransactionBlockedError("unreadable", `Cannot inspect storage transaction artifact: ${path}`);
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    throw new StorageTransactionBlockedError("malformed", `Storage transaction artifact is not a bounded regular file: ${path}`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES")) {
      throw new StorageTransactionBlockedError("eperm", `Cannot read storage transaction artifact: ${path}`);
    }
    throw new StorageTransactionBlockedError("unreadable", `Cannot read storage transaction artifact: ${path}`);
  }
}

function parseRecord(raw: string, path: string): StorageTransactionLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StorageTransactionBlockedError("malformed", `Storage transaction record is invalid JSON: ${path}`);
  }
  if (!value || typeof value !== "object") {
    throw new StorageTransactionBlockedError("malformed", `Storage transaction record is malformed: ${path}`);
  }
  const record = value as Record<string, unknown>;
  const valid = record.schema === STORAGE_TRANSACTION_LOCK_SCHEMA
    && typeof record.machineId === "string" && record.machineId.length > 0
    && typeof record.bootId === "string" && record.bootId.length > 0
    && typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.processStartId === "string" && record.processStartId.length > 0
    && typeof record.token === "string" && record.token.length > 0
    && typeof record.operationKind === "string" && record.operationKind.length > 0
    && typeof record.acquiredAt === "string" && Number.isFinite(Date.parse(record.acquiredAt));
  if (!valid) {
    throw new StorageTransactionBlockedError("malformed", `Storage transaction record is malformed: ${path}`);
  }
  return record as StorageTransactionLockRecord;
}

function readRecord(path: string): StorageTransactionLockRecord | null {
  const raw = readRegularFile(path);
  return raw == null ? null : parseRecord(raw, path);
}

function writeTempRecord(root: string, role: "owner" | "recovery", record: StorageTransactionLockRecord): string {
  const path = join(root, `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}${role}.tmp.${record.token}.${randomUUID()}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}

function publishHardLink(temp: string, canonical: string): void {
  try {
    linkSync(temp, canonical);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw error;
    if (
      isErrno(error, "EXDEV")
      || isErrno(error, "EPERM")
      || isErrno(error, "ENOTSUP")
      || isErrno(error, "EOPNOTSUPP")
    ) {
      throw new StorageTransactionBlockedError(
        "atomicity_unavailable",
        "This filesystem cannot publish the storage transaction lock atomically",
      );
    }
    throw error;
  }

  const sourceStat = lstatSync(temp);
  const canonicalStat = lstatSync(canonical);
  if (
    !sourceStat.isFile()
    || !canonicalStat.isFile()
    || sourceStat.dev !== canonicalStat.dev
    || sourceStat.ino !== canonicalStat.ino
  ) {
    throw new StorageTransactionProtocolFaultError("Published lock is not the expected hard-linked record");
  }
}

function machineId(): string | null {
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next platform source.
    }
  }
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function bootId(): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

function processStartId(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen < 0) return null;
      return raw.slice(closeParen + 2).trim().split(/\s+/)[19] || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveStorageTransactionIdentity(): StorageTransactionIdentity {
  const resolvedMachineId = machineId();
  const resolvedBootId = bootId();
  const resolvedProcessStartId = processStartId(process.pid);
  if (!resolvedMachineId || !resolvedBootId || !resolvedProcessStartId) {
    throw new StorageTransactionBlockedError(
      "unreadable",
      "Cannot establish stable machine, boot, and process-start identity",
    );
  }
  return {
    machineId: resolvedMachineId,
    bootId: resolvedBootId,
    pid: process.pid,
    processStartId: resolvedProcessStartId,
  };
}

export function checkStorageTransactionLiveness(
  record: StorageTransactionLockRecord,
  current: StorageTransactionIdentity,
): StorageTransactionLiveness {
  if (record.machineId !== current.machineId) return { status: "foreign_machine" };
  if (record.bootId !== current.bootId) return { status: "dead" };
  if (record.pid === current.pid) {
    return record.processStartId === current.processStartId ? { status: "alive" } : { status: "dead" };
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (isErrno(error, "ESRCH")) return { status: "dead" };
    if (isErrno(error, "EPERM")) return { status: "eperm" };
    return { status: "unreadable" };
  }
  const observedStart = processStartId(record.pid);
  if (!observedStart) return { status: "unreadable" };
  return observedStart === record.processStartId ? { status: "alive" } : { status: "dead" };
}

function classifyExisting(
  record: StorageTransactionLockRecord,
  identity: StorageTransactionIdentity,
  checkLiveness: RequiredDeps["checkLiveness"],
): "dead" {
  const liveness = checkLiveness(record, identity);
  if (liveness.status === "dead") return "dead";
  if (liveness.status === "alive") {
    throw new StorageTransactionBusyError(`Storage transaction lock is held by pid ${record.pid}`);
  }
  if (liveness.status === "foreign_machine") {
    throw new StorageTransactionBlockedError("foreign_machine", "Storage transaction lock belongs to another machine");
  }
  if (liveness.status === "eperm") {
    throw new StorageTransactionBlockedError("eperm", "Storage transaction owner liveness is permission-denied");
  }
  throw new StorageTransactionBlockedError("unreadable", "Storage transaction owner liveness is unknown");
}

function newRecord(
  identity: StorageTransactionIdentity,
  token: string,
  operationKind: string,
  now: Date,
): StorageTransactionLockRecord {
  return {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    ...identity,
    token,
    operationKind,
    acquiredAt: now.toISOString(),
  };
}

function retireRecord(path: string, root: string, role: "quarantine" | "release", expectedToken: string): string {
  const retired = join(root, `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}${role}.${expectedToken}.${randomUUID()}`);
  try {
    renameSync(path, retired);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new StorageTransactionBusyError("Storage transaction ownership changed during recovery");
    }
    throw error;
  }
  const moved = readRecord(retired);
  if (!moved || moved.token !== expectedToken) {
    throw new StorageTransactionProtocolFaultError(`Retired ${role} record token does not match the observed owner`);
  }
  return retired;
}

function acquireMutex(
  paths: LockPaths,
  identity: StorageTransactionIdentity,
  token: string,
  deps: RequiredDeps,
): { release(): void } {
  const record = newRecord(identity, token, "storage-transaction-recovery", deps.now());
  const temp = writeTempRecord(paths.root, "recovery", record);
  try {
    try {
      publishHardLink(temp, paths.recovery);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = readRecord(paths.recovery);
      if (!existing) throw new StorageTransactionBusyError("Storage transaction recovery ownership changed");
      classifyExisting(existing, identity, deps.checkLiveness);
      const reread = readRecord(paths.recovery);
      if (!reread) throw new StorageTransactionBusyError("Storage transaction recovery ownership changed");
      classifyExisting(reread, identity, deps.checkLiveness);
      const quarantined = retireRecord(paths.recovery, paths.root, "quarantine", reread.token);
      safeUnlink(quarantined);
      try {
        publishHardLink(temp, paths.recovery);
      } catch (publishError) {
        if (isErrno(publishError, "EEXIST")) {
          throw new StorageTransactionBusyError("Storage transaction recovery mutex is busy");
        }
        throw publishError;
      }
    }
  } finally {
    safeUnlink(temp);
  }

  return {
    release() {
      const existing = readRecord(paths.recovery);
      if (!existing || existing.token !== token) return;
      const retired = retireRecord(paths.recovery, paths.root, "release", token);
      safeUnlink(retired);
    },
  };
}

function writeMarker(paths: LockPaths, marker: StorageTransactionParticipationMarker): void {
  const temp = join(paths.root, `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}marker.tmp.${marker.token}.${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(marker)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, paths.marker);
  } catch (error) {
    safeUnlink(temp);
    throw error;
  }
}

export function readStorageTransactionParticipationMarker(
  sourceRoot: string,
): StorageTransactionParticipationMarker | null {
  let paths: LockPaths;
  try {
    paths = pathsForRoot(realpathSync(sourceRoot));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  const raw = readRegularFile(paths.marker);
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const marker = value as Record<string, unknown>;
  if (
    marker.schema !== STORAGE_TRANSACTION_LOCK_SCHEMA
    || (marker.state !== "active" && marker.state !== "ready")
    || typeof marker.token !== "string" || marker.token.length === 0
    || typeof marker.updatedAt !== "string" || !Number.isFinite(Date.parse(marker.updatedAt))
  ) return null;
  return marker as StorageTransactionParticipationMarker;
}

function publishOwner(
  paths: LockPaths,
  record: StorageTransactionLockRecord,
  maintainMarker: boolean,
  deps: RequiredDeps,
): StorageTransactionLockHandle {
  const temp = writeTempRecord(paths.root, "owner", record);
  try {
    publishHardLink(temp, paths.owner);
  } finally {
    safeUnlink(temp);
  }

  const createHandle = (): StorageTransactionLockHandle => {
    let released = false;
    return {
      sourceRoot: paths.root,
      record,
      token: record.token,
      assertOwned() {
        if (released) throw new StorageTransactionProtocolFaultError("Storage transaction handle is released");
        const current = readRecord(paths.owner);
        if (!current || current.token !== record.token) {
          throw new StorageTransactionProtocolFaultError("Storage transaction ownership no longer matches this handle");
        }
        return current;
      },
      markParticipationReady() {
        if (!maintainMarker) return;
        this.assertOwned();
        writeMarker(paths, {
          schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
          state: "ready",
          token: record.token,
          updatedAt: deps.now().toISOString(),
        });
      },
      release() {
        if (released) return;
        const releaseToken = randomUUID();
        const recovery = acquireMutex(paths, deps.resolveIdentity(), releaseToken, deps);
        try {
          const current = readRecord(paths.owner);
          if (current && current.token === record.token) {
            const retired = retireRecord(paths.owner, paths.root, "release", record.token);
            safeUnlink(retired);
          }
          released = true;
        } finally {
          recovery.release();
        }
      },
    };
  };

  const handle = createHandle();
  if (maintainMarker) {
    try {
      writeMarker(paths, {
        schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
        state: "active",
        token: record.token,
        updatedAt: deps.now().toISOString(),
      });
    } catch (error) {
      handle.release();
      throw error;
    }
  }
  return handle;
}

function defaultDeps(overrides?: StorageTransactionLockDeps): RequiredDeps {
  return {
    resolveIdentity: overrides?.resolveIdentity ?? resolveStorageTransactionIdentity,
    createToken: overrides?.createToken ?? randomUUID,
    checkLiveness: overrides?.checkLiveness ?? checkStorageTransactionLiveness,
    now: overrides?.now ?? (() => new Date()),
  };
}

export function acquireStorageTransactionLock(
  options: AcquireStorageTransactionLockOptions,
): StorageTransactionLockHandle {
  const paths = canonicalPaths(options.sourceRoot);
  const deps = defaultDeps(options.deps);
  const identity = deps.resolveIdentity();
  const token = deps.createToken();
  const record = newRecord(identity, token, options.operationKind ?? "database-backup", deps.now());
  const maintainMarker = options.maintainParticipationMarker ?? true;

  try {
    return publishOwner(paths, record, maintainMarker, deps);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const existing = readRecord(paths.owner);
  if (!existing) throw new StorageTransactionBusyError("Storage transaction ownership changed; retry from fresh state");
  classifyExisting(existing, identity, deps.checkLiveness);

  const recovery = acquireMutex(paths, identity, token, deps);
  try {
    const reread = readRecord(paths.owner);
    if (reread) {
      classifyExisting(reread, identity, deps.checkLiveness);
      const quarantined = retireRecord(paths.owner, paths.root, "quarantine", reread.token);
      safeUnlink(quarantined);
    }
    try {
      return publishOwner(paths, record, maintainMarker, deps);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new StorageTransactionBusyError("Storage transaction lock was acquired by another owner");
      }
      throw error;
    }
  } finally {
    recovery.release();
  }
}
