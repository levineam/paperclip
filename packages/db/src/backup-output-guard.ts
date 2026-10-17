import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StorageTransactionLockError, STORAGE_TRANSACTION_RESERVED_PREFIX } from "./backup-transaction-lock.js";
import type { RunDatabaseBackupOptions, RunDatabaseBackupResult } from "./backup-lib.js";

/**
 * Opt-in output guard: the backup directory must live on the mounted volume
 * with this exact volume UUID for the whole run. macOS only; anything that
 * cannot be verified fails closed before any filesystem effect.
 */
export type BackupOutputGuard = {
  expectedVolumeUuid: string;
};

export class BackupOutputGuardError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BackupOutputGuardError";
    this.code = code;
    this.details = details;
  }
}

const VOLUME_UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const GUARDED_FILENAME_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHILD_STDERR_BYTES = 16 * 1024;

/** Validate a present opt-in value. Blank or malformed input is an error, never "unguarded". */
export function normalizeExpectedVolumeUuid(raw: unknown, source = "expectedVolumeUuid"): string {
  if (typeof raw !== "string" || !VOLUME_UUID_RE.test(raw.trim())) {
    throw new BackupOutputGuardError(
      "invalid_config",
      `${source} must be a volume UUID (8-4-4-4-12 hex); refusing to fall back to an unguarded backup`,
      { source },
    );
  }
  return raw.trim().toUpperCase();
}

/**
 * Resolve the opt-in from an env value and a config value (env wins when set,
 * even if blank). Returns undefined only when neither is present; an explicit
 * null/blank/non-string config value is an invalid opt-in, not "absent".
 */
export function resolveBackupOutputGuard(input: {
  env?: string | undefined;
  config?: unknown;
  envName?: string;
}): BackupOutputGuard | undefined {
  if (input.env !== undefined) {
    return { expectedVolumeUuid: normalizeExpectedVolumeUuid(input.env, input.envName ?? "env") };
  }
  if (input.config !== undefined) {
    return { expectedVolumeUuid: normalizeExpectedVolumeUuid(input.config, "database.backup.expectedVolumeUuid") };
  }
  return undefined;
}

export function assertGuardedPathComponent(name: string, label: string): void {
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")
  ) {
    throw new BackupOutputGuardError("invalid_path", `Guarded backup ${label} has an unsafe path component`, {
      component: name,
    });
  }
}

export function validateGuardedFilenamePrefix(prefix: string): void {
  if (!GUARDED_FILENAME_PREFIX_RE.test(prefix) || prefix.startsWith(STORAGE_TRANSACTION_RESERVED_PREFIX)) {
    throw new BackupOutputGuardError(
      "invalid_path",
      "Guarded backup filenamePrefix must be 1-128 characters of [A-Za-z0-9._-] starting with an alphanumeric",
    );
  }
}

/** Absolute, no "." or ".." components, no NUL. Returns the components below "/". */
export function splitGuardedAbsoluteDir(dir: string, label: string): string[] {
  if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0")) {
    throw new BackupOutputGuardError("invalid_path", `Guarded backup ${label} must be an absolute path`);
  }
  const components = dir.split("/").filter((part) => part.length > 0);
  for (const component of components) assertGuardedPathComponent(component, label);
  return components;
}

function decodeXmlText(value: string): string {
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(value)) {
    throw new BackupOutputGuardError("unverifiable", "diskutil plist contains an unsupported XML entity");
  }
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function plistString(xml: string, key: string): string | null {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g");
  const matches = [...xml.matchAll(pattern)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new BackupOutputGuardError("unverifiable", `diskutil plist has duplicate ${key}`);
  }
  return decodeXmlText(matches[0]![1]!);
}

export type DiskutilVolumeInfo = {
  volumeUuid: string;
  mountPoint: string;
  deviceIdentifier: string;
};

/** Parse the subset of `diskutil info -plist` output the guard relies on. */
export function parseDiskutilInfoPlist(xml: string): DiskutilVolumeInfo {
  if (typeof xml !== "string" || !xml.includes("<plist")) {
    throw new BackupOutputGuardError("unverifiable", "diskutil did not return a plist");
  }
  const volumeUuid = plistString(xml, "VolumeUUID");
  const mountPoint = plistString(xml, "MountPoint");
  const deviceIdentifier = plistString(xml, "DeviceIdentifier");
  if (!volumeUuid || !VOLUME_UUID_RE.test(volumeUuid)) {
    throw new BackupOutputGuardError("unverifiable", "diskutil plist has no valid VolumeUUID");
  }
  if (!mountPoint) {
    throw new BackupOutputGuardError("volume_absent", "Expected backup volume is not mounted");
  }
  splitGuardedAbsoluteDir(mountPoint, "volume mount point");
  if (mountPoint === "/") {
    throw new BackupOutputGuardError("unverifiable", "Refusing the root filesystem as a guarded backup volume");
  }
  if (!deviceIdentifier || !/^disk[0-9]+(s[0-9]+)*$/.test(deviceIdentifier)) {
    throw new BackupOutputGuardError("unverifiable", "diskutil plist has no valid DeviceIdentifier");
  }
  return { volumeUuid: volumeUuid.toUpperCase(), mountPoint, deviceIdentifier };
}

type GuardedBackupRequest = {
  connectionString: string;
  backupDir: string;
  retention: RunDatabaseBackupOptions["retention"];
  filenamePrefix: string;
  connectTimeoutSeconds?: number;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: RunDatabaseBackupOptions["backupEngine"];
  expectedVolumeUuid: string;
};

export type GuardedBackupChildRequest = GuardedBackupRequest;

export type GuardedBackupChildResult = {
  backupFileName: string;
  sizeBytes: number;
  prunedCount: number;
  lockTokenPrefix?: string;
};

export type SerializedGuardError = {
  name: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  path?: string;
  syscall?: string;
  errno?: number;
  errors?: SerializedGuardError[];
};

export function serializeGuardError(error: unknown, depth = 0): SerializedGuardError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const record = error as Error & Record<string, unknown>;
  const out: SerializedGuardError = { name: error.name, message: error.message };
  if (typeof record.code === "string") out.code = record.code;
  if (typeof record.path === "string") out.path = record.path;
  if (typeof record.syscall === "string") out.syscall = record.syscall;
  if (typeof record.errno === "number") out.errno = record.errno;
  if (record.details && typeof record.details === "object") {
    try {
      out.details = JSON.parse(JSON.stringify(record.details)) as Record<string, unknown>;
    } catch {
      // Details are diagnostic only.
    }
  }
  if (error instanceof AggregateError && depth < 4) {
    out.errors = error.errors.map((inner) => serializeGuardError(inner, depth + 1));
  }
  return out;
}

export function deserializeGuardError(value: SerializedGuardError): Error {
  let error: Error;
  if (value.name === "StorageTransactionLockError" && value.code) {
    error = new StorageTransactionLockError(value.code, value.message, value.details);
  } else if (value.name === "BackupOutputGuardError" && value.code) {
    error = new BackupOutputGuardError(value.code, value.message, value.details);
  } else if (value.name === "AggregateError") {
    error = new AggregateError((value.errors ?? []).map(deserializeGuardError), value.message);
  } else {
    error = new Error(value.message);
    error.name = value.name;
    const record = error as Error & Record<string, unknown>;
    if (value.code) record.code = value.code;
    if (value.path) record.path = value.path;
    if (value.syscall) record.syscall = value.syscall;
    if (value.errno !== undefined) record.errno = value.errno;
  }
  return error;
}

function defaultGuardChildEntry(): string {
  const self = fileURLToPath(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".js";
  return join(self, "..", `backup-output-guard-entry${ext}`);
}

function childExecArgv(entry: string): string[] {
  if (!/\.[cm]?ts$/.test(entry)) return [];
  // Dev/test source checkouts run TypeScript; resolve tsx from this package so the
  // child does not depend on the parent's loader flags or working directory.
  let loader: string;
  try {
    loader = createRequire(import.meta.url).resolve("tsx");
  } catch {
    throw new BackupOutputGuardError("child_unavailable", "Cannot resolve the TypeScript loader for the guarded backup child");
  }
  return ["--import", pathToFileURL(loader).href];
}

function prepareGuardedRequest(opts: RunDatabaseBackupOptions): GuardedBackupRequest {
  const guard = opts.outputGuard;
  if (!guard || typeof guard !== "object") {
    throw new BackupOutputGuardError("invalid_config", "outputGuard must be an object with expectedVolumeUuid");
  }
  const expectedVolumeUuid = normalizeExpectedVolumeUuid(guard.expectedVolumeUuid, "outputGuard.expectedVolumeUuid");
  splitGuardedAbsoluteDir(opts.backupDir, "backupDir");
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  validateGuardedFilenamePrefix(filenamePrefix);
  return {
    connectionString: opts.connectionString,
    backupDir: opts.backupDir,
    retention: opts.retention,
    filenamePrefix,
    connectTimeoutSeconds: opts.connectTimeoutSeconds,
    excludeTables: opts.excludeTables,
    nullifyColumns: opts.nullifyColumns,
    backupEngine: opts.backupEngine,
    expectedVolumeUuid,
  };
}

/**
 * Internal: run a guarded backup in an isolated child whose kernel CWD is pinned
 * to the verified output directory. The serving process never changes its CWD.
 * Settles only after the child exits so callers never observe a still-running
 * child after rejection.
 */
export function forkGuardedDatabaseBackup(
  opts: RunDatabaseBackupOptions,
  entry: string = defaultGuardChildEntry(),
): Promise<RunDatabaseBackupResult> {
  return new Promise<RunDatabaseBackupResult>((resolvePromise, reject) => {
    let request: GuardedBackupRequest;
    let child: ChildProcess;
    try {
      request = prepareGuardedRequest(opts);
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      child = fork(entry, [], {
        cwd: "/",
        execArgv: childExecArgv(entry),
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let outcome: { ok: true; result: GuardedBackupChildResult } | { ok: false; error: Error } | null = null;
    let stderr = "";
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-CHILD_STDERR_BYTES);
    });
    child.on("message", (message: unknown) => {
      if (outcome || !message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record.type === "result" && record.result && typeof record.result === "object") {
        outcome = { ok: true, result: record.result as GuardedBackupChildResult };
      } else if (record.type === "error" && record.error && typeof record.error === "object") {
        outcome = { ok: false, error: deserializeGuardError(record.error as SerializedGuardError) };
      }
    });
    child.once("error", (error) => {
      // Spawn/IPC failure: no exit event is guaranteed.
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) return;
      settle(() => reject(error));
    });
    // "close" (not "exit") so stdio and the IPC channel have drained before settling.
    child.once("close", (code, signal) => {
      settle(() => {
        if (outcome?.ok) {
          const name = outcome.result.backupFileName;
          if (typeof name !== "string" || basename(name) !== name || name.length === 0 || name === "." || name === "..") {
            reject(new BackupOutputGuardError("protocol_fault", "Guarded backup child returned an invalid file name"));
            return;
          }
          resolvePromise({
            backupFile: join(request.backupDir, name),
            sizeBytes: outcome.result.sizeBytes,
            prunedCount: outcome.result.prunedCount,
            ...(outcome.result.lockTokenPrefix ? { lockTokenPrefix: outcome.result.lockTokenPrefix } : {}),
          });
          return;
        }
        if (outcome && !outcome.ok) {
          reject(outcome.error);
          return;
        }
        const detail = stderr.trim();
        reject(new BackupOutputGuardError(
          "child_failed",
          `Guarded backup child exited ${signal ? `via ${signal}` : `with code ${code ?? "unknown"}`} without a result${detail ? `: ${detail}` : ""}`,
        ));
      });
    });
    child.send({ type: "run", request }, (error) => {
      // A failed send means the child is gone or IPC broke; the exit handler settles.
      if (error) stderr = `${stderr}\n${error.message}`.slice(-CHILD_STDERR_BYTES);
    });
  });
}

export function runGuardedDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  return forkGuardedDatabaseBackup(opts);
}
