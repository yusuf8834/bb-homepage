import { useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginHomepageSectionProps,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  parseHomepageSettings,
  type HomepageSettings,
} from "./settings.js";

const PROJECT_ICON_URL = "/api/v1/plugins/homepage/http/project-icon";

interface RankedProject extends PluginSidebarProject {
  chatCount: number;
  lastUsedAt: number;
}

export function rankProjects(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  settings: HomepageSettings,
  currentProjectId: string | null,
): RankedProject[] {
  const usage = new Map<string, { chatCount: number; lastUsedAt: number }>();

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
      if (settings.currentProjectFirst) {
        const currentOrder =
          Number(right.id === currentProjectId) - Number(left.id === currentProjectId);
        if (currentOrder !== 0) return currentOrder;
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
}: {
  projectId: string;
  isPersonal: boolean;
  loadArtwork: boolean;
}) {
  const [showFallback, setShowFallback] = useState(false);
  const useFallback = isPersonal || !loadArtwork || showFallback;

  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground group-hover:text-foreground"
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

function ProjectChatLauncher({ projectId }: PluginHomepageSectionProps) {
  const { status, projects, threads } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const settingsState = useSettings();
  const settings = useMemo(
    () => parseHomepageSettings(settingsState.values),
    [settingsState.values],
  );
  const rankedProjects = useMemo(
    () => rankProjects(projects, threads, settings, projectId),
    [projects, projectId, settings, threads],
  );

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

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rankedProjects.map((project) => {
        const isCurrent = project.id === projectId;
        const className = [
          "group flex min-w-0 items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isCurrent ? "border-ring bg-state-hover" : "border-border",
        ].join(" ");

        return (
          <button
            key={project.id}
            type="button"
            className={className}
            aria-label={`Start a new chat in ${project.name}`}
            aria-current={isCurrent ? "page" : undefined}
            onClick={() =>
              actions.openNewThread({ projectId: project.id, focusPrompt: true })
            }
          >
            <ProjectIcon
              projectId={project.id}
              isPersonal={project.isPersonal}
              loadArtwork={settings.loadProjectIcons}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {project.name}
              </span>
              {settings.showChatCounts ? (
                <span className="block text-xs text-muted-foreground">
                  {project.chatCount === 0
                    ? "No chats yet"
                    : `${project.chatCount} chat${project.chatCount === 1 ? "" : "s"}`}
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="text-muted-foreground group-hover:text-foreground">
              +
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "project-chat-launcher",
    title: "Start in a project",
    component: ProjectChatLauncher,
  });
});
