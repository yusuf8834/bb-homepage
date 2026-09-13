export const RANKING_OPTIONS = [
  "Recent activity",
  "Most chats",
  "Alphabetical",
  "Manual",
] as const;

export type RankingMode = (typeof RANKING_OPTIONS)[number];

export const WORKSPACE_REFRESH_OPTIONS = [
  "Manual",
  "Every minute",
  "Every 5 minutes",
  "Every 15 minutes",
] as const;

export type WorkspaceRefreshMode = (typeof WORKSPACE_REFRESH_OPTIONS)[number];

const WORKSPACE_REFRESH_INTERVALS: Record<WorkspaceRefreshMode, number | null> = {
  Manual: null,
  "Every minute": 60_000,
  "Every 5 minutes": 5 * 60_000,
  "Every 15 minutes": 15 * 60_000,
};

export interface HomepageSettings {
  rankingMode: RankingMode;
  showChatCounts: boolean;
  showUnusedProjects: boolean;
  includePersonalProject: boolean;
  loadProjectIcons: boolean;
  showWorkspaceStatus: boolean;
  workspaceRefresh: WorkspaceRefreshMode;
}

export type HomepagePluginSettings = Omit<HomepageSettings, "rankingMode">;

type BooleanSettingKey = {
  [Key in keyof HomepageSettings]: HomepageSettings[Key] extends boolean ? Key : never;
}[keyof HomepageSettings];

const DEFAULT_HOMEPAGE_SETTINGS: HomepageSettings = {
  rankingMode: "Recent activity",
  showChatCounts: true,
  showUnusedProjects: true,
  includePersonalProject: true,
  loadProjectIcons: true,
  showWorkspaceStatus: true,
  workspaceRefresh: "Manual",
};

export function parseHomepageSettings(
  values: Record<string, string | number | boolean> | undefined,
): HomepagePluginSettings {
  return {
    showChatCounts: booleanSetting(values, "showChatCounts"),
    showUnusedProjects: booleanSetting(values, "showUnusedProjects"),
    includePersonalProject: booleanSetting(values, "includePersonalProject"),
    loadProjectIcons: booleanSetting(values, "loadProjectIcons"),
    showWorkspaceStatus: booleanSetting(values, "showWorkspaceStatus"),
    workspaceRefresh: parseWorkspaceRefreshMode(values?.workspaceRefresh),
  };
}

export function parseRankingMode(value: unknown): RankingMode {
  return (
    RANKING_OPTIONS.find((option) => option === value) ??
    DEFAULT_HOMEPAGE_SETTINGS.rankingMode
  );
}

export function parseWorkspaceRefreshMode(value: unknown): WorkspaceRefreshMode {
  return (
    WORKSPACE_REFRESH_OPTIONS.find((option) => option === value) ??
    DEFAULT_HOMEPAGE_SETTINGS.workspaceRefresh
  );
}

/** Milliseconds between automatic status refreshes; null for manual only. */
export function workspaceRefreshIntervalMs(mode: WorkspaceRefreshMode): number | null {
  return WORKSPACE_REFRESH_INTERVALS[mode];
}

function booleanSetting(
  values: Record<string, string | number | boolean> | undefined,
  key: BooleanSettingKey,
): boolean {
  const value = values?.[key];
  return typeof value === "boolean" ? value : DEFAULT_HOMEPAGE_SETTINGS[key];
}
