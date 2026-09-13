import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as HoverCard from "@radix-ui/react-hover-card";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useComposer,
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
import {
  buildProjectAttention,
  formatAttention,
  primaryAttention,
  sumAttention,
  summarizeAttention,
  type AttentionKind,
  type ProjectAttention,
} from "./src/attention.js";
import { ProjectOpenMenu } from "./src/ProjectOpenMenu.js";
import { formatRelativeTime } from "./src/relative-time.js";
import type { ProjectGroup, rpcContract } from "./server.js";
import {
  parseHomepageSettings,
  parseRankingMode,
  RANKING_OPTIONS,
  workspaceRefreshIntervalMs,
  type HomepageSettings,
  type RankingMode,
} from "./src/settings.js";
import {
  formatFileCount,
  isOnDefaultBranch,
  type WorkspaceChanges,
  type WorkspaceStatus,
  type WorkspaceWorktree,
} from "./src/workspace-status.js";

type AvailableWorkspaceStatus = Extract<WorkspaceStatus, { kind: "available" }>;

const PROJECT_ICON_URL = "/api/v1/plugins/homepage/http/project-icon";
const RANKING_STORAGE_KEY = "bb-plugin-homepage:ranking-mode";
const MANUAL_ORDER_STORAGE_KEY = "bb-plugin-homepage:manual-project-order";
const COLLAPSED_GROUPS_STORAGE_KEY = "bb-plugin-homepage:collapsed-project-groups";
const DRAG_ACTIVATION_DISTANCE = 8;
let hasAnimatedProjectLauncher = false;

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

interface ProjectDropTarget {
  projectId: string;
  position: "after" | "before";
}

interface GroupDropTarget {
  groupId: string;
  position: "after" | "before";
}

type ProjectSectionId = "pinned" | "ungrouped" | `group:${string}`;

type GroupEditor =
  | { mode: "create"; projectId?: string }
  | { mode: "rename"; groupId: string };

interface PointerDragGesture {
  projectId: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
}

interface GroupPointerDragGesture {
  groupId: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
}

function rankProjects(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  settings: HomepageSettings,
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

type ProjectArtworkState =
  | { kind: "fallback" | "image" | "loading" }
  | { kind: "glyph"; svg: string };

// Keep the last rendered data for navigation within this app window. Every
// visit still revalidates it; a full reload starts with an empty cache.
const projectArtworkById = new Map<string, ProjectArtworkState>();
let launcherSnapshot: {
  hiddenIds: readonly string[];
  pinnedIds: readonly string[];
  projectGroups: readonly ProjectGroup[];
  preferencesStatus: "ready" | "error";
  workspaceStatuses: Readonly<Record<string, WorkspaceStatus>>;
  workspaceUpdatedAt: number | null;
} | undefined;

function rememberProjectArtwork(projectId: string, artwork: ProjectArtworkState): void {
  projectArtworkById.delete(projectId);
  projectArtworkById.set(projectId, artwork);
  if (projectArtworkById.size > 128) {
    projectArtworkById.delete(projectArtworkById.keys().next().value!);
  }
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

/** Draw a server-rendered BB glyph as a mask so it inherits the tile's text color. */
function GlyphIcon({ svg }: { svg: string }) {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return (
    <span
      data-homepage-project-glyph=""
      className="size-5 bg-current"
      style={{
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
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
  const rpc = useRpc<typeof rpcContract>();
  const [artwork, setArtwork] = useState<ProjectArtworkState>(() =>
    isPersonal || !loadArtwork
      ? { kind: "fallback" }
      : projectArtworkById.get(projectId) ?? { kind: "loading" },
  );

  useEffect(() => {
    if (isPersonal || !loadArtwork) {
      setArtwork({ kind: "fallback" });
      return;
    }

    let cancelled = false;
    setArtwork(projectArtworkById.get(projectId) ?? { kind: "loading" });
    void rpc.call("getProjectArtwork", { projectId }).then(
      (result) => {
        const next: ProjectArtworkState = result.kind === "missing"
          ? { kind: "fallback" }
          : result;
        rememberProjectArtwork(projectId, next);
        if (cancelled) return;
        setArtwork(next);
      },
      () => {
        if (!cancelled) {
          setArtwork(projectArtworkById.get(projectId) ?? { kind: "fallback" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isPersonal, loadArtwork, projectId, rpc]);

  const useTile = artwork.kind !== "image";

  return (
    <span
      aria-hidden="true"
      data-homepage-project-icon=""
      className={`flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md ${
        useTile
          ? "bg-muted text-muted-foreground group-hover:text-foreground"
          : "bg-transparent"
      }`}
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
      {artwork.kind === "image" ? (
        <img
          alt=""
          className="size-8 object-contain"
          decoding="sync"
          draggable={false}
          src={`${PROJECT_ICON_URL}?projectId=${encodeURIComponent(projectId)}`}
          onError={() => {
            rememberProjectArtwork(projectId, { kind: "fallback" });
            setArtwork({ kind: "fallback" });
          }}
        />
      ) : artwork.kind === "glyph" ? (
        <GlyphIcon svg={artwork.svg} />
      ) : (
        <FolderIcon />
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

const SPARKLINE_FALLBACK_WIDTH = 88;

function NewChatSparkline({
  projectName,
  activity,
  animate,
}: {
  projectName: string;
  activity: readonly number[];
  animate: boolean;
}) {
  const [drawn, setDrawn] = useState(!animate);
  useEffect(() => {
    if (!animate) return;
    const frame = window.requestAnimationFrame(() => setDrawn(true));
    return () => window.cancelAnimationFrame(frame);
  }, [animate]);
  // The sparkline fills whatever the card leaves between the name and the
  // status column, so the viewBox follows the measured width instead of
  // stretching the drawing.
  const frameRef = useRef<HTMLSpanElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setMeasuredWidth(Math.round(frame.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      setMeasuredWidth((current) => (current === next ? current : next));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [activity.length, activity.some((count) => count > 0)]);

  const total = activity.reduce((sum, count) => sum + count, 0);
  if (total === 0 || activity.length < 2) return null;

  const width = measuredWidth > 0 ? measuredWidth : SPARKLINE_FALLBACK_WIDTH;
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
    <span ref={frameRef} className="hidden min-w-0 flex-1 @[18rem]:block" title={label}>
      <svg
        role="img"
        aria-label={label}
        data-sparkline-entrance={animate ? "" : undefined}
        viewBox={`0 0 ${width} ${height}`}
        className="block h-6 w-full overflow-visible text-primary/70 transition-colors group-hover:text-primary [transition:clip-path_500ms_ease-out,color_150ms] motion-reduce:transition-none"
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

const ATTENTION_PILL_CLASSES: Record<AttentionKind, string> = {
  needsYou: "bg-primary/10 text-primary",
  failed: "bg-destructive/10 text-destructive",
  running: "bg-muted text-muted-foreground",
};

/** The one live state worth a glance: blocked on you, failed, or working. */
function AttentionPill({ attention }: { attention: ProjectAttention | undefined }) {
  const primary = primaryAttention(attention);
  if (!primary) return null;
  return (
    <span
      data-attention={primary.kind}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium leading-4 ${
        ATTENTION_PILL_CLASSES[primary.kind]
      }`}
    >
      {primary.kind === "running" ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none"
        />
      ) : null}
      {formatAttention(primary.kind, primary.count)}
    </span>
  );
}

function GroupAttentionSummary({
  projects,
  attentionByProject,
}: {
  projects: readonly RankedProject[];
  attentionByProject: ReadonlyMap<string, ProjectAttention>;
}) {
  const summary = summarizeAttention(
    sumAttention(projects.map((project) => attentionByProject.get(project.id))),
  );
  if (!summary) return null;
  return (
    <span
      data-group-summary=""
      className="ml-1 truncate font-normal normal-case tracking-normal text-muted-foreground"
    >
      {summary}
    </span>
  );
}

function WorkspaceChangesText({ changes }: { changes: WorkspaceChanges }) {
  if (changes.files === 0) return <>No change</>;
  return (
    <>
      {formatFileCount(changes.files)},{" "}
      <span className="text-diff-added">+{changes.insertions}</span>{" "}
      <span className="text-diff-removed">-{changes.deletions}</span>
    </>
  );
}

/** A small branch glyph that stands in for the branch name; the name lives in its tooltip. */
function BranchMark({ branch }: { branch: string | null }) {
  const name = branch ?? "a detached commit";
  return (
    <span
      data-workspace-branch=""
      role="img"
      aria-label={`On ${name}`}
      title={name}
      className="inline-flex shrink-0 text-muted-foreground"
    >
      <svg viewBox="0 0 12 12" fill="none" className="size-3" aria-hidden="true">
        <circle cx="3" cy="2.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="3" cy="9.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="9" cy="4" r="1.4" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M3 3.9v4.2M9 5.4c0 1.6-1.2 2.4-3 2.6-1.2.2-2.4.5-3 .9"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Right-hand card column: file count over line counts, with a branch mark when off the default. */
function WorkspaceStatusBlock({ status }: { status: AvailableWorkspaceStatus }) {
  const mark = !isOnDefaultBranch(status) ? <BranchMark branch={status.branch} /> : null;
  if (status.changes.files === 0) {
    return (
      <span data-workspace-changes="" className="flex flex-col items-end">
        <span className="flex items-center gap-1 whitespace-nowrap">
          {mark}
          No
        </span>
        <span className="whitespace-nowrap">Change</span>
      </span>
    );
  }
  return (
    <span data-workspace-changes="" className="flex flex-col items-end">
      <span className="flex items-center gap-1 whitespace-nowrap">
        {mark}
        {formatFileCount(status.changes.files)}
      </span>
      <span className="whitespace-nowrap">
        <span className="text-diff-added">+{status.changes.insertions}</span>{" "}
        <span className="text-diff-removed">-{status.changes.deletions}</span>
      </span>
    </span>
  );
}

const WORKSPACE_COLUMN_CLASSES =
  "ml-auto flex shrink-0 flex-col items-end text-right text-xs leading-4 text-muted-foreground";

function WorktreeRow({
  label,
  branch,
  status,
}: {
  label?: string;
  branch: string | null;
  status: WorkspaceStatus;
}) {
  const name = branch ?? "detached";
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-0.5">
      <span className="min-w-0 truncate text-foreground" title={name}>
        {label ? <span className="text-muted-foreground">{label} · </span> : null}
        {name}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {status.kind === "available" ? (
          <WorkspaceChangesText changes={status.changes} />
        ) : (
          "Unavailable"
        )}
      </span>
    </div>
  );
}

function WorktreeList({
  projectId,
  checkout,
}: {
  projectId: string;
  checkout: AvailableWorkspaceStatus;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<readonly WorkspaceWorktree[] | "error" | "loading">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void rpc.call("listProjectWorktrees", { projectId }).then(
      ({ worktrees }) => {
        if (!cancelled) setState(worktrees);
      },
      () => {
        if (!cancelled) setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, rpc]);

  return (
    <div className="flex flex-col gap-0.5">
      <WorktreeRow label="Checkout" branch={checkout.branch} status={checkout} />
      <p className="mt-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Worktrees
      </p>
      {state === "loading" ? (
        <p className="px-1 text-muted-foreground">Loading worktrees...</p>
      ) : state === "error" ? (
        <p role="alert" className="px-1 text-destructive">
          Worktrees could not be loaded.
        </p>
      ) : state.length === 0 ? (
        <p className="px-1 text-muted-foreground">No worktrees</p>
      ) : (
        state.map((worktree) => (
          <WorktreeRow
            key={worktree.environmentId}
            branch={worktree.branch ?? worktree.name}
            status={worktree.status}
          />
        ))
      )}
    </div>
  );
}

/** Hovering a card's status line lists the project's worktrees, loaded on demand. */
function WorkspaceHoverCard({
  projectId,
  status,
  children,
}: {
  projectId: string;
  status: AvailableWorkspaceStatus;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={300} closeDelay={150}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          data-bb-plugin="homepage"
          align="start"
          side="bottom"
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-border bg-card p-2 text-xs shadow-md"
        >
          {open ? <WorktreeList projectId={projectId} checkout={status} /> : null}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={`size-4 ${spinning ? "animate-spin motion-reduce:animate-none" : ""}`}
      aria-hidden="true"
    >
      <path
        d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75V6h-3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HiddenProjectsSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [hiddenIds, setHiddenIds] = useState<readonly string[] | null>(null);
  const [error, setError] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  function loadHiddenProjects(): void {
    void rpc.call("listHiddenProjects").then(
      ({ projectIds }) => {
        setHiddenIds(projectIds);
        setError(false);
      },
      () => setError(true),
    );
  }

  useEffect(loadHiddenProjects, []);
  useRealtime("hidden-projects-changed", loadHiddenProjects);

  function resetHiddenProjects(): void {
    if (isResetting || hiddenIds?.length === 0) return;
    setIsResetting(true);
    setError(false);
    void rpc.call("resetHiddenProjects").then(
      ({ projectIds }) => {
        setHiddenIds(projectIds);
        setIsResetting(false);
      },
      () => {
        setError(true);
        setIsResetting(false);
      },
    );
  }

  const description = error
    ? "Hidden projects could not be loaded."
    : hiddenIds === null
      ? "Loading hidden projects..."
      : hiddenIds.length === 0
        ? "No projects are hidden."
        : `${hiddenIds.length} hidden project${hiddenIds.length === 1 ? "" : "s"}.`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
        {description}
      </p>
      <button
        type="button"
        disabled={isResetting || hiddenIds === null || hiddenIds.length === 0}
        className="h-8 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        onClick={resetHiddenProjects}
      >
        {isResetting ? "Resetting..." : "Reset hidden projects"}
      </button>
    </div>
  );
}

function ProjectChatLauncher({ projectId }: PluginHomepageSectionProps) {
  const animateSparklinesRef = useRef(!hasAnimatedProjectLauncher);
  useEffect(() => {
    hasAnimatedProjectLauncher = true;
  }, []);
  const { status, projects, threads } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const composer = useComposer();
  const composerProjectId =
    composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const [lastClickedProjectId, setLastClickedProjectId] = useState<string | null>(null);
  useEffect(() => {
    setLastClickedProjectId(null);
  }, [composerProjectId, projectId]);
  const activeProjectId = lastClickedProjectId ?? composerProjectId ?? projectId;
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
  const [hiddenIds, setHiddenIds] = useState<readonly string[]>(
    () => launcherSnapshot?.hiddenIds ?? [],
  );
  const displayedProjects = useMemo(
    () =>
      projects
        .filter((project) => !hiddenIds.includes(project.id))
        .map((project) => {
          const override = projectNameOverrides[project.id];
          return override ? { ...project, name: override.name } : project;
        }),
    [hiddenIds, projectNameOverrides, projects],
  );
  const rankedProjects = useMemo(
    () => rankProjects(displayedProjects, threads, settings, manualOrder),
    [displayedProjects, manualOrder, settings, threads],
  );
  const activityByProject = useMemo(
    () => buildNewChatActivityByProject(threads),
    [threads],
  );
  const attentionByProject = useMemo(() => buildProjectAttention(threads), [threads]);
  const [attentionFilter, setAttentionFilter] = useState(false);
  const needsYouProjectCount = useMemo(
    () =>
      rankedProjects.filter(
        (project) => (attentionByProject.get(project.id)?.needsYou ?? 0) > 0,
      ).length,
    [attentionByProject, rankedProjects],
  );
  const visibleProjects = useMemo(
    () =>
      attentionFilter
        ? rankedProjects.filter(
            (project) => (attentionByProject.get(project.id)?.needsYou ?? 0) > 0,
          )
        : rankedProjects,
    [attentionByProject, attentionFilter, rankedProjects],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const rpc = useRpc<typeof rpcContract>();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const showWorkspaceStatus = settings.showWorkspaceStatus;
  const [workspaceStatuses, setWorkspaceStatuses] = useState<
    Readonly<Record<string, WorkspaceStatus>>
  >(() => launcherSnapshot?.workspaceStatuses ?? {});
  const [workspaceUpdatedAt, setWorkspaceUpdatedAt] = useState<number | null>(
    () => launcherSnapshot?.workspaceUpdatedAt ?? null,
  );
  const [isRefreshingWorkspaces, setIsRefreshingWorkspaces] = useState(false);
  const requestedWorkspaceIdsRef = useRef(new Set<string>());
  const workspaceProjectIds = useMemo(
    () => rankedProjects.filter((project) => !project.isPersonal).map((project) => project.id),
    [rankedProjects],
  );
  const workspaceProjectIdsKey = workspaceProjectIds.join("\n");

  function loadWorkspaceStatuses(projectIds: readonly string[], refresh: boolean): void {
    if (projectIds.length === 0) return;
    for (const projectId of projectIds) requestedWorkspaceIdsRef.current.add(projectId);
    if (refresh) setIsRefreshingWorkspaces(true);
    void rpc
      .call("getProjectWorkspaceStatuses", { projectIds: [...projectIds], refresh })
      .then(
        ({ statuses }) => {
          if (!mountedRef.current) return;
          setWorkspaceStatuses((current) => ({ ...current, ...statuses }));
          setWorkspaceUpdatedAt(Date.now());
        },
        () => {
          if (!mountedRef.current) return;
          for (const projectId of projectIds) requestedWorkspaceIdsRef.current.delete(projectId);
          if (refresh) setActionError("Checkout status could not be refreshed.");
        },
      )
      .finally(() => {
        if (mountedRef.current && refresh) setIsRefreshingWorkspaces(false);
      });
  }

  useEffect(() => {
    if (!showWorkspaceStatus) return;
    loadWorkspaceStatuses(
      workspaceProjectIds.filter((id) => !requestedWorkspaceIdsRef.current.has(id)),
      false,
    );
  }, [showWorkspaceStatus, workspaceProjectIdsKey]);

  const workspaceRefreshMs = workspaceRefreshIntervalMs(settings.workspaceRefresh);
  useEffect(() => {
    if (!showWorkspaceStatus || workspaceRefreshMs === null) return;
    const timer = window.setInterval(
      () => loadWorkspaceStatuses(workspaceProjectIds, false),
      workspaceRefreshMs,
    );
    return () => window.clearInterval(timer);
  }, [showWorkspaceStatus, workspaceRefreshMs, workspaceProjectIdsKey]);

  function refreshWorkspaceStatuses(): void {
    setActionError(null);
    loadWorkspaceStatuses(workspaceProjectIds, true);
  }
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProjectDropTarget | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = useState<
    ProjectSectionId | null
  >(null);
  const pointerDragRef = useRef<PointerDragGesture | null>(null);
  const dropTargetRef = useRef<ProjectDropTarget | null>(null);
  const sectionDropTargetRef = useRef<ProjectSectionId | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const sortPointerSelectionRef = useRef(false);
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>(
    () => launcherSnapshot?.pinnedIds ?? [],
  );
  const [projectGroups, setProjectGroups] = useState<readonly ProjectGroup[]>(
    () => launcherSnapshot?.projectGroups ?? [],
  );
  const [preferencesStatus, setPreferencesStatus] = useState<
    "error" | "loading" | "ready"
  >(() => launcherSnapshot?.preferencesStatus ?? "loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<readonly string[]>(
    readCollapsedGroupIds,
  );
  const [groupEditor, setGroupEditor] = useState<GroupEditor | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<GroupDropTarget | null>(
    null,
  );
  const groupPointerDragRef = useRef<GroupPointerDragGesture | null>(null);
  const groupDropTargetRef = useRef<GroupDropTarget | null>(null);
  useEffect(() => {
    if (preferencesStatus === "loading") return;
    launcherSnapshot = {
      hiddenIds, pinnedIds, projectGroups, preferencesStatus,
      workspaceStatuses, workspaceUpdatedAt,
    };
  }, [hiddenIds, pinnedIds, projectGroups, preferencesStatus, workspaceStatuses, workspaceUpdatedAt]);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      rpc.call("listPinnedProjects"),
      rpc.call("listProjectGroups"),
      rpc.call("listHiddenProjects"),
    ]).then(([pins, groups, hidden]) => {
      if (cancelled) return;
      if (pins.status === "fulfilled") setPinnedIds(pins.value.projectIds);
      if (groups.status === "fulfilled") setProjectGroups(groups.value.groups);
      if (hidden.status === "fulfilled") setHiddenIds(hidden.value.projectIds);
      setPreferencesStatus(
        pins.status === "rejected" ||
          groups.status === "rejected" ||
          hidden.status === "rejected"
          ? "error"
          : "ready",
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useRealtime("pins-changed", () => {
    void rpc.call("listPinnedProjects").then(
      ({ projectIds }) => setPinnedIds(projectIds),
      () => setActionError("Pinned projects could not be refreshed."),
    );
  });
  useRealtime("project-groups-changed", () => {
    void rpc.call("listProjectGroups").then(
      ({ groups }) => setProjectGroups(groups),
      () => setActionError("Project groups could not be refreshed."),
    );
  });
  useRealtime("hidden-projects-changed", () => {
    void rpc.call("listHiddenProjects").then(
      ({ projectIds }) => setHiddenIds(projectIds),
      () => setActionError("Hidden projects could not be refreshed."),
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

  const projectGroupIds = useMemo(() => {
    const groupIds = new Map<string, string>();
    for (const group of projectGroups) {
      for (const groupedProjectId of group.projectIds) {
        if (!groupIds.has(groupedProjectId)) groupIds.set(groupedProjectId, group.id);
      }
    }
    return groupIds;
  }, [projectGroups]);

  if (status === "error") {
    return (
      <p role="alert" className="py-2 text-sm text-destructive">
        Projects could not be loaded.
      </p>
    );
  }

  if (status === "loading" || preferencesStatus === "loading") {
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        Loading projects...
      </p>
    );
  }

  if (rankedProjects.length === 0) {
    const emptyStateError =
      actionError ??
      (preferencesStatus === "error"
        ? "Some homepage preferences could not be loaded."
        : null);
    return (
      <div className="py-2">
        {emptyStateError ? (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {emptyStateError}
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          No projects yet.
        </p>
      </div>
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

  function moveProjectInManualOrder(
    sourceId: string,
    targetId: string,
    position: "after" | "before",
  ): void {
    if (sourceId === targetId) return;
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

  function reorderProject(
    sourceId: string,
    targetId: string,
    position: "after" | "before",
  ): void {
    if (projectSectionFor(sourceId) !== projectSectionFor(targetId)) return;
    moveProjectInManualOrder(sourceId, targetId, position);
  }

  function moveProjectByOffset(targetId: string, offset: -1 | 1): void {
    const sectionId = projectSectionFor(targetId);
    const sectionProjects = rankedProjects.filter(
      (project) => projectSectionFor(project.id) === sectionId,
    );
    const index = sectionProjects.findIndex((project) => project.id === targetId);
    const target = sectionProjects[index + offset];
    if (!target) return;
    reorderProject(targetId, target.id, offset === -1 ? "before" : "after");
  }

  function projectSectionFor(targetId: string): ProjectSectionId {
    if (pinnedIds.includes(targetId)) return "pinned";
    const groupId = projectGroupIds.get(targetId);
    return groupId ? `group:${groupId}` : "ungrouped";
  }

  function togglePin(targetId: string, pinned: boolean): void {
    setActionError(null);
    void rpc.call("setProjectPinned", { projectId: targetId, pinned }).then(
      ({ projectIds }) => setPinnedIds(projectIds),
      () => setActionError(
        pinned ? "Project could not be pinned." : "Project could not be unpinned.",
      ),
    );
  }

  function assignProjectToGroup(targetId: string, groupId: string | null): void {
    setActionError(null);
    setProjectGroups((current) => current.map((group) => ({
      ...group,
      projectIds: group.id === groupId
        ? [...group.projectIds.filter((id) => id !== targetId), targetId]
        : group.projectIds.filter((id) => id !== targetId),
    })));
    void rpc.call("setProjectGroup", { projectId: targetId, groupId }).then(
      ({ groups }) => setProjectGroups(groups),
      () => {
        setActionError("Project group could not be changed.");
        void rpc.call("listProjectGroups").then(
          ({ groups }) => setProjectGroups(groups),
          () => setActionError(
            "Project group could not be changed or refreshed.",
          ),
        );
      },
    );
  }

  function openCreateGroup(projectId?: string): void {
    setGroupEditor({ mode: "create", projectId });
    setGroupName("");
    setGroupError(null);
  }

  function openRenameGroup(group: ProjectGroup): void {
    setGroupEditor({ mode: "rename", groupId: group.id });
    setGroupName(group.name);
    setGroupError(null);
  }

  function closeGroupEditor(): void {
    if (isSavingGroup) return;
    setGroupEditor(null);
    setGroupName("");
    setGroupError(null);
  }

  function submitGroup(): void {
    if (!groupEditor || isSavingGroup) return;
    const name = groupName.trim();
    if (!name) {
      setGroupError("Enter a group name.");
      return;
    }

    setIsSavingGroup(true);
    setGroupError(null);
    const request = groupEditor.mode === "create"
      ? rpc.call("createProjectGroup", {
          name,
          ...(groupEditor.projectId ? { projectId: groupEditor.projectId } : {}),
        })
      : rpc.call("renameProjectGroup", { groupId: groupEditor.groupId, name });
    void request.then(
      ({ groups }) => {
        setProjectGroups(groups);
        setGroupEditor(null);
        setGroupName("");
        setIsSavingGroup(false);
      },
      () => {
        setGroupError(
          groupEditor.mode === "create"
            ? "Group could not be created."
            : "Group could not be renamed.",
        );
        setIsSavingGroup(false);
      },
    );
  }

  function deleteGroup(group: ProjectGroup): void {
    if (!window.confirm(`Delete the group "${group.name}"? Its projects will return to All projects.`)) {
      return;
    }
    setActionError(null);
    setProjectGroups((current) => current.filter((candidate) => candidate.id !== group.id));
    setCollapsedGroupIds((current) => {
      const next = current.filter((groupId) => groupId !== group.id);
      storeCollapsedGroupIds(next);
      return next;
    });
    void rpc.call("deleteProjectGroup", { groupId: group.id }).then(
      ({ groups }) => setProjectGroups(groups),
      () => {
        setActionError("Group could not be deleted.");
        void rpc.call("listProjectGroups").then(
          ({ groups }) => setProjectGroups(groups),
          () => setActionError("Group could not be deleted or refreshed."),
        );
      },
    );
  }

  function toggleGroupCollapsed(groupId: string): void {
    setCollapsedGroupIds((current) => {
      const next = current.includes(groupId)
        ? current.filter((candidate) => candidate !== groupId)
        : [...current, groupId];
      storeCollapsedGroupIds(next);
      return next;
    });
  }

  function saveGroupOrder(groups: readonly ProjectGroup[]): void {
    setActionError(null);
    setProjectGroups(groups);
    void rpc.call("reorderProjectGroups", {
      groupIds: groups.map((group) => group.id),
    }).then(
      ({ groups: savedGroups }) => setProjectGroups(savedGroups),
      () => {
        setActionError("Group order could not be saved.");
        void rpc.call("listProjectGroups").then(
          ({ groups: savedGroups }) => setProjectGroups(savedGroups),
          () => setActionError("Group order could not be saved or refreshed."),
        );
      },
    );
  }

  function moveGroup(
    sourceId: string,
    targetId: string,
    position: "after" | "before",
  ): void {
    if (sourceId === targetId) return;
    const groups = [...projectGroups];
    const sourceIndex = groups.findIndex((group) => group.id === sourceId);
    if (sourceIndex === -1 || !groups.some((group) => group.id === targetId)) return;

    const [movedGroup] = groups.splice(sourceIndex, 1);
    const targetIndex = groups.findIndex((group) => group.id === targetId);
    groups.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, movedGroup!);
    saveGroupOrder(groups);
  }

  function moveGroupByOffset(groupId: string, offset: -1 | 1): void {
    const index = projectGroups.findIndex((group) => group.id === groupId);
    const target = projectGroups[index + offset];
    if (!target) return;
    moveGroup(groupId, target.id, offset === -1 ? "before" : "after");
  }

  function updateGroupDropTarget(next: GroupDropTarget | null): void {
    groupDropTargetRef.current = next;
    setGroupDropTarget(next);
  }

  function updateGroupPointerDropTarget(clientX: number, clientY: number): void {
    const gesture = groupPointerDragRef.current;
    if (!gesture?.started) return;

    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const targetGroup = hit?.closest<HTMLElement>("[data-project-group-id]") ?? null;
    const targetId = targetGroup?.dataset.projectGroupId;
    if (!targetGroup || !targetId || targetId === gesture.groupId) {
      updateGroupDropTarget(null);
      return;
    }

    const targetHeader = targetGroup.querySelector<HTMLElement>(
      "[data-project-group-header]",
    );
    const bounds = (targetHeader ?? targetGroup).getBoundingClientRect();
    updateGroupDropTarget({
      groupId: targetId,
      position: clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  }

  function clearGroupDragState(): void {
    groupPointerDragRef.current = null;
    groupDropTargetRef.current = null;
    setDraggedGroupId(null);
    setGroupDropTarget(null);
  }

  function finishGroupPointerDrag(
    groupId: string,
    currentTarget: HTMLElement,
    pointerId: number,
  ): void {
    const gesture = groupPointerDragRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;

    const target = groupDropTargetRef.current;
    if (gesture.started && target) {
      moveGroup(groupId, target.groupId, target.position);
    }
    if (currentTarget.hasPointerCapture?.(pointerId)) {
      currentTarget.releasePointerCapture(pointerId);
    }
    clearGroupDragState();
  }

  function hideProject(targetId: string): void {
    setActionError(null);
    setHiddenIds((current) =>
      current.includes(targetId) ? current : [...current, targetId],
    );
    void rpc.call("setProjectHidden", { projectId: targetId, hidden: true }).then(
      ({ projectIds }) => setHiddenIds(projectIds),
      () => {
        setActionError("Project could not be hidden.");
        void rpc.call("listHiddenProjects").then(
          ({ projectIds }) => setHiddenIds(projectIds),
          () => {
            setHiddenIds((current) => current.filter((id) => id !== targetId));
            setActionError("Project could not be hidden or refreshed.");
          },
        );
      },
    );
  }

  function updateDropTarget(next: ProjectDropTarget | null): void {
    dropTargetRef.current = next;
    setDropTarget(next);
  }

  function updateSectionDropTarget(next: ProjectSectionId | null): void {
    sectionDropTargetRef.current = next;
    setSectionDropTarget(next);
  }

  function clearDragState(): void {
    pointerDragRef.current = null;
    dropTargetRef.current = null;
    sectionDropTargetRef.current = null;
    setDraggedProjectId(null);
    setDropTarget(null);
    setSectionDropTarget(null);
  }

  function moveProjectToSection(sourceId: string, sectionId: ProjectSectionId): void {
    if (projectSectionFor(sourceId) === sectionId) return;

    const destinationProjects = rankedProjects.filter(
      (project) =>
        project.id !== sourceId &&
        projectSectionFor(project.id) === sectionId,
    );
    const lastDestination = destinationProjects.at(-1);
    if (lastDestination) {
      moveProjectInManualOrder(sourceId, lastDestination.id, "after");
    }
    if (sectionId === "pinned") {
      togglePin(sourceId, true);
      return;
    }

    if (pinnedIds.includes(sourceId)) togglePin(sourceId, false);
    assignProjectToGroup(
      sourceId,
      sectionId.startsWith("group:") ? sectionId.slice("group:".length) : null,
    );
  }

  function updatePointerDropTarget(clientX: number, clientY: number): void {
    const gesture = pointerDragRef.current;
    if (!gesture?.started) return;

    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const targetCard = hit?.closest<HTMLElement>("[data-project-id]") ?? null;
    if (targetCard) {
      const targetId = targetCard.dataset.projectId;
      if (targetId && targetId !== gesture.projectId) {
        const sourceSection = projectSectionFor(gesture.projectId);
        if (projectSectionFor(targetId) === sourceSection) {
          const bounds = targetCard.getBoundingClientRect();
          updateDropTarget({
            projectId: targetId,
            position:
              clientY < bounds.top + bounds.height / 2 ? "before" : "after",
          });
          updateSectionDropTarget(null);
          return;
        }
      }
    }

    const targetSection = hit?.closest<HTMLElement>("[data-project-section]");
    const section = targetSection?.dataset.projectSection as
      | ProjectSectionId
      | undefined;
    if (section && projectSectionFor(gesture.projectId) !== section) {
      updateDropTarget(null);
      updateSectionDropTarget(section);
      return;
    }

    updateDropTarget(null);
    updateSectionDropTarget(null);
  }

  function finishPointerDrag(
    projectId: string,
    currentTarget: HTMLElement,
    pointerId: number,
  ): void {
    const gesture = pointerDragRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;

    if (gesture.started) {
      const target = dropTargetRef.current;
      const targetSection = sectionDropTargetRef.current;
      if (target) {
        reorderProject(projectId, target.projectId, target.position);
      } else if (targetSection) {
        moveProjectToSection(projectId, targetSection);
      }

      suppressClickRef.current = projectId;
      window.setTimeout(() => {
        if (suppressClickRef.current === projectId) suppressClickRef.current = null;
      }, 0);
    }

    if (currentTarget.hasPointerCapture?.(pointerId)) {
      currentTarget.releasePointerCapture(pointerId);
    }
    clearDragState();
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
      ? visibleProjects.filter((project) => pinnedIds.includes(project.id))
      : pinnedIds
          .map((id) => visibleProjects.find((project) => project.id === id))
          .filter((project): project is RankedProject => project !== undefined);
  const groupedProjects = projectGroups.map((group) => ({
    group,
    projects: visibleProjects.filter(
      (project) =>
        !pinnedIds.includes(project.id) && projectGroupIds.get(project.id) === group.id,
    ),
  }));
  const visibleGroupedProjects = attentionFilter
    ? groupedProjects.filter(({ projects: projectsInGroup }) => projectsInGroup.length > 0)
    : groupedProjects;
  const ungroupedProjects = visibleProjects.filter(
    (project) =>
      !pinnedIds.includes(project.id) && !projectGroupIds.has(project.id),
  );
  const isManualDragging = rankingMode === "Manual" && draggedProjectId !== null;
  const showPinnedSection = pinnedProjects.length > 0 || isManualDragging;
  const showUngroupedSection =
    ungroupedProjects.length > 0 ||
    (isManualDragging && draggedProjectId !== null &&
      projectSectionFor(draggedProjectId) !== "ungrouped");

  function renderProject(project: RankedProject) {
    const isCurrent = project.id === activeProjectId;
    const isPinned = pinnedIds.includes(project.id);
    const currentGroupId = projectGroupIds.get(project.id) ?? null;
    const isEditing = renameTarget?.id === project.id;
    const isManual = rankingMode === "Manual" && !attentionFilter;
    const attention = attentionByProject.get(project.id);
    const workspace =
      showWorkspaceStatus && !project.isPersonal ? workspaceStatuses[project.id] : undefined;
    const workspaceLine = workspace?.kind === "available" ? workspace : null;
    const manualSectionProjects = isManual
      ? rankedProjects.filter(
          (candidate) =>
            projectSectionFor(candidate.id) === projectSectionFor(project.id),
        )
      : [];
    const manualSectionIndex = manualSectionProjects.findIndex(
      (candidate) => candidate.id === project.id,
    );
    const isDragging = draggedProjectId === project.id;
    const activity = activityByProject.get(project.id) ?? [];
    const className = [
      "@container flex w-full min-w-0 items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors group-hover:border-foreground/20 group-hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      isCurrent ? "border-foreground/20 bg-state-hover" : "border-border",
      !isEditing ? (isDragging ? "cursor-grabbing select-none" : "cursor-pointer") : "",
      isDragging ? "opacity-50" : "",
    ].join(" ");

    const menuItemClassName =
      "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-state-hover data-[state=open]:bg-state-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";

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
        <span className="min-w-0">
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
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <span className="truncate text-sm font-medium text-foreground">
                {project.name}
              </span>
              <AttentionPill attention={attention} />
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
          <NewChatSparkline
            projectName={project.name}
            activity={activity}
            animate={animateSparklinesRef.current}
          />
        ) : null}
        {!isEditing && showWorkspaceStatus && !project.isPersonal ? (
          workspaceLine && workspaceLine.worktrees > 0 ? (
            <WorkspaceHoverCard projectId={project.id} status={workspaceLine}>
              <span
                data-workspace-status=""
                data-workspace-worktrees={workspaceLine.worktrees}
                className={WORKSPACE_COLUMN_CLASSES}
              >
                <WorkspaceStatusBlock status={workspaceLine} />
              </span>
            </WorkspaceHoverCard>
          ) : workspaceLine ? (
            <span data-workspace-status="" className={WORKSPACE_COLUMN_CLASSES}>
              <WorkspaceStatusBlock status={workspaceLine} />
            </span>
          ) : (
            // Keep the column so sparklines line up across cards without a checkout.
            <span aria-hidden="true" className={WORKSPACE_COLUMN_CLASSES} />
          )
        ) : null}
      </>
    );

    return (
      <ContextMenu.Root key={project.id}>
        <ContextMenu.Trigger asChild disabled={isEditing}>
          <div
            className="group relative"
            data-project-id={project.id}
            onPointerDown={(event) => {
              if (
                !isManual ||
                isEditing ||
                event.button > 0 ||
                event.isPrimary === false
              ) {
                return;
              }
              pointerDragRef.current = {
                projectId: project.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                started: false,
              };
            }}
            onPointerMove={(event) => {
              const gesture = pointerDragRef.current;
              if (!gesture || gesture.pointerId !== event.pointerId) return;
              if (!gesture.started) {
                const distance = Math.hypot(
                  event.clientX - gesture.startX,
                  event.clientY - gesture.startY,
                );
                if (distance < DRAG_ACTIVATION_DISTANCE) return;
                gesture.started = true;
                setDraggedProjectId(gesture.projectId);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }
              event.preventDefault();
              updatePointerDropTarget(event.clientX, event.clientY);
            }}
            onPointerUp={(event) => {
              finishPointerDrag(project.id, event.currentTarget, event.pointerId);
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              clearDragState();
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
                aria-keyshortcuts={
                  isManual ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                }
                onKeyDown={(event) => {
                  if (!isManual || !event.altKey) return;
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveProjectByOffset(project.id, -1);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveProjectByOffset(project.id, 1);
                  }
                }}
                onClick={() => {
                  if (suppressClickRef.current === project.id) {
                    suppressClickRef.current = null;
                    return;
                  }
                  setLastClickedProjectId(project.id);
                  actions.openNewThread({ projectId: project.id, focusPrompt: true })
                }}
              >
                {cardContent}
              </button>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content data-bb-plugin="homepage" className="z-50 min-w-[10rem] rounded-md border border-border bg-card p-1 shadow-md">
            <ContextMenu.Item
              className={menuItemClassName}
              onSelect={() => {
                setLastClickedProjectId(project.id);
                actions.openNewThread({ projectId: project.id, focusPrompt: true })
              }}
            >
              New chat
            </ContextMenu.Item>
            <ProjectOpenMenu
              projectId={project.id}
              itemClassName={menuItemClassName}
              onError={setActionError}
            />
            <ContextMenu.Item
              className={menuItemClassName}
              onSelect={() => togglePin(project.id, !isPinned)}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenu.Item>
            {isManual ? (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Item
                  className={menuItemClassName}
                  disabled={manualSectionIndex <= 0}
                  onSelect={() => moveProjectByOffset(project.id, -1)}
                >
                  Move up
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={menuItemClassName}
                  disabled={manualSectionIndex >= manualSectionProjects.length - 1}
                  onSelect={() => moveProjectByOffset(project.id, 1)}
                >
                  Move down
                </ContextMenu.Item>
              </>
            ) : null}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={`${menuItemClassName} justify-between`}>
                <span>Move to group</span>
                <span aria-hidden="true">›</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent data-bb-plugin="homepage" className="z-50 min-w-[10rem] rounded-md border border-border bg-card p-1 shadow-md">
                  <ContextMenu.Item
                    className={menuItemClassName}
                    disabled={currentGroupId === null}
                    onSelect={() => assignProjectToGroup(project.id, null)}
                  >
                    <span className="w-3" aria-hidden="true">
                      {currentGroupId === null ? "✓" : ""}
                    </span>
                    No group
                  </ContextMenu.Item>
                  {projectGroups.map((group) => (
                    <ContextMenu.Item
                      key={group.id}
                      className={menuItemClassName}
                      disabled={currentGroupId === group.id}
                      onSelect={() => assignProjectToGroup(project.id, group.id)}
                    >
                      <span className="w-3" aria-hidden="true">
                        {currentGroupId === group.id ? "✓" : ""}
                      </span>
                      {group.name}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="my-1 h-px bg-border" />
                  <ContextMenu.Item
                    className={menuItemClassName}
                    onSelect={() => openCreateGroup(project.id)}
                  >
                    New group...
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            {!project.isPersonal ? (
              <ContextMenu.Item
                className={menuItemClassName}
                onSelect={() => startRenaming(project)}
              >
                Rename
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              className={menuItemClassName}
              onSelect={() => hideProject(project.id)}
            >
              Hide project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }

  return (
    <div className="relative">
      <div
        data-homepage-sort=""
        className="absolute -top-9 right-0 z-10 flex items-center justify-end gap-2"
      >
        {needsYouProjectCount > 0 || attentionFilter ? (
          <button
            type="button"
            aria-pressed={attentionFilter}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              attentionFilter
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-state-hover hover:text-foreground"
            }`}
            onClick={() => setAttentionFilter((current) => !current)}
          >
            <span>Needs you</span>
            <span className="rounded-full bg-primary/10 px-1.5 text-[10px] leading-4 text-primary">
              {needsYouProjectCount}
            </span>
          </button>
        ) : null}
        {showWorkspaceStatus ? (
          <button
            type="button"
            aria-label="Refresh checkout status"
            title={
              workspaceUpdatedAt === null
                ? "Refresh checkout status"
                : `Updated ${formatRelativeTime(workspaceUpdatedAt, now)}`
            }
            disabled={isRefreshingWorkspaces}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            onClick={refreshWorkspaceStatuses}
          >
            <RefreshIcon spinning={isRefreshingWorkspaces} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="New group"
          title="New group"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => openCreateGroup()}
        >
          <svg viewBox="0 0 16 16" fill="none" className="size-5" aria-hidden="true">
            <path
              d="M8 3.25v9.5M3.25 8h9.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Sort</span>
          <select
            aria-label="Sort projects"
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none"
            value={rankingMode}
            onPointerDown={() => {
              sortPointerSelectionRef.current = true;
            }}
            onKeyDown={() => {
              sortPointerSelectionRef.current = false;
            }}
            onBlur={() => {
              sortPointerSelectionRef.current = false;
            }}
            onChange={(event) => {
              changeRankingMode(event.target.value);
              if (sortPointerSelectionRef.current) event.currentTarget.blur();
            }}
          >
            {RANKING_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      {actionError || preferencesStatus === "error" ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {actionError ?? "Some homepage preferences could not be loaded."}
        </p>
      ) : null}
      {groupEditor ? (
        <form
          aria-label={groupEditor.mode === "create" ? "Create project group" : "Rename project group"}
          className="mb-4 rounded-lg border border-border bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitGroup();
          }}
        >
          <label className="block text-xs font-medium text-foreground">
            Group name
            <input
              autoFocus
              aria-invalid={groupError ? "true" : undefined}
              disabled={isSavingGroup}
              maxLength={80}
              value={groupName}
              className="mt-1.5 h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/20"
              onChange={(event) => {
                setGroupName(event.target.value);
                setGroupError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeGroupEditor();
                }
              }}
            />
          </label>
          {groupError ? (
            <p role="alert" className="mt-1.5 text-xs text-destructive">
              {groupError}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={isSavingGroup}
              className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
              onClick={closeGroupEditor}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSavingGroup}
              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {isSavingGroup
                ? "Saving..."
                : groupEditor.mode === "create"
                  ? "Create group"
                  : "Save"}
            </button>
          </div>
        </form>
      ) : null}
      {showPinnedSection ? (
        <div
          data-project-section="pinned"
          className="mb-4"
        >
          <p
            className={`mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
              sectionDropTarget === "pinned"
                ? "text-primary"
                : "text-muted-foreground"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="size-3" aria-hidden="true">
              <path d="M4.75 2.5h6.5a.5.5 0 0 1 .5.5v10.15a.25.25 0 0 1-.4.2L8 10.9l-3.35 2.45a.25.25 0 0 1-.4-.2V3a.5.5 0 0 1 .5-.5z" />
            </svg>
            <span>Pinned</span>
            {sectionDropTarget === "pinned" ? (
              <span
                aria-hidden="true"
                data-section-drop-accent="pinned"
                className="h-px flex-1 bg-primary"
              />
            ) : null}
          </p>
          {pinnedProjects.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {pinnedProjects.map(renderProject)}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground">
              Drop here to pin
            </div>
          )}
        </div>
      ) : null}
      {attentionFilter && visibleProjects.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground"
        >
          Nothing needs you right now.
        </p>
      ) : null}
      {visibleGroupedProjects.map(({ group, projects: projectsInGroup }, groupIndex) => (
        <div
          key={group.id}
          data-project-group-id={group.id}
          data-project-section={`group:${group.id}`}
          className={`group/section relative ${
            collapsedGroupIds.includes(group.id) ? "mb-2" : "mb-4"
          } ${
            draggedGroupId === group.id ? "opacity-50" : ""
          }`}
        >
          {groupDropTarget?.groupId === group.id ? (
            <span
              aria-hidden="true"
              data-group-drop-accent={groupDropTarget.position}
              className={`pointer-events-none absolute left-0 right-0 z-20 h-0.5 rounded-full bg-primary ${
                groupDropTarget.position === "before" ? "-top-1" : "bottom-0"
              }`}
            />
          ) : null}
          <div
            data-project-group-header=""
            title="Drag to reorder groups"
            className={`group/header flex cursor-grab select-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
              collapsedGroupIds.includes(group.id) ? "mb-0" : "mb-2"
            } ${
              draggedGroupId === group.id ? "cursor-grabbing" : ""
            } ${
              sectionDropTarget === `group:${group.id}`
                ? "text-primary"
                : "text-muted-foreground"
            }`}
            onPointerDown={(event) => {
              if (
                event.button > 0 ||
                event.isPrimary === false ||
                (event.target as HTMLElement).closest?.("button")
              ) {
                return;
              }
              groupPointerDragRef.current = {
                groupId: group.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                started: false,
              };
            }}
            onPointerMove={(event) => {
              const gesture = groupPointerDragRef.current;
              if (!gesture || gesture.pointerId !== event.pointerId) return;
              if (!gesture.started) {
                const distance = Math.hypot(
                  event.clientX - gesture.startX,
                  event.clientY - gesture.startY,
                );
                if (distance < DRAG_ACTIVATION_DISTANCE) return;
                gesture.started = true;
                setDraggedGroupId(gesture.groupId);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }
              event.preventDefault();
              updateGroupPointerDropTarget(event.clientX, event.clientY);
            }}
            onPointerUp={(event) => {
              finishGroupPointerDrag(group.id, event.currentTarget, event.pointerId);
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              clearGroupDragState();
            }}
          >
            <span aria-hidden="true" className="relative size-4 shrink-0">
              <span className="absolute inset-0 transition-opacity group-hover/header:opacity-0 [@media(hover:none)]:opacity-0">
                <FolderIcon />
              </span>
              <svg
                viewBox="0 0 12 16"
                fill="none"
                className="absolute inset-0 h-4 w-3 opacity-0 transition-opacity group-hover/header:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <path
                  d="M3.5 4h.01M8.5 4h.01M3.5 8h.01M8.5 8h.01M3.5 12h.01M8.5 12h.01"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <button
              type="button"
              aria-expanded={!collapsedGroupIds.includes(group.id)}
              aria-label={`${
                collapsedGroupIds.includes(group.id) ? "Expand" : "Collapse"
              } ${group.name} group`}
              className="flex min-w-0 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => toggleGroupCollapsed(group.id)}
            >
              <span className="truncate">{group.name}</span>
              {collapsedGroupIds.includes(group.id) ? (
                <GroupAttentionSummary
                  projects={projectsInGroup}
                  attentionByProject={attentionByProject}
                />
              ) : null}
              <svg
                viewBox="0 0 12 12"
                fill="none"
                className={`size-3 shrink-0 transition-transform ${
                  collapsedGroupIds.includes(group.id) ? "-rotate-90" : ""
                }`}
                aria-hidden="true"
              >
                <path
                  d="m3 4.5 3 3 3-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={`Manage ${group.name} group`}
                  title="Group actions"
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/section:opacity-100 data-[state=open]:bg-state-hover data-[state=open]:opacity-100 [@media(hover:none)]:opacity-50"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="size-4" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.1" />
                    <circle cx="8" cy="8" r="1.1" />
                    <circle cx="13" cy="8" r="1.1" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-50 min-w-[8rem] rounded-md border border-border bg-card p-1 normal-case tracking-normal shadow-md"
                >
                  <DropdownMenu.Item
                    disabled={groupIndex === 0}
                    className="cursor-default select-none rounded-sm px-2 py-1.5 text-sm text-foreground outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-state-hover"
                    onSelect={() => moveGroupByOffset(group.id, -1)}
                  >
                    Move up
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={groupIndex === groupedProjects.length - 1}
                    className="cursor-default select-none rounded-sm px-2 py-1.5 text-sm text-foreground outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-state-hover"
                    onSelect={() => moveGroupByOffset(group.id, 1)}
                  >
                    Move down
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    className="cursor-default select-none rounded-sm px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-state-hover"
                    onSelect={() => openRenameGroup(group)}
                  >
                    Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="cursor-default select-none rounded-sm px-2 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10"
                    onSelect={() => deleteGroup(group)}
                  >
                    Delete group
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {sectionDropTarget === `group:${group.id}` ? (
              <span
                aria-hidden="true"
                data-section-drop-accent={`group:${group.id}`}
                className="h-px flex-1 bg-primary"
              />
            ) : (
              <span className="flex-1" />
            )}
          </div>
          {collapsedGroupIds.includes(group.id) ? null : projectsInGroup.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {projectsInGroup.map(renderProject)}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground">
              {isManualDragging ? "Drop here to move" : "No projects in this group"}
            </div>
          )}
        </div>
      ))}
      {showUngroupedSection ? (
        <div
          data-project-section="ungrouped"
        >
          {showPinnedSection || projectGroups.length > 0 ? (
            <p
              className={`mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                sectionDropTarget === "ungrouped"
                  ? "text-primary"
                  : "text-muted-foreground"
              }`}
            >
              <span>All projects</span>
              {sectionDropTarget === "ungrouped" ? (
                <span
                  aria-hidden="true"
                  data-section-drop-accent="ungrouped"
                  className="h-px flex-1 bg-primary"
                />
              ) : null}
            </p>
          ) : null}
          {ungroupedProjects.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {ungroupedProjects.map(renderProject)}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground">
              Drop here to remove from its section
            </div>
          )}
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

function readCollapsedGroupIds(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];

    const uniqueIds = new Set<string>();
    for (const value of stored) {
      if (typeof value === "string" && value.length > 0) uniqueIds.add(value);
      if (uniqueIds.size === 100) break;
    }
    return [...uniqueIds];
  } catch {
    return [];
  }
}

function storeCollapsedGroupIds(groupIds: readonly string[]): void {
  try {
    window.localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(groupIds),
    );
  } catch {
    // Browser storage can be unavailable; collapsing still works for this page.
  }
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-homepage-recent-chats",
    mount() {
      const style = document.createElement("style");
      style.dataset.bbHomepageHideRecents = "";
      style.textContent = `
        [data-root-compose-mobile-recents] {
          display: none !important;
        }

        /*
         * bb's compact home anchors a short scroll viewport just above the
         * composer (sized for its own recent-chats list), which leaves the
         * top of the screen empty once that list is hidden. Extend the
         * viewport up to the host's minimum toolbar clearance so the project
         * launcher fills the page instead.
         */
        [data-testid="root-compose-compact-scroll-viewport"] {
          top: calc(56px + env(safe-area-inset-top, 0px)) !important;
        }

        [data-testid="root-compose-compact-recents-offset"] {
          height: 0 !important;
        }
      `;
      document.head.append(style);

      return () => style.remove();
    },
  });

  app.slots.homepageSection({
    id: "project-chat-launcher",
    title: "Start in a project",
    component: ProjectChatLauncher,
  });

  app.slots.settingsSection({
    id: "hidden-projects",
    title: "Hidden projects",
    description: "Restore every project hidden from the homepage.",
    component: HiddenProjectsSettings,
  });
});
