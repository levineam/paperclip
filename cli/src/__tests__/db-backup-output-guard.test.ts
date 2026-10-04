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
// Never reachable; runDatabaseBackup is mocked, so nothing connects.
const UNREACHABLE_DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:1/paperclip";

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
});
