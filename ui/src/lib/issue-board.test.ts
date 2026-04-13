import { describe, expect, it } from "vitest"
import { shouldShowBoardProjectChip, sortBoardIssues } from "./issue-board"
import type { Issue } from "@paperclipai/shared"

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    companyId: "company-1",
    projectId: overrides.projectId ?? null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: overrides.title ?? "Issue",
    description: null,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: overrides.identifier ?? null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: overrides.createdAt ?? new Date("2026-04-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-01T00:00:00Z"),
  }
}

describe("sortBoardIssues", () => {
  it("sorts by priority with critical first in ascending order", () => {
    const issues = [
      makeIssue({ id: "medium", priority: "medium" }),
      makeIssue({ id: "critical", priority: "critical" }),
      makeIssue({ id: "low", priority: "low" }),
    ]

    expect(sortBoardIssues(issues, "priority", "asc").map((issue) => issue.id)).toEqual([
      "critical",
      "medium",
      "low",
    ])
  })

  it("sorts by updated timestamp descending", () => {
    const issues = [
      makeIssue({ id: "older", updatedAt: new Date("2026-04-01T00:00:00Z") }),
      makeIssue({ id: "newer", updatedAt: new Date("2026-04-02T00:00:00Z") }),
    ]

    expect(sortBoardIssues(issues, "updated", "desc").map((issue) => issue.id)).toEqual([
      "newer",
      "older",
    ])
  })
})

describe("shouldShowBoardProjectChip", () => {
  it("returns false for project-scoped boards", () => {
    const issues = [makeIssue({ projectId: "project-1" })]
    expect(shouldShowBoardProjectChip(issues, "project-1")).toBe(false)
  })

  it("returns true when the board spans multiple projects", () => {
    const issues = [
      makeIssue({ projectId: "project-1" }),
      makeIssue({ projectId: "project-2" }),
    ]

    expect(shouldShowBoardProjectChip(issues)).toBe(true)
  })

  it("returns false when all visible issues share one project", () => {
    const issues = [
      makeIssue({ projectId: "project-1" }),
      makeIssue({ projectId: "project-1" }),
    ]

    expect(shouldShowBoardProjectChip(issues)).toBe(false)
  })
})
