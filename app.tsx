import { useEffect, useMemo, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginHomepageSectionProps,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { buildNewChatActivityByProject } from "./src/activity.js";
import { formatRelativeTime } from "./src/relative-time.js";
import type { rpcContract } from "./server.js";
import {
  parseHomepageSettings,
  parseRankingMode,
  RANKING_OPTIONS,
  type HomepageSettings,
  type RankingMode,
} from "./src/settings.js";

const PROJECT_ICON_URL = "/api/v1/plugins/homepage/http/project-icon";
const RANKING_STORAGE_KEY = "bb-plugin-homepage:ranking-mode";
const MANUAL_ORDER_STORAGE_KEY = "bb-plugin-homepage:manual-project-order";

interface RankedProject extends PluginSidebarProject {
  chatCount: number;
  lastUsedAt: number;
}

interface RenameTarget {
  id: string;
  name: string;
}

interface ProjectNameOverride {
  name: string;
  previousName: string;
}

function rankProjects(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  settings: HomepageSettings,
  currentProjectId: string | null,
  manualOrder: readonly string[],
): RankedProject[] {
  const usage = new Map<string, { chatCount: number; lastUsedAt: number }>();
  const manualPositions = new Map(
    manualOrder.map((projectId, index) => [projectId, index]),
  );

  for (const thread of threads) {
    if (thread.isArchived || thread.parentThreadId !== null) continue;
    const current = usage.get(thread.projectId);
    usage.set(thread.projectId, {
      chatCount: (current?.chatCount ?? 0) + 1,
      lastUsedAt: Math.max(current?.lastUsedAt ?? 0, thread.updatedAt),
    });
  }

  return projects
    .map((project) => ({
      ...project,
      chatCount: usage.get(project.id)?.chatCount ?? 0,
      lastUsedAt: usage.get(project.id)?.lastUsedAt ?? 0,
    }))
    .filter((project) => settings.includePersonalProject || !project.isPersonal)
    .filter((project) => settings.showUnusedProjects || project.chatCount > 0)
    .sort((left, right) => {
      if (settings.currentProjectFirst && settings.rankingMode !== "Manual") {
        const currentOrder =
          Number(right.id === currentProjectId) - Number(left.id === currentProjectId);
        if (currentOrder !== 0) return currentOrder;
      }

      if (settings.rankingMode === "Manual") {
        const leftPosition = manualPositions.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = manualPositions.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftPosition - rightPosition || left.name.localeCompare(right.name);
      }

      if (settings.rankingMode === "Most chats") {
        return (
          right.chatCount - left.chatCount ||
          right.lastUsedAt - left.lastUsedAt ||
          left.name.localeCompare(right.name)
        );
      }

      if (settings.rankingMode === "Alphabetical") {
        return (
          left.name.localeCompare(right.name) || right.lastUsedAt - left.lastUsedAt
        );
      }

      return (
        right.lastUsedAt - left.lastUsedAt ||
        right.chatCount - left.chatCount ||
        left.name.localeCompare(right.name)
      );
    });
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-4">
      <path
        d="M3.75 7.75h6l1.5 1.75h9v8.75a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V7.75Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.75 7.75v-2a2 2 0 0 1 2-2h3.1l1.5 1.75h7.9a2 2 0 0 1 2 2v2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProjectIcon({
  projectId,
  isPersonal,
  loadArtwork,
  onRename,
}: {
  projectId: string;
  isPersonal: boolean;
  loadArtwork: boolean;
  onRename?: () => void;
}) {
  const [showFallback, setShowFallback] = useState(false);
  const useFallback = isPersonal || !loadArtwork || showFallback;

  return (
    <span
      aria-hidden="true"
      data-homepage-project-icon=""
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground group-hover:text-foreground"
      onContextMenu={
        onRename
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onRename();
            }
          : undefined
      }
    >
      {useFallback ? (
        <FolderIcon />
      ) : (
        <img
          alt=""
          className="size-5 object-contain"
          decoding="async"
          loading="lazy"
          src={`${PROJECT_ICON_URL}?projectId=${encodeURIComponent(projectId)}`}
          onError={() => setShowFallback(true)}
        />
      )}
    </span>
  );
}

interface SparklinePoint {
  x: number;
  y: number;
}

function buildSmoothLinePath(
  points: readonly SparklinePoint[],
  minY: number,
  maxY: number,
): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const clampY = (value: number) => Math.min(maxY, Math.max(minY, value));
  let path = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] ?? points[index]!;
    const from = points[index]!;
    const to = points[index + 1]!;
    const after = points[index + 2] ?? to;
    const control1X = round(from.x + (to.x - before.x) / 6);
    const control1Y = round(clampY(from.y + (to.y - before.y) / 6));
    const control2X = round(to.x - (after.x - from.x) / 6);
    const control2Y = round(clampY(to.y - (after.y - from.y) / 6));
    path += ` C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${round(to.x)} ${round(to.y)}`;
  }
  return path;
}

function NewChatSparkline({
  projectName,
  activity,
}: {
  projectName: string;
  activity: readonly number[];
}) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setDrawn(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const total = activity.reduce((sum, count) => sum + count, 0);
  if (total === 0 || activity.length < 2) return null;

  const width = 72;
  const height = 24;
  const baseline = height - 2;
  const chartTop = 3;
  const maximum = Math.max(...activity);
  const points = activity.map((count, index) => ({
    x: (index / (activity.length - 1)) * width,
    y: baseline - (count / maximum) * (baseline - chartTop),
  }));
  const line = buildSmoothLinePath(points, chartTop, baseline);
  const area = `${line} L ${width} ${baseline} L 0 ${baseline} Z`;
  const label = `${projectName}: ${total} new chat${total === 1 ? "" : "s"} in the last 14 days`;
  const latest = points.at(-1)!;

  return (
    <span className="shrink-0" title={label}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        className="h-6 w-[72px] overflow-visible text-primary/70 transition-colors group-hover:text-primary [transition:clip-path_500ms_ease-out,color_150ms] motion-reduce:transition-none"
        style={{ clipPath: drawn ? "inset(-4px)" : "inset(-4px 100% -4px -4px)" }}
      >
        <path d={area} fill="currentColor" fillOpacity="0.1" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={latest.x} cy={latest.y} r="1.75" fill="currentColor" />
      </svg>
    </span>
  );
}

function ProjectChatLauncher({ projectId }: PluginHomepageSectionProps) {
  const { status, projects, threads } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const settingsState = useSettings();
  const pluginSettings = useMemo(
    () => parseHomepageSettings(settingsState.values),
    [settingsState.values],
  );
  const [rankingMode, setRankingMode] = useState<RankingMode>(readRankingMode);
  const [manualOrder, setManualOrder] = useState<readonly string[]>(readManualOrder);
  const settings = useMemo(
    () => ({ ...pluginSettings, rankingMode }),
    [pluginSettings, rankingMode],
  );
  const [projectNameOverrides, setProjectNameOverrides] = useState<
    Readonly<Record<string, ProjectNameOverride>>
  >({});
  const displayedProjects = useMemo(
    () =>
      projects.map((project) => {
        const override = projectNameOverrides[project.id];
        return override ? { ...project, name: override.name } : project;
      }),
    [projectNameOverrides, projects],
  );
  const rankedProjects = useMemo(
    () => rankProjects(displayedProjects, threads, settings, projectId, manualOrder),
    [displayedProjects, manualOrder, projectId, settings, threads],
  );
  const activityByProject = useMemo(
    () => buildNewChatActivityByProject(threads),
    [threads],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const rpc = useRpc<typeof rpcContract>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    projectId: string;
    position: "after" | "before";
  } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void rpc.call("listPinnedProjects").then(
      ({ projectIds }) => {
        if (!cancelled) setPinnedIds(projectIds);
      },
      () => {
        // Pins are an enhancement; the launcher works without them.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  useRealtime("pins-changed", () => {
    void rpc.call("listPinnedProjects").then(
      ({ projectIds }) => setPinnedIds(projectIds),
      () => {},
    );
  });

  useEffect(() => {
    setProjectNameOverrides((current) => {
      const next = { ...current };
      let changed = false;
      for (const [targetId, override] of Object.entries(current)) {
        const project = projects.find((candidate) => candidate.id === targetId);
        if (!project || project.name !== override.previousName) {
          delete next[targetId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [projects]);

  if (status === "loading") {
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        Loading projects...
      </p>
    );
  }

  if (status === "error") {
    return (
      <p role="alert" className="py-2 text-sm text-destructive">
        Projects could not be loaded.
      </p>
    );
  }

  if (rankedProjects.length === 0) {
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        No projects yet.
      </p>
    );
  }

  function changeRankingMode(value: string): void {
    const next = parseRankingMode(value);
    if (next === "Manual" && manualOrder.length === 0) {
      saveManualOrder(rankedProjects.map((project) => project.id));
    }
    setRankingMode(next);
    try {
      window.localStorage.setItem(RANKING_STORAGE_KEY, next);
    } catch {
      // Browser storage can be unavailable; sorting still works for this page.
    }
  }

  function saveManualOrder(projectIds: readonly string[]): void {
    setManualOrder(projectIds);
    try {
      window.localStorage.setItem(MANUAL_ORDER_STORAGE_KEY, JSON.stringify(projectIds));
    } catch {
      // Browser storage can be unavailable; dragging still works for this page.
    }
  }

  function reorderProject(
    sourceId: string,
    targetId: string,
    position: "after" | "before",
  ): void {
    if (sourceId === targetId) return;
    const sourceIsPinned = pinnedIds.includes(sourceId);
    if (sourceIsPinned !== pinnedIds.includes(targetId)) return;

    const orderedIds = rankedProjects.map((project) => project.id);
    const sourceIndex = orderedIds.indexOf(sourceId);
    if (sourceIndex === -1 || !orderedIds.includes(targetId)) return;

    const [movedId] = orderedIds.splice(sourceIndex, 1);
    const targetIndex = orderedIds.indexOf(targetId);
    orderedIds.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, movedId!);

    const visibleIds = new Set(orderedIds);
    const hiddenIds = manualOrder.filter((id) => !visibleIds.has(id));
    saveManualOrder([...orderedIds, ...hiddenIds]);
  }

  function togglePin(targetId: string, pinned: boolean): void {
    void rpc.call("setProjectPinned", { projectId: targetId, pinned }).then(
      ({ projectIds }) => setPinnedIds(projectIds),
      () => {},
    );
  }

  function startRenaming(project: RankedProject): void {
    setRenameTarget({ id: project.id, name: project.name });
    setRenameName(project.name);
    setRenameError(null);
  }

  function cancelRenaming(): void {
    if (isRenaming) return;
    setRenameTarget(null);
    setRenameName("");
    setRenameError(null);
  }

  function submitRename(): void {
    if (!renameTarget || isRenaming) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError("Enter a project name.");
      return;
    }
    if (name === renameTarget.name) {
      cancelRenaming();
      return;
    }

    const target = renameTarget;
    setIsRenaming(true);
    setRenameError(null);
    void rpc.call("renameProject", { projectId: target.id, name }).then(
      (renamedProject) => {
        setProjectNameOverrides((current) => ({
          ...current,
          [renamedProject.projectId]: {
            name: renamedProject.name,
            previousName: target.name,
          },
        }));
        setRenameTarget(null);
        setRenameName("");
        setIsRenaming(false);
      },
      () => {
        setRenameError("Project could not be renamed.");
        setIsRenaming(false);
      },
    );
  }

  const pinnedProjects =
    rankingMode === "Manual"
      ? rankedProjects.filter((project) => pinnedIds.includes(project.id))
      : pinnedIds
          .map((id) => rankedProjects.find((project) => project.id === id))
          .filter((project): project is RankedProject => project !== undefined);
  const unpinnedProjects = rankedProjects.filter(
    (project) => !pinnedIds.includes(project.id),
  );

  function renderProject(project: RankedProject) {
    const isCurrent = project.id === projectId;
    const isPinned = pinnedIds.includes(project.id);
    const isEditing = renameTarget?.id === project.id;
    const isManual = rankingMode === "Manual";
    const isDragging = draggedProjectId === project.id;
    const activity = activityByProject.get(project.id) ?? [];
    const className = [
      "flex w-full min-w-0 items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors group-hover:border-foreground/20 group-hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      isCurrent ? "border-ring bg-state-hover" : "border-border",
      isManual && !isEditing ? "cursor-grab active:cursor-grabbing" : "",
      isDragging ? "opacity-50" : "",
    ].join(" ");

    const menuItemClassName =
      "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-state-hover";

    const cardContent = (
      <>
        <ProjectIcon
          projectId={project.id}
          isPersonal={project.isPersonal}
          loadArtwork={settings.loadProjectIcons}
          onRename={
            project.isPersonal || isEditing ? undefined : () => startRenaming(project)
          }
        />
        <span className="min-w-0 flex-1">
          {isEditing ? (
            <input
              autoFocus
              aria-label={`Rename ${project.name}`}
              aria-invalid={renameError ? "true" : undefined}
              disabled={isRenaming}
              maxLength={200}
              title="Press Enter to save or Escape to cancel"
              value={renameName}
              className="h-7 w-full rounded-md border border-ring bg-background px-2 text-sm font-medium text-foreground shadow-sm outline-none ring-1 ring-ring/20 selection:bg-primary/20"
              onChange={(event) => {
                setRenameName(event.target.value);
                setRenameError(null);
              }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRenaming();
                }
              }}
              onBlur={cancelRenaming}
            />
          ) : (
            <span className="block truncate text-sm font-medium text-foreground">
              {project.name}
            </span>
          )}
          {renameError && isEditing ? (
            <span role="alert" className="mt-1 block truncate text-xs text-destructive">
              {renameError}
            </span>
          ) : settings.showChatCounts ? (
            <span className="block truncate text-xs text-muted-foreground">
              {project.chatCount === 0
                ? "No chats yet"
                : `${project.chatCount} chat${project.chatCount === 1 ? "" : "s"} · ${formatRelativeTime(project.lastUsedAt, now)}`}
            </span>
          ) : null}
        </span>
        {!isEditing ? (
          <>
            <NewChatSparkline projectName={project.name} activity={activity} />
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors group-hover:border-primary group-hover:text-primary"
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
                <path
                  d="M8 3.25v9.5M3.25 8h9.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </>
        ) : null}
      </>
    );

    return (
      <ContextMenu.Root key={project.id}>
        <ContextMenu.Trigger asChild disabled={isEditing}>
          <div
            className="group relative"
            data-project-id={project.id}
            draggable={isManual && !isEditing}
            onDragStart={(event) => {
              if (!isManual || isEditing) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", project.id);
              setDraggedProjectId(project.id);
            }}
            onDragOver={(event) => {
              if (!draggedProjectId || draggedProjectId === project.id) return;
              if (isPinned !== pinnedIds.includes(draggedProjectId)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const bounds = event.currentTarget.getBoundingClientRect();
              setDropTarget({
                projectId: project.id,
                position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
              });
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTarget((current) =>
                  current?.projectId === project.id ? null : current,
                );
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedProjectId && dropTarget?.projectId === project.id) {
                reorderProject(draggedProjectId, project.id, dropTarget.position);
              }
              setDraggedProjectId(null);
              setDropTarget(null);
            }}
            onDragEnd={() => {
              setDraggedProjectId(null);
              setDropTarget(null);
            }}
          >
            {isDragging ? (
              <span
                aria-hidden="true"
                data-drag-handle=""
                className="pointer-events-none absolute left-1 top-1/2 z-20 flex w-3 -translate-y-1/2 items-center justify-center text-muted-foreground"
              >
                <svg viewBox="0 0 12 16" fill="none" className="h-4 w-3">
                  <path
                    d="M3.5 4h.01M8.5 4h.01M3.5 8h.01M8.5 8h.01M3.5 12h.01M8.5 12h.01"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            ) : null}
            {dropTarget?.projectId === project.id ? (
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute left-2 right-2 z-20 h-0.5 rounded-full bg-primary ${
                  dropTarget.position === "before" ? "-top-1" : "-bottom-1"
                }`}
              />
            ) : null}
            {isEditing ? (
              <div className={className}>{cardContent}</div>
            ) : (
              <button
                type="button"
                className={className}
                aria-label={`Start a new chat in ${project.name}`}
                aria-current={isCurrent ? "page" : undefined}
                onClick={() =>
                  actions.openNewThread({ projectId: project.id, focusPrompt: true })
                }
              >
                {cardContent}
              </button>
            )}
            {!isEditing ? (
              <button
                type="button"
                aria-label={isPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                aria-pressed={isPinned}
                className="absolute right-[52px] top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
                onClick={() => togglePin(project.id, !isPinned)}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill={isPinned ? "currentColor" : "none"}
                  className="size-3.5"
                >
                  <path
                    d="M4.75 3.25h6.5v9.4a.25.25 0 0 1-.4.2L8 10.55l-2.85 2.3a.25.25 0 0 1-.4-.2z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[10rem] rounded-md border border-border bg-card p-1 shadow-md">
            <ContextMenu.Item
              className={menuItemClassName}
              onSelect={() =>
                actions.openNewThread({ projectId: project.id, focusPrompt: true })
              }
            >
              New chat
            </ContextMenu.Item>
            <ContextMenu.Item
              className={menuItemClassName}
              onSelect={() => togglePin(project.id, !isPinned)}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenu.Item>
            {!project.isPersonal ? (
              <ContextMenu.Item
                className={menuItemClassName}
                onSelect={() => startRenaming(project)}
              >
                Rename
              </ContextMenu.Item>
            ) : null}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }

  return (
    <div className="relative">
      <div
        data-homepage-sort=""
        className="absolute -top-9 right-0 z-10 flex items-center justify-end"
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Sort</span>
          <select
            aria-label="Sort projects"
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={rankingMode}
            onChange={(event) => changeRankingMode(event.target.value)}
          >
            {RANKING_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pinnedProjects.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <svg viewBox="0 0 16 16" fill="currentColor" className="size-3" aria-hidden="true">
              <path d="M4.75 2.5h6.5a.5.5 0 0 1 .5.5v10.15a.25.25 0 0 1-.4.2L8 10.9l-3.35 2.45a.25.25 0 0 1-.4-.2V3a.5.5 0 0 1 .5-.5z" />
            </svg>
            Pinned
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {pinnedProjects.map(renderProject)}
          </div>
        </div>
      ) : null}
      {unpinnedProjects.length > 0 ? (
        <div>
          {pinnedProjects.length > 0 ? (
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              All projects
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {unpinnedProjects.map(renderProject)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function readRankingMode(): RankingMode {
  try {
    return parseRankingMode(window.localStorage.getItem(RANKING_STORAGE_KEY));
  } catch {
    return parseRankingMode(undefined);
  }
}

function readManualOrder(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(MANUAL_ORDER_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];

    const uniqueIds = new Set<string>();
    for (const value of stored) {
      if (typeof value === "string" && value.length > 0) uniqueIds.add(value);
      if (uniqueIds.size === 1_000) break;
    }
    return [...uniqueIds];
  } catch {
    return [];
  }
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-homepage-recent-chats",
    mount() {
      const style = document.createElement("style");
      style.dataset.bbHomepageHideRecents = "";
      style.textContent = "[data-root-compose-mobile-recents] { display: none !important; }";
      document.head.append(style);

      return () => style.remove();
    },
  });

  app.slots.homepageSection({
    id: "project-chat-launcher",
    title: "Start in a project",
    component: ProjectChatLauncher,
  });
});
