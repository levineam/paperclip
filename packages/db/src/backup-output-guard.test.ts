import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBufferedTextFileWriter,
  runDatabaseBackup,
  runPgDumpBackup,
  type RunDatabaseBackupOptions,
} from "./backup-lib.js";
import {
  BackupOutputGuardError,
  forkGuardedDatabaseBackup,
  parseDiskutilInfoPlist,
  resolveBackupOutputGuard,
} from "./backup-output-guard.js";
import {
  STORAGE_TRANSACTION_LOCK_DIR_NAME,
  STORAGE_TRANSACTION_PARTICIPATION_NAME,
  StorageTransactionLockError,
  acquireStorageTransactionLock,
  releaseStorageTransactionLock,
} from "./backup-transaction-lock.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Synthetic UUIDs only; no real volume identity is used by these tests.
const FIXTURE_UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "99999999-8888-4777-8666-555555555555";
const RETENTION = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };
const TIMEOUT = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/**
 * Child entry that runs the real guarded child with a fake volume resolver
 * standing in for diskutil/device-node lookup: `mountPoint` plays the volume
 * root and is re-stat'ed on every resolve, so replacing it changes identity.
 */
type FixtureMutation = {
  backupDir: string;
  action: "replace-dir" | "replace-gzip";
  decoy?: string;
};

/**
 * `mutateAfterAccept`: on the first resolver lookup that sees a finished .sql.gz (the
 * pre-prune "accept" check), queue a microtask that replaces the backup directory or
 * swaps the gzip for a symlink. The synchronous accept/prune finishes first; the
 * mutation lands while the run awaits SQL teardown, before completion.
 */
function writeFixtureEntry(
  mountPoint: string,
  options: { verifiableCalls?: number; mutateAfterAccept?: FixtureMutation } = {},
): string {
  const dir = createTempDir("paperclip-guard-fixture-");
  const entry = path.join(dir, "guard-fixture-entry.mts");
  // ESM ".js" convention: tsx maps these to the .ts siblings from this TypeScript (.mts)
  // fixture in source runs; compiled dist runs load the real .js siblings.
  const childUrl = new URL("./backup-output-guard-child.js", import.meta.url).href;
  const guardUrl = new URL("./backup-output-guard.js", import.meta.url).href;
  fs.writeFileSync(entry, `
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { serveGuardedBackupChild } from ${JSON.stringify(childUrl)};
import { BackupOutputGuardError } from ${JSON.stringify(guardUrl)};
const mountPoint = ${JSON.stringify(mountPoint)};
const verifiableCalls = ${JSON.stringify(options.verifiableCalls ?? null)};
const mutation = ${JSON.stringify(options.mutateAfterAccept ?? null)};
let calls = 0;
let mutated = false;
serveGuardedBackupChild((uuid) => {
  calls += 1;
  if (mutation && !mutated && existsSync(mutation.backupDir)
    && readdirSync(mutation.backupDir).some((name) => name.endsWith(".sql.gz"))) {
    mutated = true;
    queueMicrotask(() => {
      if (mutation.action === "replace-dir") {
        renameSync(mutation.backupDir, mutation.backupDir + ".moved");
        mkdirSync(mutation.backupDir);
        return;
      }
      for (const name of readdirSync(mutation.backupDir)) {
        if (!name.endsWith(".sql.gz")) continue;
        unlinkSync(join(mutation.backupDir, name));
        symlinkSync(mutation.decoy, join(mutation.backupDir, name));
      }
    });
  }
  if (verifiableCalls !== null && calls > verifiableCalls) {
    throw new BackupOutputGuardError("unverifiable", "fixture volume can no longer be verified");
  }
  if (uuid !== ${JSON.stringify(FIXTURE_UUID.toUpperCase())}) {
    throw new BackupOutputGuardError("volume_absent", "fixture volume not found");
  }
  const root = lstatSync(mountPoint, { bigint: true });
  return { mountPoint, dev: root.dev, ino: root.ino };
});
`);
  return entry;
}

function writeFakePgDump(body: string): string {
  const dir = createTempDir("paperclip-guard-pgdump-");
  const script = path.join(dir, "pg_dump");
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return script;
}

function guardedOptions(overrides: Partial<RunDatabaseBackupOptions>): RunDatabaseBackupOptions {
  return {
    connectionString: "postgres://paperclip:paperclip@127.0.0.1:1/paperclip",
    backupDir: "/nonexistent",
    retention: RETENTION,
    filenamePrefix: "guard-test",
    connectTimeoutSeconds: 1,
    backupEngine: "javascript",
    outputGuard: { expectedVolumeUuid: FIXTURE_UUID },
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function backupArtifacts(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".sql") || name.endsWith(".sql.gz"));
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backup output guard opt-in parsing", () => {
  it("treats absent as unguarded and present-but-invalid as an error", () => {
    expect(resolveBackupOutputGuard({})).toBeUndefined();
    expect(resolveBackupOutputGuard({ config: FIXTURE_UUID.toLowerCase() }))
      .toEqual({ expectedVolumeUuid: FIXTURE_UUID.toUpperCase() });
    expect(resolveBackupOutputGuard({ env: ` ${OTHER_UUID} `, config: FIXTURE_UUID }))
      .toEqual({ expectedVolumeUuid: OTHER_UUID });
    for (const bad of ["", "   ", "not-a-uuid", `${FIXTURE_UUID}x`]) {
      expect(() => resolveBackupOutputGuard({ env: bad, config: FIXTURE_UUID })).toThrow(BackupOutputGuardError);
      expect(() => resolveBackupOutputGuard({ config: bad })).toThrow(BackupOutputGuardError);
    }
    expect(() => resolveBackupOutputGuard({ config: 42 })).toThrow(BackupOutputGuardError);
    // An explicit null is a present (invalid) opt-in, not "not configured".
    expect(() => resolveBackupOutputGuard({ config: null })).toThrow(BackupOutputGuardError);
    expect(() => resolveBackupOutputGuard({ config: {} })).toThrow(BackupOutputGuardError);
  });

  /** Run the standalone db:backup script against a disposable PAPERCLIP_HOME (DB port 1, never reachable). */
  function runStandaloneBackup(
    expectedVolumeUuid: unknown,
    options: { denyConfigRead?: boolean; rawConfig?: (backupDir: string) => string } = {},
  ) {
    const home = createTempDir("paperclip-guard-standalone-");
    const instanceDir = path.join(home, "instances", "default");
    const configPath = path.join(instanceDir, "config.json");
    const backupDir = path.join(home, "backups");
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(configPath, options.rawConfig?.(backupDir) ?? JSON.stringify({
      database: { mode: "embedded-postgres", backup: { dir: backupDir, expectedVolumeUuid } },
    }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCLIP_HOME: home,
      PAPERCLIP_INSTANCE_ID: "default",
      DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:1/paperclip",
    };
    delete env.PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID;
    delete env.NODE_OPTIONS;
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const preloads = ["--import", loader];
    if (options.denyConfigRead) {
      // Inject EACCES at the OS read boundary for this one path (chmod is unreliable for
      // privileged runners): patch node:fs and resync its ESM named exports.
      const preload = path.join(createTempDir("paperclip-guard-preload-"), "deny-config-read.mjs");
      fs.writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const denied = ${JSON.stringify(configPath)};
const original = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  if (String(file) === denied) {
    throw Object.assign(new Error("EACCES: permission denied, open '" + denied + "'"), { code: "EACCES" });
  }
  return original.call(this, file, ...rest);
};
syncBuiltinESMExports();
`);
      preloads.push("--import", pathToFileURL(preload).href);
    }
    // tsx only maps ".js" to ".ts" for imports from a TypeScript parent, not for the main
    // entry, so run a one-line .mts entry that imports the script by the ".js" convention.
    const entry = path.join(createTempDir("paperclip-guard-standalone-entry-"), "standalone-entry.mts");
    fs.writeFileSync(entry, `import ${JSON.stringify(new URL("./backup.js", import.meta.url).href)};\n`);
    const result = spawnSync(
      process.execPath,
      [...preloads, entry],
      { cwd: home, env, encoding: "utf8", timeout: 30_000 },
    );
    return { home, backupDir, result };
  }

  it("makes the standalone db:backup script refuse an explicit null config value before any effect", () => {
    const { home, backupDir, result } = runStandaloneBackup(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/expectedVolumeUuid/);
    // An unguarded run would have created the backup dir and lock marker.
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(path.join(home, "instances", "default", "data"))).toBe(false);
  }, TIMEOUT);

  it("makes the standalone db:backup script refuse malformed JSON with an escaped guard key before any effect", () => {
    // "expectedVolumeUuid" spells the guard key; the missing closing brace makes the
    // JSON invalid, and no substring test can see the key.
    const { home, backupDir, result } = runStandaloneBackup(undefined, {
      rawConfig: (dir) =>
        `{"database":{"mode":"embedded-postgres","backup":{"dir":${JSON.stringify(dir)},"expected\\u0056olumeUuid":"${FIXTURE_UUID}"}}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot parse .*config\.json/);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(path.join(home, "instances", "default", "data"))).toBe(false);
  }, TIMEOUT);

  it("makes the standalone db:backup script refuse a misshapen config before any effect", () => {
    const { home, backupDir, result } = runStandaloneBackup(undefined, {
      rawConfig: () => JSON.stringify({ database: { mode: "embedded-postgres", backup: "not-an-object" } }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unexpected config shape/);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(path.join(home, "instances", "default", "data"))).toBe(false);
  }, TIMEOUT);

  it("makes the standalone db:backup script refuse an existing but unreadable config before any effect", () => {
    const { home, backupDir, result } = runStandaloneBackup(FIXTURE_UUID, { denyConfigRead: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read .*config\.json/);
    // Treating the unreadable config as absent would back up unguarded to the default dir.
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(path.join(home, "instances", "default", "data"))).toBe(false);
  }, TIMEOUT);

  it("parses diskutil plist fields strictly", () => {
    const plist = (body: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`;
    const good = plist(`
      <key>DeviceIdentifier</key><string>disk6s1</string>
      <key>MountPoint</key><string>/Volumes/Fixture &amp; Co</string>
      <key>VolumeUUID</key><string>${FIXTURE_UUID.toLowerCase()}</string>`);
    expect(parseDiskutilInfoPlist(good)).toEqual({
      volumeUuid: FIXTURE_UUID.toUpperCase(),
      mountPoint: "/Volumes/Fixture & Co",
      deviceIdentifier: "disk6s1",
    });
    const codeOf = (xml: string) => {
      try {
        parseDiskutilInfoPlist(xml);
      } catch (error) {
        return (error as BackupOutputGuardError).code;
      }
      return null;
    };
    expect(codeOf(plist(`<key>DeviceIdentifier</key><string>disk6s1</string><key>VolumeUUID</key><string>${FIXTURE_UUID}</string>`)))
      .toBe("volume_absent");
    expect(codeOf(good.replace("disk6s1", "../disk6s1"))).toBe("unverifiable");
    expect(codeOf(good.replace("/Volumes/Fixture &amp; Co", "/"))).toBe("unverifiable");
    expect(codeOf(good.replace("/Volumes/Fixture &amp; Co", "/Volumes/../etc"))).toBe("invalid_path");
    expect(codeOf(good.replace("&amp;", "&#47;"))).toBe("unverifiable");
    expect(codeOf(good + good)).toBe("unverifiable");
    expect(codeOf("not a plist")).toBe("unverifiable");
  });
});

describe("guarded runDatabaseBackup preflight", () => {
  it("rejects malformed opt-in, relative dirs, and unsafe prefixes before creating anything", async () => {
    const root = createTempDir("paperclip-guard-preflight-");
    const backupDir = path.join(root, "backups");
    const cases: Array<Partial<RunDatabaseBackupOptions>> = [
      { backupDir, outputGuard: { expectedVolumeUuid: "" } },
      { backupDir, outputGuard: { expectedVolumeUuid: "garbage" } },
      { backupDir, outputGuard: null as unknown as RunDatabaseBackupOptions["outputGuard"] },
      { backupDir: "relative/backups" },
      { backupDir: `${root}/../escape` },
      { backupDir, filenamePrefix: "../escape" },
      { backupDir, filenamePrefix: "a/b" },
      { backupDir, filenamePrefix: ".paperclip-stx-owner" },
    ];
    for (const overrides of cases) {
      const error = await captureError(runDatabaseBackup(guardedOptions(overrides)));
      expect(error).toBeInstanceOf(BackupOutputGuardError);
      expect(["invalid_config", "invalid_path"]).toContain((error as BackupOutputGuardError).code);
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.runIf(process.platform !== "darwin")("fails closed as unsupported off macOS", async () => {
    const root = createTempDir("paperclip-guard-unsupported-");
    const error = await captureError(runDatabaseBackup(guardedOptions({ backupDir: path.join(root, "b") })));
    expect((error as BackupOutputGuardError).code).toBe("unsupported");
    expect(fs.readdirSync(root)).toEqual([]);
  }, TIMEOUT);

  it.runIf(process.platform === "darwin")("fails closed through the real child when the volume UUID is not mounted", async () => {
    const root = createTempDir("paperclip-guard-absent-");
    const error = await captureError(runDatabaseBackup(guardedOptions({
      backupDir: path.join(root, "b"),
      outputGuard: { expectedVolumeUuid: OTHER_UUID },
    })));
    expect(error).toBeInstanceOf(BackupOutputGuardError);
    expect(["volume_absent", "unverifiable"]).toContain((error as BackupOutputGuardError).code);
    expect(fs.readdirSync(root)).toEqual([]);
  }, TIMEOUT);
});

describe("guarded backup child confinement (fixture volume)", () => {
  it("rejects a missing/wrong volume and a directory outside the volume without writing", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const outside = createTempDir("paperclip-guard-outside-");
    const entry = writeFixtureEntry(mount);

    const wrongUuid = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      backupDir: path.join(mount, "backups"),
      outputGuard: { expectedVolumeUuid: OTHER_UUID },
    }), entry));
    expect((wrongUuid as BackupOutputGuardError).code).toBe("volume_absent");

    const outsideDir = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      backupDir: path.join(outside, "backups"),
    }), entry));
    expect((outsideDir as BackupOutputGuardError).code).toBe("wrong_volume");

    expect(fs.readdirSync(mount)).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  }, TIMEOUT);

  it("re-verifies the volume after pinning and before creating anything", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    // The resolver verifies the root once, then loses verification on every later call.
    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      backupDir: path.join(mount, "backups", "nested"),
    }), writeFixtureEntry(mount, { verifiableCalls: 1 })));
    expect(error).toBeInstanceOf(BackupOutputGuardError);
    expect((error as BackupOutputGuardError).code).toBe("unverifiable");
    expect(fs.readdirSync(mount)).toEqual([]);
  }, TIMEOUT);

  it("re-verifies from each pinned parent before creating the next component", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    // Initial resolve + renewal at the root succeed; renewal inside "backups" fails.
    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      backupDir: path.join(mount, "backups", "nested"),
    }), writeFixtureEntry(mount, { verifiableCalls: 2 })));
    expect((error as BackupOutputGuardError).code).toBe("unverifiable");
    expect(fs.readdirSync(mount)).toEqual(["backups"]);
    expect(fs.readdirSync(path.join(mount, "backups"))).toEqual([]);
    expect(fs.statSync(path.join(mount, "backups")).mode & 0o777).toBe(0o700);
  }, TIMEOUT);

  it("rejects symlinked directory components without touching the link target", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const outside = createTempDir("paperclip-guard-outside-");
    fs.symlinkSync(outside, path.join(mount, "link"));
    const entry = writeFixtureEntry(mount);

    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      backupDir: path.join(mount, "link", "backups"),
    }), entry));
    expect((error as BackupOutputGuardError).code).toBe("symlink_escape");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(mount)).toEqual(["link"]);
  }, TIMEOUT);

  it("creates missing components inside the volume and releases the relative lock after a failure", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "a", "b");
    const entry = writeFixtureEntry(mount);

    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({ backupDir }), entry));
    expect(error).not.toBeInstanceOf(BackupOutputGuardError);
    expect(fs.existsSync(path.join(backupDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(backupDir, STORAGE_TRANSACTION_PARTICIPATION_NAME), "utf8")))
      .toMatchObject({ state: "ready" });
    expect(backupArtifacts(backupDir)).toEqual([]);
    expect(fs.readdirSync(mount)).toEqual(["a"]);
  }, TIMEOUT);

  it("reconstructs the typed busy error from the child without disturbing the held lock", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "backups");
    fs.mkdirSync(backupDir);
    const held = acquireStorageTransactionLock({ sourceRoot: backupDir, operationKind: "backup" });
    try {
      const error = await captureError(forkGuardedDatabaseBackup(
        guardedOptions({ backupDir }),
        writeFixtureEntry(mount),
      ));
      expect(error).toBeInstanceOf(StorageTransactionLockError);
      expect((error as StorageTransactionLockError).code).toBe("busy");
      expect(JSON.parse(fs.readFileSync(held.ownerPath, "utf8")).token).toBe(held.token);
      expect(backupArtifacts(backupDir)).toEqual([]);
    } finally {
      releaseStorageTransactionLock(held);
    }
  }, TIMEOUT);

  it("rejects without a stranded promise when the child entry cannot start", async () => {
    const root = createTempDir("paperclip-guard-missing-entry-");
    const error = await captureError(forkGuardedDatabaseBackup(
      guardedOptions({ backupDir: path.join(root, "b") }),
      path.join(root, "missing-entry.mjs"),
    ));
    expect((error as BackupOutputGuardError).code).toBe("child_failed");
    expect(fs.readdirSync(root)).toEqual([]);
  }, TIMEOUT);
});

function guardErrorCodes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(guardErrorCodes);
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? [code] : [];
}

describe("exclusive writer ownership", () => {
  for (const mode of ["file", "symlink"] as const) {
    it(`never unlinks a ${mode} that replaced its exclusively created file`, async () => {
      const dir = createTempDir("paperclip-guard-writer-");
      const decoy = path.join(createTempDir("paperclip-guard-decoy-"), "decoy.sql");
      fs.writeFileSync(decoy, "decoy");
      const target = path.join(dir, "out.sql");
      const writer = createBufferedTextFileWriter(target, 16, { exclusive: true });
      writer.emit("-- ours");
      const identity = await writer.identity();
      const created = fs.statSync(target, { bigint: true });
      expect(identity).toEqual({ dev: created.dev, ino: created.ino });
      fs.unlinkSync(target);
      if (mode === "symlink") fs.symlinkSync(decoy, target);
      else fs.writeFileSync(target, "foreign");
      await writer.abort();
      if (mode === "symlink") expect(fs.readlinkSync(target)).toBe(decoy);
      else expect(fs.readFileSync(target, "utf8")).toBe("foreign");
      expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
    });
  }
});

describe("guarded pg_dump producer settlement", () => {
  it("does not reject until every holder of pg_dump's stdout has finished", async () => {
    const dir = createTempDir("paperclip-guard-pgdump-settle-");
    const marker = path.join(createTempDir("paperclip-guard-pgdump-marker-"), "producer-done");
    setEnv("GUARD_TEST_MARKER", marker);
    // pg_dump exits non-zero at once while a descendant still holds stdout and writes later.
    setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump(
      "( sleep 1; printf 'late\\n'; echo done > \"$GUARD_TEST_MARKER\" ) &\nexit 3",
    ));
    let created = false;
    const error = await captureError(runPgDumpBackup({
      connectionString: "postgres://unused",
      backupFile: path.join(dir, "out.sql.gz"),
      connectTimeout: 1,
      onExclusiveCreate: () => {
        created = true;
      },
    }));
    expect((error as Error).message).toMatch(/exit code 3/);
    expect(created).toBe(true);
    // The producer leg settled before rejection, so cleanup/fallback/lock release cannot overlap it.
    expect(fs.existsSync(marker)).toBe(true);
  }, TIMEOUT);
});

describeEmbeddedPostgres("guarded backup child with a database (fixture volume)", () => {
  let connectionString = "";
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-guard-");
    connectionString = db.connectionString;
    stopDb = db.cleanup;
  }, TIMEOUT);

  afterAll(async () => {
    await stopDb?.();
  });

  it("writes pg_dump output and prunes only regular files inside the pinned directory", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const outside = createTempDir("paperclip-guard-outside-");
    const backupDir = path.join(mount, "backups");
    fs.mkdirSync(backupDir);
    const old = new Date(Date.UTC(2020, 0, 1));
    const oldBackup = path.join(backupDir, "guard-test-20200101-000000.sql.gz");
    fs.writeFileSync(oldBackup, "old");
    fs.utimesSync(oldBackup, old, old);
    const decoy = path.join(outside, "decoy.sql.gz");
    fs.writeFileSync(decoy, "decoy");
    const linkedOld = path.join(backupDir, "guard-test-20200102-000000.sql.gz");
    fs.symlinkSync(decoy, linkedOld);
    fs.lutimesSync(linkedOld, old, old);
    setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump("printf 'SELECT 1;\\n'"));

    const result = await forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "pg_dump",
    }), writeFixtureEntry(mount));

    expect(path.dirname(result.backupFile)).toBe(backupDir);
    expect(gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8")).toBe("SELECT 1;\n");
    expect(result.prunedCount).toBe(1);
    expect(fs.existsSync(oldBackup)).toBe(false);
    expect(fs.lstatSync(linkedOld).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
    expect(fs.existsSync(path.join(backupDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual(["decoy.sql.gz"]);
  }, TIMEOUT);

  it("writes and compresses a JavaScript backup inside the pinned directory", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "nested", "backups");
    const result = await forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "javascript",
    }), writeFixtureEntry(mount));

    expect(path.dirname(result.backupFile)).toBe(backupDir);
    expect(gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8")).toContain("-- Paperclip database backup");
    expect(backupArtifacts(backupDir)).toEqual([path.basename(result.backupFile)]);
  }, TIMEOUT);

  it("falls back to JavaScript inside the pinned directory when pg_dump fails", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "backups");
    setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump("echo boom >&2\nexit 3"));

    const result = await forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "auto",
    }), writeFixtureEntry(mount));

    expect(gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8")).toContain("-- Paperclip database backup");
    expect(backupArtifacts(backupDir)).toEqual([path.basename(result.backupFile)]);
  }, TIMEOUT);

  it("fails pg_dump-only runs without leaving artifacts", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "backups");
    setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump("exit 3"));

    await expect(forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "pg_dump",
    }), writeFixtureEntry(mount))).rejects.toThrow(/exit code 3/);
    expect(backupArtifacts(backupDir)).toEqual([]);
    expect(fs.existsSync(path.join(backupDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
  }, TIMEOUT);

  it("rejects when the gzip is swapped after acceptance but before transaction completion", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "backups");
    fs.mkdirSync(backupDir);
    const decoy = path.join(createTempDir("paperclip-guard-decoy-"), "decoy");
    fs.writeFileSync(decoy, "decoy");

    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "javascript",
    }), writeFixtureEntry(mount, { mutateAfterAccept: { backupDir, action: "replace-gzip", decoy } })));

    expect(guardErrorCodes(error)).toEqual(expect.arrayContaining(["replaced", "residual_replaced"]));
    const remaining = backupArtifacts(backupDir);
    expect(remaining).toHaveLength(1);
    expect(fs.readlinkSync(path.join(backupDir, remaining[0]!))).toBe(decoy);
    expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
    expect(fs.existsSync(path.join(backupDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(backupDir, STORAGE_TRANSACTION_PARTICIPATION_NAME), "utf8")))
      .toMatchObject({ state: "active" });
  }, TIMEOUT);

  it("rejects when the backup directory is replaced after acceptance but before transaction completion", async () => {
    const mount = createTempDir("paperclip-guard-mount-");
    const backupDir = path.join(mount, "backups");
    fs.mkdirSync(backupDir);
    const pinnedDir = `${backupDir}.moved`;
    cleanups.push(() => fs.rmSync(pinnedDir, { recursive: true, force: true }));

    const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
      connectionString,
      backupDir,
      backupEngine: "javascript",
    }), writeFixtureEntry(mount, { mutateAfterAccept: { backupDir, action: "replace-dir" } })));

    expect(guardErrorCodes(error)).toContain("replaced");
    // Nothing lands in the replacement; the original pinned directory holds no artifact
    // of ours (our own gzip is retired by identity) and the relative lock is released.
    expect(fs.readdirSync(backupDir)).toEqual([]);
    expect(backupArtifacts(pinnedDir)).toEqual([]);
    expect(fs.existsSync(path.join(pinnedDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(pinnedDir, STORAGE_TRANSACTION_PARTICIPATION_NAME), "utf8")))
      .toMatchObject({ state: "ready" });
  }, TIMEOUT);

  const replacementCases = [
    { suffix: ".sql", mode: "file", engine: "pg_dump" },
    { suffix: ".sql", mode: "symlink", engine: "pg_dump" },
    { suffix: ".sql.gz", mode: "file", engine: "pg_dump" },
    { suffix: ".sql.gz", mode: "symlink", engine: "pg_dump" },
    { suffix: ".sql.gz", mode: "file", engine: "auto" },
  ] as const;
  for (const { suffix, mode, engine } of replacementCases) {
    it(`rejects and preserves a ${mode} that replaced the guarded ${suffix} artifact (${engine})`, async () => {
      const mount = createTempDir("paperclip-guard-mount-");
      const backupDir = path.join(mount, "backups");
      fs.mkdirSync(backupDir);
      const decoy = path.join(createTempDir("paperclip-guard-decoy-"), "decoy");
      fs.writeFileSync(decoy, "decoy");
      setEnv("GUARD_TEST_DECOY", decoy);
      // Runs with the pinned directory as CWD while our exclusively created files exist.
      const replace = mode === "symlink" ? "ln -s \"$GUARD_TEST_DECOY\" \"$f\"" : "printf foreign > \"$f\"";
      setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump(
        `for f in guard-test-*${suffix}; do rm -f "$f"; ${replace}; done\nprintf 'SELECT 1;\\n'`,
      ));

      const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
        connectionString,
        backupDir,
        backupEngine: engine,
      }), writeFixtureEntry(mount)));

      expect(guardErrorCodes(error)).toContain("replaced");
      expect(guardErrorCodes(error)).toContain("residual_replaced");
      // Only the foreign replacement remains; our other artifact was retired.
      const remaining = backupArtifacts(backupDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.endsWith(".gz")).toBe(suffix === ".sql.gz");
      const replaced = path.join(backupDir, remaining[0]!);
      if (mode === "symlink") expect(fs.readlinkSync(replaced)).toBe(decoy);
      else expect(fs.readFileSync(replaced, "utf8")).toBe("foreign");
      expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
      expect(fs.existsSync(path.join(backupDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
      // A residual artifact keeps archivers out.
      expect(JSON.parse(fs.readFileSync(path.join(backupDir, STORAGE_TRANSACTION_PARTICIPATION_NAME), "utf8")))
        .toMatchObject({ state: "active" });
    }, TIMEOUT);
  }

  for (const target of ["backup directory", "volume root"] as const) {
    it(`aborts without fallback when the ${target} is replaced mid-transaction`, async () => {
      const mount = createTempDir("paperclip-guard-mount-");
      const backupDir = path.join(mount, "backups");
      fs.mkdirSync(backupDir);
      const replaced = target === "volume root" ? mount : backupDir;
      setEnv("GUARD_TEST_TARGET", replaced);
      // Same-device replacement: rename the pinned directory away and recreate the path.
      setEnv("PAPERCLIP_PG_DUMP_PATH", writeFakePgDump(
        "mv \"$GUARD_TEST_TARGET\" \"$GUARD_TEST_TARGET.moved\" && mkdir \"$GUARD_TEST_TARGET\"\nprintf 'SELECT 1;\\n'",
      ));
      cleanups.push(() => fs.rmSync(`${replaced}.moved`, { recursive: true, force: true }));

      const error = await captureError(forkGuardedDatabaseBackup(guardedOptions({
        connectionString,
        backupDir,
        backupEngine: "auto",
      }), writeFixtureEntry(mount)));

      expect(error).toBeInstanceOf(BackupOutputGuardError);
      expect(["replaced", "volume_changed"]).toContain((error as BackupOutputGuardError).code);
      // Nothing (lock, marker, temp, backup) lands in the replacement.
      expect(fs.readdirSync(replaced)).toEqual([]);
      // The original pinned directory is cleaned up and its lock released.
      const pinnedDir = target === "volume root" ? path.join(`${mount}.moved`, "backups") : `${backupDir}.moved`;
      expect(backupArtifacts(pinnedDir)).toEqual([]);
      expect(fs.existsSync(path.join(pinnedDir, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(pinnedDir, STORAGE_TRANSACTION_PARTICIPATION_NAME), "utf8")))
        .toMatchObject({ state: "ready" });
    }, TIMEOUT);
  }
});
