import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  // Same runId contract as the real adapter execution context (heartbeat passes run.id).
  vi.fn(async (_ctx: { runId: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// Teardown quiescence accounting over the two real dependencies that bracket
// heartbeat's only detached work. Every `void executeRun(...)` is spawned inside a
// withAgentStartLock section (startNextQueuedRunForAgent returns the claimed runs),
// and every executeRun that reaches its outer finally awaits
// releaseRuntimeServicesForRun before its final startNextQueuedRunForAgent tail,
// which takes the start lock again. Both mocks delegate to the real implementations;
// holds are used only by the dedicated drain regression case.
const runAccounting = vi.hoisted(() => {
  type Gate = { promise: Promise<void>; resolve: () => void };
  const gate = (): Gate => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  type Hold = { reached: Gate; release: Gate };
  const activeHolds = new Set<Hold>();
  // Run-keyed adapter barriers for the drain regression case; created lazily by
  // whichever comes first, the adapter entry or the test, so no entry is lost.
  type AdapterGate = { entered: Gate; release: Gate };
  const adapterGates = new Map<string, AdapterGate>();
  const enteredRunIds = new Set<string>();
  return {
    lockInFlight: 0,
    releaseInFlight: 0,
    // Monotonic: bumped on every start-lock entry and every runtime-release completion.
    generation: 0,
    spawned: new Set<string>(),
    released: new Set<string>(),
    releaseHolds: new Map<string, Hold>(),
    nextLockHold: null as Hold | null,
    enteredRunIds,
    adapterGate(runId: string): AdapterGate {
      let existing = adapterGates.get(runId);
      if (!existing) {
        existing = { entered: gate(), release: gate() };
        adapterGates.set(runId, existing);
      }
      return existing;
    },
    hold(): Hold {
      const created = { reached: gate(), release: gate() };
      activeHolds.add(created);
      return created;
    },
    releaseAllHolds(): void {
      for (const held of activeHolds) held.release.resolve();
      for (const adapterGate of adapterGates.values()) adapterGate.release.resolve();
    },
    clearHolds(): void {
      activeHolds.clear();
      adapterGates.clear();
      enteredRunIds.clear();
    },
  };
});

vi.mock("../services/agent-start-lock.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-start-lock.ts")>(
    "../services/agent-start-lock.ts",
  );
  return {
    ...actual,
    withAgentStartLock: async <T>(agentId: string, fn: () => Promise<T>): Promise<T> => {
      runAccounting.generation += 1;
      runAccounting.lockInFlight += 1;
      try {
        const held = runAccounting.nextLockHold;
        runAccounting.nextLockHold = null;
        const result = await actual.withAgentStartLock(agentId, async () => {
          if (held) {
            held.reached.resolve();
            await held.release.promise;
          }
          return fn();
        });
        // Runs returned by startNextQueuedRunForAgent each had executeRun spawned.
        if (Array.isArray(result)) {
          for (const row of result) {
            const id = (row as { id?: unknown } | null)?.id;
            if (typeof id === "string") runAccounting.spawned.add(id);
          }
        }
        return result;
      } finally {
        runAccounting.lockInFlight -= 1;
      }
    },
  };
});

vi.mock("../services/workspace-runtime.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/workspace-runtime.ts")>(
    "../services/workspace-runtime.ts",
  );
  return {
    ...actual,
    releaseRuntimeServicesForRun: async (runId: string) => {
      // A held run models executeRun still finalizing after its terminal status:
      // not yet an in-flight release and not yet released.
      const held = runAccounting.releaseHolds.get(runId);
      if (held) {
        held.reached.resolve();
        await held.release.promise;
      }
      runAccounting.releaseInFlight += 1;
      try {
        return await actual.releaseRuntimeServicesForRun(runId);
      } finally {
        runAccounting.released.add(runId);
        runAccounting.releaseInFlight -= 1;
        runAccounting.generation += 1;
      }
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function heartbeatRunsIdle(db: ReturnType<typeof createDb>) {
  const runs = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns);
  return !runs.some((run) => run.status === "queued" || run.status === "running");
}

/**
 * Quiescent only when no run is queued/running, no start-lock section or runtime
 * release is in flight, every spawned execution has reached its release, and the
 * activity generation is unchanged across this sample's DB await. A release
 * resumes into its start-lock tail without I/O, so a release that finished before
 * the await bumps the generation again (tail entry) before the await completes.
 */
async function heartbeatSettled(db: ReturnType<typeof createDb>) {
  const generationBefore = runAccounting.generation;
  const idle = await heartbeatRunsIdle(db);
  const accounted = runAccounting.lockInFlight === 0 && runAccounting.releaseInFlight === 0 && [...runAccounting.spawned].every((runId) => runAccounting.released.has(runId));
  const stable = runAccounting.generation === generationBefore;
  return idle && accounted && stable;
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    // Never strand teardown on a regression-case hold; data cleanup waits for quiescence.
    runAccounting.releaseAllHolds();
    let idlePolls = 0;
    let idleGeneration = -1;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const generation = runAccounting.generation;
      if (await heartbeatSettled(db)) {
        // All counted polls must observe one unchanged generation.
        if (idlePolls > 0 && generation !== idleGeneration) idlePolls = 0;
        if (idlePolls === 0) idleGeneration = generation;
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Final synchronous check: nothing ran since the last counted poll.
    if (
      idlePolls < 3
      || runAccounting.generation !== idleGeneration
      || runAccounting.lockInFlight !== 0
      || runAccounting.releaseInFlight !== 0
    ) {
      throw new Error("Heartbeat work did not quiesce before teardown; refusing to delete fixture rows");
    }
    runAccounting.spawned.clear();
    runAccounting.released.clear();
    runAccounting.releaseHolds.clear();
    runAccounting.nextLockHold = null;
    runAccounting.clearHolds();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId: randomUUID() },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, interactionWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("waits for post-terminal finalization and follow-on queued starts before teardown", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const finalizingIssueId = randomUUID();
    const runningIssueId = randomUUID();
    const queuedIssueId = randomUUID();
    const adapterResult = (summary: string) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary,
      provider: "test",
      model: "test-model",
    });
    // The previous afterEach has drained; start this case with no adapter call history.
    // Every adapter entry is held on its own runId; afterEach's mockReset removes this
    // implementation and its hold release frees any entry still waiting.
    mockAdapterExecute.mockClear();
    mockAdapterExecute.mockImplementation(async (ctx: { runId: string }) => {
      if (typeof ctx?.runId !== "string" || ctx.runId.length === 0) {
        throw new Error("Adapter invoked without a runId");
      }
      const adapterGate = runAccounting.adapterGate(ctx.runId);
      runAccounting.enteredRunIds.add(ctx.runId);
      adapterGate.entered.resolve();
      await adapterGate.release.promise;
      return adapterResult(`Run ${ctx.runId} completed.`);
    });
    const adapterEntered = (runId: string) => runAccounting.adapterGate(runId).entered.promise;
    const finishAdapter = (runId: string) => runAccounting.adapterGate(runId).release.resolve();
    const expectEnteredRuns = (runIds: string[]) =>
      expect([...runAccounting.enteredRunIds].sort()).toEqual([...runIds].sort());

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      { id: finalizingIssueId, companyId, title: "Finalizing assignment", status: "todo", priority: "high", assigneeAgentId: agentId },
      { id: runningIssueId, companyId, title: "Running assignment", status: "todo", priority: "high", assigneeAgentId: agentId },
      { id: queuedIssueId, companyId, title: "Queued assignment", status: "todo", priority: "high", assigneeAgentId: agentId },
    ]);
    const assign = (issueId: string) => heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    const runStatus = (runId: string) => db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);

    try {
      // Phase 1: the only run is terminal but still finalizing (held before its
      // runtime release). Statuses alone are idle; the drain must not settle.
      const finalizingHold = runAccounting.hold();
      const finalizingWake = await assign(finalizingIssueId);
      expect(finalizingWake).not.toBeNull();
      // Same as the original maxConcurrentRuns case: the run's own issue comment
      // satisfies the comment policy, so no missing-comment retry is queued.
      await db.insert(issueComments).values({
        companyId,
        issueId: finalizingIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: finalizingWake!.id,
        body: "Finalizing assignment run completed.",
      });
      runAccounting.releaseHolds.set(finalizingWake!.id, finalizingHold);
      await adapterEntered(finalizingWake!.id);
      expectEnteredRuns([finalizingWake!.id]);
      // Real terminal task disposition before the run finishes: a done issue is a valid
      // disposition, so no successful-run handoff is queued (successful-run-handoff.ts:375).
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, finalizingIssueId));
      finishAdapter(finalizingWake!.id);
      await finalizingHold.reached.promise;

      expect(await runStatus(finalizingWake!.id)).toBe("succeeded");
      expect(await heartbeatRunsIdle(db)).toBe(true);
      expect(runAccounting.spawned.has(finalizingWake!.id)).toBe(true);
      expect(runAccounting.lockInFlight).toBe(0);
      expect(runAccounting.releaseInFlight).toBe(0);
      expect(await heartbeatSettled(db)).toBe(false);
      // Fixture-created post-terminal write in the finalization window (real FK row).
      // This proves the drain covers that window; it does not attribute the CI comment.
      await db.insert(issueComments).values({
        companyId,
        issueId: finalizingIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: finalizingWake!.id,
        body: "Late finalization write.",
      });

      // Phase 1b: release finishes, the start-lock tail is held. Statuses idle,
      // release accounted; only the in-flight tail keeps the drain open.
      const tailHold = runAccounting.hold();
      runAccounting.nextLockHold = tailHold;
      const generationBeforeRelease = runAccounting.generation;
      finalizingHold.release.resolve();
      await tailHold.reached.promise;
      // Release completion and tail lock entry each advanced the generation.
      expect(runAccounting.generation).toBeGreaterThanOrEqual(generationBeforeRelease + 2);
      expect(runAccounting.released.has(finalizingWake!.id)).toBe(true);
      expect(runAccounting.releaseInFlight).toBe(0);
      expect(await heartbeatRunsIdle(db)).toBe(true);
      expect(await heartbeatSettled(db)).toBe(false);
      tailHold.release.resolve();
      expect(await waitForCondition(() => heartbeatSettled(db), 10_000)).toBe(true);
      expectEnteredRuns([finalizingWake!.id]);

      // Phase 2: a queued run is started by the finishing run's tail and is itself
      // held after its terminal status. Once statuses are idle again, only the
      // tail-spawned, not-yet-released execution keeps the drain open.
      const runningWake = await assign(runningIssueId);
      expect(runningWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: runningIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: runningWake!.id,
        body: "Running assignment run completed.",
      });
      await adapterEntered(runningWake!.id);
      expectEnteredRuns([finalizingWake!.id, runningWake!.id]);
      expect(await runStatus(runningWake!.id)).toBe("running");
      const queuedWake = await assign(queuedIssueId);
      expect(queuedWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: queuedIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: queuedWake!.id,
        body: "Queued assignment run completed.",
      });
      expect(await runStatus(queuedWake!.id)).toBe("queued");
      expect(runAccounting.spawned.has(queuedWake!.id)).toBe(false);
      const followOnHold = runAccounting.hold();
      runAccounting.releaseHolds.set(queuedWake!.id, followOnHold);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, runningIssueId));
      finishAdapter(runningWake!.id);
      // The finishing run's start-lock tail claims the queued run; once it is running,
      // complete its issue too before letting its adapter finish.
      await adapterEntered(queuedWake!.id);
      expectEnteredRuns([finalizingWake!.id, runningWake!.id, queuedWake!.id]);
      expect(await runStatus(queuedWake!.id)).toBe("running");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, queuedIssueId));
      finishAdapter(queuedWake!.id);
      await followOnHold.reached.promise;

      expect(await runStatus(runningWake!.id)).toBe("succeeded");
      expect(await runStatus(queuedWake!.id)).toBe("succeeded");
      expect(await heartbeatRunsIdle(db)).toBe(true);
      expect(runAccounting.spawned.has(queuedWake!.id)).toBe(true);
      expect(runAccounting.released.has(queuedWake!.id)).toBe(false);
      expect(runAccounting.lockInFlight).toBe(0);
      expect(runAccounting.releaseInFlight).toBe(0);
      expect(await heartbeatSettled(db)).toBe(false);
      await db.insert(issueComments).values({
        companyId,
        issueId: queuedIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: queuedWake!.id,
        body: "Late follow-on finalization write.",
      });
      followOnHold.release.resolve();
      expect(await waitForCondition(() => heartbeatSettled(db), 10_000)).toBe(true);
      expectEnteredRuns([finalizingWake!.id, runningWake!.id, queuedWake!.id]);
    } finally {
      runAccounting.releaseAllHolds();
    }
  }, 40_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });
});
