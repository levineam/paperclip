import type { IssueStatus } from "@paperclipai/shared"

export const statusOrder: IssueStatus[] = [
  "in_progress",
  "todo",
  "backlog",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]

export const boardStatuses: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
