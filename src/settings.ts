export const RANKING_OPTIONS = [
  "Recent activity",
  "Most chats",
  "Alphabetical",
  "Manual",
] as const;

export type RankingMode = (typeof RANKING_OPTIONS)[number];

export interface HomepageSettings {
  rankingMode: RankingMode;
  currentProjectFirst: boolean;
  showChatCounts: boolean;
  showUnusedProjects: boolean;
  includePersonalProject: boolean;
  loadProjectIcons: boolean;
}

export type HomepagePluginSettings = Omit<HomepageSettings, "rankingMode">;

const DEFAULT_HOMEPAGE_SETTINGS: HomepageSettings = {
  rankingMode: "Recent activity",
  currentProjectFirst: true,
  showChatCounts: true,
  showUnusedProjects: true,
  includePersonalProject: true,
  loadProjectIcons: true,
};

export function parseHomepageSettings(
  values: Record<string, string | boolean> | undefined,
): HomepagePluginSettings {
  return {
    currentProjectFirst: booleanSetting(values, "currentProjectFirst"),
    showChatCounts: booleanSetting(values, "showChatCounts"),
    showUnusedProjects: booleanSetting(values, "showUnusedProjects"),
    includePersonalProject: booleanSetting(values, "includePersonalProject"),
    loadProjectIcons: booleanSetting(values, "loadProjectIcons"),
  };
}

export function parseRankingMode(value: unknown): RankingMode {
  return (
    RANKING_OPTIONS.find((option) => option === value) ??
    DEFAULT_HOMEPAGE_SETTINGS.rankingMode
  );
}

function booleanSetting(
  values: Record<string, string | boolean> | undefined,
  key: Exclude<keyof HomepageSettings, "rankingMode">,
): boolean {
  const value = values?.[key];
  return typeof value === "boolean" ? value : DEFAULT_HOMEPAGE_SETTINGS[key];
}
