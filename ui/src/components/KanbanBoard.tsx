import { useMemo, useState } from "react"
import { Link } from "@/lib/router"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core"
import { useDroppable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { User } from "lucide-react"
import { formatAssigneeUserLabel } from "@/lib/assignees"
import { boardStatuses, statusLabel } from "@/lib/issue-status"
import { StatusIcon } from "./StatusIcon"
import { PriorityIcon } from "./PriorityIcon"
import { Identity } from "./Identity"
import type { Issue } from "@paperclipai/shared"

interface Agent {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  projects?: ProjectOption[];
  currentUserId?: string | null;
  showProjectNames?: boolean;
  liveIssueIds?: Set<string>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

function KanbanColumn({
  status,
  issues,
  agents,
  projects,
  currentUserId,
  showProjectNames,
  liveIssueIds,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  projects?: ProjectOption[];
  currentUserId?: string | null;
  showProjectNames?: boolean;
  liveIssueIds?: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <div className="flex flex-col min-w-[260px] w-[260px] shrink-0">
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              projects={projects}
              currentUserId={currentUserId}
              showProjectName={showProjectNames}
              isLive={liveIssueIds?.has(issue.id)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

function KanbanCard({
  issue,
  agents,
  projects,
  currentUserId,
  showProjectName,
  isLive,
  isOverlay,
}: {
  issue: Issue;
  agents?: Agent[];
  projects?: ProjectOption[];
  currentUserId?: string | null;
  showProjectName?: boolean;
  isLive?: boolean;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const agentName = (id: string | null) => {
    if (!id || !agents) return null
    return agents.find((a) => a.id === id)?.name ?? null
  }

  const projectName = issue.project?.name
    ?? (issue.projectId ? projects?.find((project) => project.id === issue.projectId)?.name ?? null : null)

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => {
          if (isDragging) e.preventDefault()
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          {showProjectName && projectName && (
            <span className="ml-auto rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {projectName}
            </span>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          <span className="ml-auto min-w-0">
            {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
              <Identity name={agentName(issue.assigneeAgentId)!} size="xs" className="max-w-[140px]" />
            ) : issue.assigneeUserId ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                  <User className="h-3 w-3" />
                </span>
                <span className="truncate max-w-[110px]">
                  {formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                  <User className="h-3 w-3" />
                </span>
                Unassigned
              </span>
            )}
          </span>
        </div>
      </Link>
    </div>
  )
}

export function KanbanBoard({
  issues,
  agents,
  projects,
  currentUserId,
  showProjectNames,
  liveIssueIds,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {}
    for (const status of boardStatuses) {
      grouped[status] = []
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue)
      }
    }
    return grouped
  }, [issues])

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  )

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const issueId = active.id as string
    const issue = issues.find((i) => i.id === issueId)
    if (!issue) return

    let targetStatus: string | null = null

    if (boardStatuses.includes(over.id as Issue["status"])) {
      targetStatus = over.id as string
    } else {
      const targetIssue = issues.find((i) => i.id === over.id)
      if (targetIssue) {
        targetStatus = targetIssue.status
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus })
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Keeping hover behavior minimal in phase 1.
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            projects={projects}
            currentUserId={currentUserId}
            showProjectNames={showProjectNames}
            liveIssueIds={liveIssueIds}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            projects={projects}
            currentUserId={currentUserId}
            showProjectName={showProjectNames}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
