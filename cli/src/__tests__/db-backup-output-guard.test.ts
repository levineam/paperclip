import fs, { type PathLike, type PathOrFileDescriptor } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runDatabaseBackupMock } = vi.hoisted(() => ({
  runDatabaseBackupMock: vi.fn(async (opts: { backupDir: string }) => ({
    backupFile: path.join(opts.backupDir, "paperclip-test.sql.gz"),
    sizeBytes: 1,
    prunedCount: 0,
  })),
}));

vi.mock("@paperclipai/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/db")>()),
  runDatabaseBackup: runDatabaseBackupMock,
}));

import { dbBackupCommand, resolveDbBackupOutputGuard } from "../commands/db-backup.js";

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "99999999-8888-4777-8666-555555555555";
const ENV_NAME = "PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID";

let tempDir = "";
const savedEnv = process.env[ENV_NAME];
const savedDatabaseUrl = process.env.DATABASE_URL;
const DISCOVERY_ENV_NAMES = ["PAPERCLIP_CONFIG", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"] as const;
const savedDiscoveryEnv = Object.fromEntries(DISCOVERY_ENV_NAMES.map((name) => [name, process.env[name]]));
// Never reachable; runDatabaseBackup is mocked, so nothing connects.
const UNREACHABLE_DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:1/paperclip";

function errnoError(code: string, syscall: string, target: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${target}'`), { code, syscall, path: target });
}

/**
 * Run `fn` with config discovery confined to the temp dir and no override: cwd is a
 * project subdirectory, every config.json outside the temp dir reads as absent (no
 * real home or ancestor config is ever touched), and, when `denyProjectConfig` is
 * set, the project's .paperclip/config.json is uninspectable (EACCES) at the OS
 * boundary, which existsSync reports as false.
 */
async function withConfinedDiscovery(options: { denyProjectConfig: boolean }, fn: () => Promise<void>) {
  delete process.env.PAPERCLIP_CONFIG;
  process.env.PAPERCLIP_HOME = path.join(tempDir, "home");
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
  const projectRoot = path.join(tempDir, "project");
  const workDir = path.join(projectRoot, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const projectConfig = path.join(projectRoot, ".paperclip", "config.json");
  if (options.denyProjectConfig) {
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.writeFileSync(projectConfig, JSON.stringify({
      $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
      database: { mode: "embedded-postgres", backup: { dir: path.join(tempDir, "backups"), expectedVolumeUuid: UUID_A } },
      logging: { mode: "file", logDir: path.join(tempDir, "logs") },
      server: {},
    }));
  }
  const classify = (target: unknown): "deny" | "absent" | null => {
    if (typeof target !== "string" || path.basename(target) !== "config.json") return null;
    const resolved = path.resolve(target);
    if (options.denyProjectConfig && resolved === projectConfig) return "deny";
    if (!resolved.startsWith(`${tempDir}${path.sep}`)) return "absent";
    return null;
  };
  const realStatSync = fs.statSync;
  const realExistsSync = fs.existsSync;
  const realReadFileSync = fs.readFileSync;
  // Only config discovery (cli/src/config/store.ts) sees the synthetic project cwd;
  // the test runner's own module resolution keeps the real cwd.
  const realCwd = process.cwd.bind(process);
  const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() =>
    (new Error().stack ?? "").includes(`${path.sep}config${path.sep}store.ts`) ? workDir : realCwd());
  const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((target: PathLike, ...rest: unknown[]) => {
    const kind = classify(target);
    if (kind === "deny") throw errnoError("EACCES", "stat", String(target));
    if (kind === "absent") throw errnoError("ENOENT", "stat", String(target));
    return (realStatSync as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.statSync);
  const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation(((target: PathLike) =>
    classify(target) ? false : realExistsSync(target)) as typeof fs.existsSync);
  const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: PathOrFileDescriptor, ...rest: unknown[]) => {
    const kind = classify(target);
    if (kind === "deny") throw errnoError("EACCES", "open", String(target));
    if (kind === "absent") throw errnoError("ENOENT", "open", String(target));
    return (realReadFileSync as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync);
  try {
    await fn();
  } finally {
    readSpy.mockRestore();
    existsSpy.mockRestore();
    statSpy.mockRestore();
    cwdSpy.mockRestore();
  }
}

function writeConfig(backup: Record<string, unknown>): string {
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres", backup: { dir: path.join(tempDir, "backups"), ...backup } },
    logging: { mode: "file", logDir: path.join(tempDir, "logs") },
    server: {},
  }));
  return configPath;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-db-backup-guard-"));
  delete process.env[ENV_NAME];
  runDatabaseBackupMock.mockClear();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = savedEnv;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  for (const name of DISCOVERY_ENV_NAMES) {
    if (savedDiscoveryEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedDiscoveryEnv[name];
  }
});

describe("db:backup output guard resolution", () => {
  it("prefers flag, then env, then config, and fails closed on blank or malformed values", () => {
    expect(resolveDbBackupOutputGuard(undefined, undefined, {})).toBeUndefined();
    expect(resolveDbBackupOutputGuard(undefined, UUID_A, {})).toEqual({ expectedVolumeUuid: UUID_A });
    expect(resolveDbBackupOutputGuard(undefined, UUID_A, { [ENV_NAME]: UUID_B })).toEqual({ expectedVolumeUuid: UUID_B });
    expect(resolveDbBackupOutputGuard(UUID_A, UUID_B, { [ENV_NAME]: UUID_B })).toEqual({ expectedVolumeUuid: UUID_A });
    expect(() => resolveDbBackupOutputGuard("", UUID_A, {})).toThrow(/expected-volume-uuid/);
    expect(() => resolveDbBackupOutputGuard(undefined, UUID_A, { [ENV_NAME]: " " })).toThrow(new RegExp(ENV_NAME));
    expect(() => resolveDbBackupOutputGuard(undefined, "nope", {})).toThrow(/expectedVolumeUuid/);
    expect(() => resolveDbBackupOutputGuard(undefined, null, {})).toThrow(/expectedVolumeUuid/);
  });

  it("passes the configured guard to runDatabaseBackup and omits it by default", async () => {
    await dbBackupCommand({ config: writeConfig({}) });
    expect(runDatabaseBackupMock.mock.calls[0]?.[0]).not.toHaveProperty("outputGuard");

    await dbBackupCommand({ config: writeConfig({ expectedVolumeUuid: UUID_A }) });
    expect(runDatabaseBackupMock.mock.calls[1]?.[0]).toMatchObject({ outputGuard: { expectedVolumeUuid: UUID_A } });

    await dbBackupCommand({ config: writeConfig({ expectedVolumeUuid: UUID_A }), expectedVolumeUuid: UUID_B });
    expect(runDatabaseBackupMock.mock.calls[2]?.[0]).toMatchObject({ outputGuard: { expectedVolumeUuid: UUID_B } });
  });

  it("refuses to run when the configured guard is malformed", async () => {
    for (const value of ["", null, 42]) {
      await expect(dbBackupCommand({ config: writeConfig({ expectedVolumeUuid: value }) })).rejects.toThrow();
    }
    expect(runDatabaseBackupMock).not.toHaveBeenCalled();
  });

  it("uses unguarded defaults only when the config file genuinely does not exist", async () => {
    process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const missingConfig = path.join(tempDir, "missing", "config.json");
    await dbBackupCommand({ config: missingConfig, dir: path.join(tempDir, "backups") });
    expect(runDatabaseBackupMock).toHaveBeenCalledTimes(1);
    expect(runDatabaseBackupMock.mock.calls[0]?.[0]).not.toHaveProperty("outputGuard");
  });

  it("refuses to run when an existing config is hidden from existsSync and unreadable", async () => {
    // DATABASE_URL lets connection resolution skip the config, so only the reader decides.
    process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const configPath = writeConfig({ expectedVolumeUuid: UUID_A });
    // Simulate EACCES at the OS boundary for exactly this path: existence inspection
    // reports false (as existsSync does for EACCES) and the direct read fails.
    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation(((target: PathLike) =>
      path.resolve(String(target)) === configPath ? false : realExistsSync(target)) as typeof fs.existsSync);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof target === "string" && path.resolve(target) === configPath) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: "EACCES" });
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync);
    try {
      await expect(dbBackupCommand({ config: configPath })).rejects.toThrow(/EACCES/);
      expect(runDatabaseBackupMock).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("refuses to run when an ancestor project config cannot be inspected and no override is given", async () => {
    await withConfinedDiscovery({ denyProjectConfig: true }, async () => {
      await expect(dbBackupCommand({ dir: path.join(tempDir, "backups") })).rejects.toThrow(/EACCES/);
    });
    expect(runDatabaseBackupMock).not.toHaveBeenCalled();
  });

  it("uses unguarded defaults when no project config exists anywhere and no override is given", async () => {
    await withConfinedDiscovery({ denyProjectConfig: false }, async () => {
      await dbBackupCommand({ dir: path.join(tempDir, "backups") });
    });
    expect(runDatabaseBackupMock).toHaveBeenCalledTimes(1);
    expect(runDatabaseBackupMock.mock.calls[0]?.[0]).not.toHaveProperty("outputGuard");
  });
});
