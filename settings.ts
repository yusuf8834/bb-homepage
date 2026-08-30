export const RANKING_OPTIONS = [
  "Recent activity",
  "Most chats",
  "Alphabetical",
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

export const DEFAULT_HOMEPAGE_SETTINGS: HomepageSettings = {
  rankingMode: "Recent activity",
  currentProjectFirst: true,
  showChatCounts: true,
  showUnusedProjects: true,
  includePersonalProject: true,
  loadProjectIcons: true,
};

export function parseHomepageSettings(
  values: Record<string, string | boolean> | undefined,
): HomepageSettings {
  const rankingMode = RANKING_OPTIONS.find(
    (option) => option === values?.rankingMode,
  );

  return {
    rankingMode: rankingMode ?? DEFAULT_HOMEPAGE_SETTINGS.rankingMode,
    currentProjectFirst: booleanSetting(values, "currentProjectFirst"),
    showChatCounts: booleanSetting(values, "showChatCounts"),
    showUnusedProjects: booleanSetting(values, "showUnusedProjects"),
    includePersonalProject: booleanSetting(values, "includePersonalProject"),
    loadProjectIcons: booleanSetting(values, "loadProjectIcons"),
  };
}

function booleanSetting(
  values: Record<string, string | boolean> | undefined,
  key: Exclude<keyof HomepageSettings, "rankingMode">,
): boolean {
  const value = values?.[key];
  return typeof value === "boolean" ? value : DEFAULT_HOMEPAGE_SETTINGS[key];
}
