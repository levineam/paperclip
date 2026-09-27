import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORAGE_TRANSACTION_LOCK_DIR_NAME,
  STORAGE_TRANSACTION_LOCK_SCHEMA,
  STORAGE_TRANSACTION_PARTICIPATION_NAME,
  STORAGE_TRANSACTION_RESERVED_PREFIX,
  StorageTransactionLockError,
  acquireStorageTransactionLock,
  assertStorageTransactionLockHeld,
  checkStorageTransactionLiveness,
  isStorageTransactionReservedName,
  parseStorageTransactionOwnerRecord,
  readLocalBootId,
  readLocalMachineId,
  readProcessStartId,
  readStorageTransactionParticipation,
  releaseStorageTransactionLock,
  resolveSourceRootRealPath,
  type StorageTransactionOwnerRecord,
} from "./backup-transaction-lock.js";

const cleanupRoots: string[] = [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.resolve(packageRoot, "src/backup-transaction-lock.ts");
const tsxPath = path.resolve(packageRoot, "node_modules/tsx/dist/cli.mjs");

afterEach(() => {
  while (cleanupRoots.length > 0) {
    fs.rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

function writeOwner(root: string, overrides: Record<string, unknown> = {}) {
  const realRoot = resolveSourceRootRealPath(root);
  const ownerPath = path.join(realRoot, STORAGE_TRANSACTION_LOCK_DIR_NAME);
  const owner = {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    token: "FAKESECRET_g1h2i3j4k5l6m7n8o9p0",
    machineId: readLocalMachineId(),
    bootId: readLocalBootId(),
    pid: 2_147_483_646,
    processStartId: "dead-process-start-id",
    operationKind: "backup",
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return owner;
}

function ownerRecord(overrides: Partial<StorageTransactionOwnerRecord> = {}): StorageTransactionOwnerRecord {
  return {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    token: "existing-token",
    machineId: "machine-a",
    bootId: "boot-a",
    pid: 4100,
    processStartId: "start-4100",
    operationKind: "backup",
    acquiredAt: "2026-09-11T11:00:00.000Z",
    ...overrides,
  };
}

function expectLockErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected StorageTransactionLockError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(StorageTransactionLockError);
    expect((error as StorageTransactionLockError).code).toBe(code);
  }
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
import { acquireStorageTransactionLock, releaseStorageTransactionLock } from ${JSON.stringify(modulePath)};
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
  const lock = acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" });
  fs.writeFileSync(acquired, String(process.pid) + "\\n");
  await waitFor(release);
  releaseStorageTransactionLock(lock);
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

describe("paperclip.storage-transaction-lock/v1", () => {
  it("acquires, holds, and token-safely releases a source-root lock", () => {
    const root = tempDir("paperclip-tx-lock-basic-");
    const handle = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });

    expect(handle.token.length).toBeGreaterThanOrEqual(16);
    expect(fs.existsSync(handle.ownerPath)).toBe(true);
    expect(path.basename(handle.ownerPath)).toBe(".paperclip-stx-owner");
    expect(path.basename(handle.participationPath)).toBe(".paperclip-stx-marker");
    assertStorageTransactionLockHeld(handle);

    const participation = readStorageTransactionParticipation(root);
    expect(participation?.state).toBe("active");
    expect(participation?.schema).toBe(STORAGE_TRANSACTION_LOCK_SCHEMA);

    releaseStorageTransactionLock(handle);
    expect(fs.existsSync(handle.ownerPath)).toBe(false);
    expect(readStorageTransactionParticipation(root)?.state).toBe("ready");
  });

  it("returns busy when a live local owner already holds the lock", () => {
    const root = tempDir("paperclip-tx-lock-busy-");
    const first = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });

    try {
      expect(() =>
        acquireStorageTransactionLock({
          sourceRoot: root,
          operationKind: "raid-archive",
        }),
      ).toThrow(StorageTransactionLockError);

      try {
        acquireStorageTransactionLock({
          sourceRoot: root,
          operationKind: "raid-archive",
        });
        expect.unreachable("second acquire should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageTransactionLockError);
        expect((error as StorageTransactionLockError).code).toBe("busy");
      }
    } finally {
      releaseStorageTransactionLock(first);
    }
  });

  it("emits a clawd-compatible owner and participation fixture shape", () => {
    const root = tempDir("paperclip-tx-lock-fixture-");
    const handle = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });
    const raw = JSON.parse(fs.readFileSync(handle.ownerPath, "utf8"));
    const parsed = parseStorageTransactionOwnerRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.schema).toBe(STORAGE_TRANSACTION_LOCK_SCHEMA);
    expect(parsed!.token).toBe(handle.token);
    expect(Object.keys(parsed!).sort()).toEqual([
      "acquiredAt",
      "bootId",
      "machineId",
      "operationKind",
      "pid",
      "processStartId",
      "schema",
      "token",
    ]);
    expect(Object.keys(readStorageTransactionParticipation(root)!).sort()).toEqual([
      "schema",
      "state",
      "token",
      "updatedAt",
    ]);
    releaseStorageTransactionLock(handle);
  });

  it("recovers a confirmed dead local owner exactly once under the recovery mutex", () => {
    const root = tempDir("paperclip-tx-lock-dead-");
    writeOwner(root, {
      machineId: readLocalMachineId(),
      bootId: readLocalBootId(),
      pid: 2_147_483_646,
      processStartId: "dead-process-start-id",
    });

    const recovered = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
      allowDeadOwnerRecovery: true,
    });
    expect(recovered.token).not.toBe("deadtoken0123456789abcdef012345");
    expect(recovered.owner.bootId).toBe(readLocalBootId());
    expect(recovered.owner.processStartId).toBe(readProcessStartId());
    assertStorageTransactionLockHeld(recovered);
    releaseStorageTransactionLock(recovered);
  });

  it("refuses a foreign-machine owner without recovery", () => {
    const root = tempDir("paperclip-tx-lock-foreign-");
    writeOwner(root, { machineId: "foreign-machine-id-not-local" });
    try {
      acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" });
      expect.unreachable("foreign owner should block");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageTransactionLockError);
      expect((error as StorageTransactionLockError).code).toBe("foreign_owner");
    }
  });

  it("refuses to release when the caller token no longer matches", () => {
    const root = tempDir("paperclip-tx-lock-token-");
    const first = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });
    const secondRoot = tempDir("paperclip-tx-lock-token-2-");
    // Replace owner under recovery by releasing and reacquiring, then forge handle.
    const handle = acquireStorageTransactionLock({
      sourceRoot: secondRoot,
      operationKind: "backup",
    });
    const forged = {
      ...handle,
      token: "FAKESECRET_g2h3i4j5k6l7m8n9o0p1",
    };
    expect(() => releaseStorageTransactionLock(forged)).toThrow(StorageTransactionLockError);
    releaseStorageTransactionLock(handle);
    releaseStorageTransactionLock(first);
  });

  it("excludes reserved protocol artifact names", () => {
    expect(isStorageTransactionReservedName(STORAGE_TRANSACTION_LOCK_DIR_NAME)).toBe(true);
    expect(isStorageTransactionReservedName(STORAGE_TRANSACTION_PARTICIPATION_NAME)).toBe(true);
    expect(isStorageTransactionReservedName(`${STORAGE_TRANSACTION_RESERVED_PREFIX}owner.tmp.x`)).toBe(true);
    expect(isStorageTransactionReservedName("paperclip-20260911-120000.sql.gz")).toBe(false);
  });

  it("never steals a live owner based on age", () => {
    const root = tempDir("paperclip-tx-lock-live-aged-");
    const owner = writeOwner(root, {
      token: "existing-token",
      pid: process.pid,
      processStartId: readProcessStartId(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(path.join(root, STORAGE_TRANSACTION_LOCK_DIR_NAME), "utf8");

    expectLockErrorCode(
      () => acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" }),
      "busy",
    );
    const after = fs.readFileSync(path.join(root, STORAGE_TRANSACTION_LOCK_DIR_NAME), "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after).token).toBe(owner.token);
  });

  it("fails closed on malformed owner evidence without replacing it", () => {
    const cases: Array<[string, string]> = [
      ["invalid-json", "{not-json\n"],
      ["wrong-schema", `${JSON.stringify({ ...ownerRecord(), schema: "paperclip.storage-transaction-lock/v0" })}\n`],
      ["missing-identity", `${JSON.stringify({ ...ownerRecord(), processStartId: "" })}\n`],
    ];
    for (const [name, contents] of cases) {
      const root = tempDir(`paperclip-tx-lock-malformed-${name}-`);
      const ownerPath = path.join(resolveSourceRootRealPath(root), STORAGE_TRANSACTION_LOCK_DIR_NAME);
      fs.writeFileSync(ownerPath, contents, { mode: 0o600 });

      expectLockErrorCode(
        () => acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" }),
        "malformed",
      );
      expect(fs.readFileSync(ownerPath, "utf8")).toBe(contents);
    }
  });

  it("treats reboot and PID-reuse evidence as dead", () => {
    const current = {
      machineId: "machine-a",
      bootId: "boot-new",
      pid: process.pid,
      processStartId: "current",
    };
    expect(checkStorageTransactionLiveness(ownerRecord({
      pid: current.pid,
      bootId: current.bootId,
      processStartId: current.processStartId,
    }), current)).toBe("alive");
    expect(checkStorageTransactionLiveness(ownerRecord({ bootId: "boot-old" }), current)).toBe("dead");
    expect(checkStorageTransactionLiveness(ownerRecord({ pid: current.pid, bootId: current.bootId }), current))
      .toBe("dead");
    expect(checkStorageTransactionLiveness(ownerRecord({ machineId: "machine-b" }), current))
      .toBe("foreign_machine");
  });

  it("ignores half-written temp artifacts and acquires through the canonical hard link", () => {
    const root = tempDir("paperclip-tx-lock-half-");
    const realRoot = resolveSourceRootRealPath(root);
    const halfWritten = [
      path.join(realRoot, `${STORAGE_TRANSACTION_RESERVED_PREFIX}owner.tmp.crashed`),
      path.join(realRoot, `${STORAGE_TRANSACTION_RESERVED_PREFIX}recovery.tmp.crashed`),
      path.join(realRoot, `${STORAGE_TRANSACTION_RESERVED_PREFIX}marker.tmp.crashed`),
    ];
    for (const filePath of halfWritten) fs.writeFileSync(filePath, "partial\n");

    const handle = acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" });
    try {
      expect(assertStorageTransactionLockHeld(handle).token).toBe(handle.token);
      expect(JSON.parse(fs.readFileSync(handle.ownerPath, "utf8")).token).toBe(handle.token);
      expect(readStorageTransactionParticipation(root)).toMatchObject({ state: "active", token: handle.token });
      for (const filePath of halfWritten) {
        expect(fs.readFileSync(filePath, "utf8")).toBe("partial\n");
      }
    } finally {
      releaseStorageTransactionLock(handle);
    }
    expect(readStorageTransactionParticipation(root)).toMatchObject({ state: "ready", token: handle.token });
  });
});

describe("storage transaction cross-process exclusion", () => {
  it("allows exactly one overlapping child into the transaction", async () => {
    expect(fs.existsSync(tsxPath)).toBe(true);
    const root = tempDir("paperclip-tx-lock-process-");
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
    expect(results.filter((result) => result.code === "busy")).toHaveLength(1);
    expect(fs.existsSync(path.join(root, STORAGE_TRANSACTION_LOCK_DIR_NAME))).toBe(false);
    expect(readStorageTransactionParticipation(root)?.state).toBe("ready");
  }, 30_000);

  it("recovers a child owner after abrupt process death", async () => {
    expect(fs.existsSync(tsxPath)).toBe(true);
    const root = tempDir("paperclip-tx-lock-death-");
    const start = path.join(root, "start.barrier");
    const acquired = path.join(root, "acquired.barrier");
    const release = path.join(root, "release.barrier");
    const result = path.join(root, "result.json");
    const child = spawnLockChild({ root, start, acquired, release, result, name: "death" });

    fs.writeFileSync(start, "go\n");
    await waitFor(acquired);
    const ownerPid = Number(fs.readFileSync(acquired, "utf8").trim());
    const deadToken = JSON.parse(
      fs.readFileSync(path.join(resolveSourceRootRealPath(root), STORAGE_TRANSACTION_LOCK_DIR_NAME), "utf8"),
    ).token;
    process.kill(ownerPid, "SIGKILL");
    await waitForPidExit(ownerPid);
    if (child.pid !== ownerPid && child.exitCode == null) child.kill("SIGKILL");
    await childExit(child);
    expect(readStorageTransactionParticipation(root)?.state).toBe("active");

    const recovered = acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" });
    try {
      expect(recovered.token).not.toBe(deadToken);
      expect(recovered.recoveries).toHaveLength(1);
      expect(recovered.recoveries?.[0]).toMatchObject({ classification: "dead_local", recoveredToken: deadToken });
      expect(assertStorageTransactionLockHeld(recovered).pid).toBe(process.pid);
    } finally {
      releaseStorageTransactionLock(recovered);
    }
    expect(readStorageTransactionParticipation(root)).toMatchObject({ state: "ready", token: recovered.token });
  }, 30_000);
});
