import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const ACTIVITY_DAYS = 14;

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function buildNewChatActivityByProject(
  threads: readonly PluginSidebarThread[],
  now = Date.now(),
): Map<string, number[]> {
  const dayIndexes = new Map<string, number>();

  for (let index = 0; index < ACTIVITY_DAYS; index += 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (ACTIVITY_DAYS - index - 1));
    dayIndexes.set(localDayKey(date.getTime()), index);
  }

  const byProject = new Map<string, number[]>();
  for (const thread of threads) {
    if (thread.isArchived || thread.parentThreadId !== null) continue;
    const index = dayIndexes.get(localDayKey(thread.createdAt));
    if (index === undefined) continue;

    let activity = byProject.get(thread.projectId);
    if (activity === undefined) {
      activity = Array.from({ length: ACTIVITY_DAYS }, () => 0);
      byProject.set(thread.projectId, activity);
    }
    activity[index] += 1;
  }
  return byProject;
}
