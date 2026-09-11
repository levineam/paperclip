import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX,
  STORAGE_TRANSACTION_LOCK_SCHEMA,
  StorageTransactionBlockedError,
  StorageTransactionBusyError,
  acquireStorageTransactionLock,
  checkStorageTransactionLiveness,
  isStorageTransactionReservedArtifact,
  readStorageTransactionParticipationMarker,
  type StorageTransactionIdentity,
  type StorageTransactionLockDeps,
  type StorageTransactionLockRecord,
} from "./backup-transaction-lock.js";

const cleanup: Array<() => void> = [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.resolve(packageRoot, "src/backup-transaction-lock.ts");
const tsxPath = path.resolve(packageRoot, "node_modules/tsx/dist/cli.mjs");

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function identity(overrides: Partial<StorageTransactionIdentity> = {}): StorageTransactionIdentity {
  return {
    machineId: "machine-a",
    bootId: "boot-a",
    pid: 4100,
    processStartId: "start-4100",
    ...overrides,
  };
}

function deps(
  current: StorageTransactionIdentity,
  overrides: Partial<StorageTransactionLockDeps> = {},
): StorageTransactionLockDeps {
  return {
    resolveIdentity: () => current,
    createToken: () => `token-${current.pid}`,
    checkLiveness: (record, observed) => checkStorageTransactionLiveness(record, observed),
    now: () => new Date("2026-09-11T12:00:00.000Z"),
    ...overrides,
  };
}

function ownerPath(root: string): string {
  return path.join(root, `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}owner`);
}

function writeOwner(root: string, record: StorageTransactionLockRecord): void {
  fs.writeFileSync(ownerPath(root), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function record(overrides: Partial<StorageTransactionLockRecord> = {}): StorageTransactionLockRecord {
  return {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    ...identity(),
    token: "existing-token",
    operationKind: "database-backup",
    acquiredAt: "2026-09-11T11:00:00.000Z",
    ...overrides,
  };
}

async function waitFor(pathname: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(pathname)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForAny(pathnames: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pathnames.some((pathname) => fs.existsSync(pathname))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for one of: ${pathnames.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for pid ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function childExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

function spawnLockChild(input: {
  root: string;
  start: string;
  acquired: string;
  release: string;
  result: string;
  name: string;
}): ChildProcess {
  const script = path.join(input.root, `lock-child-${input.name}.mts`);
  fs.writeFileSync(script, `
import fs from "node:fs";
import { acquireStorageTransactionLock } from ${JSON.stringify(modulePath)};
const start = ${JSON.stringify(input.start)};
const acquired = ${JSON.stringify(input.acquired)};
const release = ${JSON.stringify(input.release)};
const result = ${JSON.stringify(input.result)};
const root = ${JSON.stringify(input.root)};
async function waitFor(file) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error("barrier timeout: " + file);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  await waitFor(start);
  const lock = acquireStorageTransactionLock({ sourceRoot: root });
  fs.writeFileSync(acquired, String(process.pid) + "\\n");
  await waitFor(release);
  lock.markParticipationReady();
  lock.release();
  fs.writeFileSync(result, JSON.stringify({ ok: true, pid: process.pid }) + "\\n");
} catch (error) {
  fs.writeFileSync(result, JSON.stringify({
    ok: false,
    code: error && typeof error === "object" && "code" in error ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  }) + "\\n");
  process.exitCode = 1;
}
`);
  return spawn(process.execPath, [tsxPath, script], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("storage transaction artifact contract", () => {
  it("reserves every protocol artifact under one prefix", () => {
    for (const suffix of [
      "owner",
      "owner.tmp.token",
      "recovery",
      "quarantine.token",
      "release.token",
      "marker",
      "marker.tmp.token",
    ]) {
      expect(isStorageTransactionReservedArtifact(`${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}${suffix}`)).toBe(true);
    }
    expect(isStorageTransactionReservedArtifact("paperclip-20260911-120000.sql.gz")).toBe(false);
  });

  it("publishes a complete owner and changes participation from active to ready", () => {
    const root = tempDir("paperclip-stx-basic-");
    const current = identity({ pid: 4101, processStartId: "start-4101" });
    const lock = acquireStorageTransactionLock({ sourceRoot: root, deps: deps(current) });

    expect(lock.record).toMatchObject({
      schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
      ...current,
      token: "token-4101",
      operationKind: "database-backup",
    });
    expect(readStorageTransactionParticipationMarker(root)).toMatchObject({
      state: "active",
      token: "token-4101",
    });

    lock.markParticipationReady();
    lock.release();
    expect(fs.existsSync(ownerPath(root))).toBe(false);
    expect(readStorageTransactionParticipationMarker(root)).toMatchObject({
      state: "ready",
      token: "token-4101",
    });
  });

  it("never steals a live owner based on age", () => {
    const root = tempDir("paperclip-stx-live-");
    writeOwner(root, record({ acquiredAt: "2000-01-01T00:00:00.000Z" }));

    expect(() => acquireStorageTransactionLock({
      sourceRoot: root,
      deps: deps(identity({ pid: 4200 }), { checkLiveness: () => ({ status: "alive" }) }),
    })).toThrow(StorageTransactionBusyError);
    expect(JSON.parse(fs.readFileSync(ownerPath(root), "utf8")).token).toBe("existing-token");
  });

  it("recovers one confirmed dead local owner under the recovery mutex", () => {
    const root = tempDir("paperclip-stx-dead-");
    writeOwner(root, record({ pid: 1, processStartId: "dead-start" }));
    const current = identity({ pid: 4201, processStartId: "start-4201" });
    const lock = acquireStorageTransactionLock({
      sourceRoot: root,
      deps: deps(current, {
        checkLiveness: (observed) => observed.token === "existing-token"
          ? { status: "dead" }
          : { status: "alive" },
      }),
    });
    expect(lock.token).toBe("token-4201");
    expect(JSON.parse(fs.readFileSync(ownerPath(root), "utf8")).token).toBe("token-4201");
    lock.release();
  });

  it("does not let an old handle remove a replacement owner", () => {
    const root = tempDir("paperclip-stx-replaced-");
    const first = acquireStorageTransactionLock({
      sourceRoot: root,
      deps: deps(identity({ pid: 4301, processStartId: "first" }), { createToken: () => "first-token" }),
    });
    const second = acquireStorageTransactionLock({
      sourceRoot: root,
      deps: deps(identity({ pid: 4302, processStartId: "second" }), {
        createToken: () => "second-token",
        checkLiveness: (observed) => observed.token === "first-token"
          ? { status: "dead" }
          : { status: "alive" },
      }),
    });

    first.release();
    expect(JSON.parse(fs.readFileSync(ownerPath(root), "utf8")).token).toBe("second-token");
    second.release();
  });

  it("fails closed for malformed, foreign, EPERM, and unknown owner evidence", () => {
    for (const status of ["foreign_machine", "eperm", "unreadable"] as const) {
      const root = tempDir(`paperclip-stx-${status}-`);
      writeOwner(root, record());
      expect(() => acquireStorageTransactionLock({
        sourceRoot: root,
        deps: deps(identity({ pid: 4400 }), { checkLiveness: () => ({ status }) }),
      })).toThrow(StorageTransactionBlockedError);
    }

    const malformed = tempDir("paperclip-stx-malformed-");
    fs.writeFileSync(ownerPath(malformed), "{not-json\n");
    expect(() => acquireStorageTransactionLock({ sourceRoot: malformed, deps: deps(identity()) }))
      .toThrow(StorageTransactionBlockedError);
  });

  it("treats reboot and PID-reuse evidence as dead", () => {
    const current = identity({ pid: process.pid, processStartId: "current", bootId: "boot-new" });
    expect(checkStorageTransactionLiveness(record({
      pid: current.pid,
      bootId: current.bootId,
      processStartId: current.processStartId,
    }), current)).toEqual({ status: "alive" });
    expect(checkStorageTransactionLiveness(record({ bootId: "boot-old" }), current)).toEqual({ status: "dead" });
    expect(checkStorageTransactionLiveness(record({ pid: current.pid, bootId: current.bootId }), current))
      .toEqual({ status: "dead" });
  });

  it("ignores an incomplete temp publication and acquires through the canonical hard link", () => {
    const root = tempDir("paperclip-stx-half-");
    fs.writeFileSync(
      path.join(root, `${STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX}owner.tmp.crashed`),
      "partial\n",
    );
    const lock = acquireStorageTransactionLock({
      sourceRoot: root,
      deps: deps(identity({ pid: 4500, processStartId: "start-4500" })),
    });
    expect(lock.assertOwned().token).toBe("token-4500");
    lock.release();
  });
});

describe("storage transaction cross-process exclusion", () => {
  it("allows exactly one overlapping child into the transaction", async () => {
    expect(fs.existsSync(tsxPath)).toBe(true);
    const root = tempDir("paperclip-stx-process-");
    const start = path.join(root, "start.barrier");
    const release = path.join(root, "release.barrier");
    const acquiredA = path.join(root, "acquired-a.barrier");
    const acquiredB = path.join(root, "acquired-b.barrier");
    const resultA = path.join(root, "result-a.json");
    const resultB = path.join(root, "result-b.json");
    const childA = spawnLockChild({ root, start, acquired: acquiredA, release, result: resultA, name: "a" });
    const childB = spawnLockChild({ root, start, acquired: acquiredB, release, result: resultB, name: "b" });

    fs.writeFileSync(start, "go\n");
    await Promise.race([waitFor(acquiredA), waitFor(acquiredB)]);
    await waitForAny([resultA, resultB]);
    fs.writeFileSync(release, "go\n");
    await Promise.all([childExit(childA), childExit(childB)]);

    const results = [resultA, resultB].map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "STORAGE_TRANSACTION_BUSY")).toHaveLength(1);
  }, 30_000);

  it("recovers a child owner after abrupt process death", async () => {
    expect(fs.existsSync(tsxPath)).toBe(true);
    const root = tempDir("paperclip-stx-death-");
    const start = path.join(root, "start.barrier");
    const acquired = path.join(root, "acquired.barrier");
    const release = path.join(root, "release.barrier");
    const result = path.join(root, "result.json");
    const child = spawnLockChild({ root, start, acquired, release, result, name: "death" });

    fs.writeFileSync(start, "go\n");
    await waitFor(acquired);
    const ownerPid = Number(fs.readFileSync(acquired, "utf8").trim());
    process.kill(ownerPid, "SIGKILL");
    await waitForPidExit(ownerPid);
    if (child.pid !== ownerPid && child.exitCode == null) child.kill("SIGKILL");
    await childExit(child);

    const recovered = acquireStorageTransactionLock({ sourceRoot: root });
    expect(recovered.assertOwned().pid).toBe(process.pid);
    recovered.markParticipationReady();
    recovered.release();
  }, 30_000);
});
