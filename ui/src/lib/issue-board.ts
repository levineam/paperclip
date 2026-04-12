import type { Issue } from "@paperclipai/shared"

const priorityOrder = ["critical", "high", "medium", "low"] as const

export type BoardSortField = "priority" | "title" | "created" | "updated"
export type SortDirection = "asc" | "desc"

export function sortBoardIssues(issues: Issue[], field: BoardSortField, dir: SortDirection): Issue[] {
  const sorted = [...issues]
  const direction = dir === "asc" ? 1 : -1

  sorted.sort((a, b) => {
    switch (field) {
      case "priority":
        return direction * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority))
      case "title":
        return direction * a.title.localeCompare(b.title)
      case "created":
        return direction * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      case "updated":
        return direction * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      default:
        return 0
    }
  })

  return sorted
}

export function shouldShowBoardProjectChip(issues: Issue[], projectId?: string): boolean {
  if (projectId) return false

  const visibleProjectIds = new Set(
    issues
      .map((issue) => issue.projectId)
      .filter((value): value is string => Boolean(value)),
  )

  return visibleProjectIds.size > 1
}
