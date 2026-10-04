import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "99999999-8888-4777-8666-555555555555";
const ENV_NAMES = ["PAPERCLIP_CONFIG", "PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID"] as const;

let tempDir = "";
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function writeConfig(content: string): void {
  fs.writeFileSync(path.join(tempDir, "config.json"), content);
}

function configJson(backup: Record<string, unknown>): string {
  return JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres", backup: { dir: path.join(tempDir, "backups"), ...backup } },
    logging: { mode: "file", logDir: path.join(tempDir, "logs") },
    server: {},
  });
}

async function loadBackupGuard(): Promise<string | undefined> {
  vi.resetModules();
  const { loadConfig } = await import("../config.js");
  return loadConfig().databaseBackupExpectedVolumeUuid;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-server-backup-guard-"));
  process.env.PAPERCLIP_CONFIG = path.join(tempDir, "config.json");
  delete process.env.PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("server backup output guard config", () => {
  it("is absent by default", async () => {
    writeConfig(configJson({}));
    expect(await loadBackupGuard()).toBeUndefined();
  });

  it("reads the config value and lets the env override it, keeping blank env present", async () => {
    writeConfig(configJson({ expectedVolumeUuid: UUID_A }));
    expect(await loadBackupGuard()).toBe(UUID_A);

    process.env.PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID = UUID_B;
    expect(await loadBackupGuard()).toBe(UUID_B);

    process.env.PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID = "";
    expect(await loadBackupGuard()).toBe("");
  });

  it("keeps a malformed configured value so the backup run fails closed", async () => {
    writeConfig(configJson({ expectedVolumeUuid: "not-a-uuid" }));
    expect(await loadBackupGuard()).toBe("not-a-uuid");
  });

  it("keeps explicit null or non-string config values opted in as invalid", async () => {
    for (const value of [null, 42, {}]) {
      writeConfig(configJson({ expectedVolumeUuid: value }));
      expect(await loadBackupGuard()).toBe("");
    }
  });

  it("stays unguarded when the config file does not exist", async () => {
    expect(await loadBackupGuard()).toBeUndefined();
  });

  it("keeps the opt-in present (invalid) when an existing config cannot be read", async () => {
    writeConfig(configJson({ expectedVolumeUuid: UUID_A }));
    const deniedPath = path.join(tempDir, "config.json");
    // Inject EACCES at the OS read boundary (chmod is not reliable for privileged runners).
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const readFileSync = ((file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
        if (typeof file === "string" && path.resolve(file) === deniedPath) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
        }
        return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof actual.readFileSync;
      return { ...actual, readFileSync, default: { ...actual, readFileSync } };
    });
    try {
      expect(await loadBackupGuard()).toBe("");
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("refuses backups when a schema-invalid config is discarded, even if the guard key is escaped", async () => {
    // "expectedVolumeUuid" decodes to the exact guard key; intervalMinutes: 0
    // invalidates the schema so readConfigFile() discards the whole file.
    const valid = JSON.parse(configJson({}));
    valid.database.backup.intervalMinutes = 0;
    const text = JSON.stringify(valid).replace(
      /"backup":\{/,
      `"backup":{"expected\\u0056olumeUuid":"${UUID_A}",`,
    );
    expect(JSON.parse(text).database.backup.expectedVolumeUuid).toBe(UUID_A);
    expect(text.includes("expectedVolumeUuid")).toBe(false);
    writeConfig(text);
    expect(await loadBackupGuard()).toBe("");
  });

  it("refuses backups for any discarded existing config, even without a guard key", async () => {
    const invalid = JSON.parse(configJson({}));
    invalid.database.backup.intervalMinutes = 0;
    writeConfig(JSON.stringify(invalid));
    expect(await loadBackupGuard()).toBe("");
    writeConfig("{ not json");
    expect(await loadBackupGuard()).toBe("");
  });

  it("keeps the opt-in present when an unparseable config mentions the guard", async () => {
    writeConfig(`{ "database": { "backup": { "expectedVolumeUuid": "${UUID_A}" } }`);
    expect(await loadBackupGuard()).toBe("");
  });
});
