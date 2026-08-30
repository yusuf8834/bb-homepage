import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export const ACTIVITY_DAYS = 14;

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function buildNewChatActivity(
  threads: readonly PluginSidebarThread[],
  projectId: string,
  now = Date.now(),
): number[] {
  const dayIndexes = new Map<string, number>();
  const activity = Array.from({ length: ACTIVITY_DAYS }, () => 0);

  for (let index = 0; index < ACTIVITY_DAYS; index += 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (ACTIVITY_DAYS - index - 1));
    dayIndexes.set(localDayKey(date.getTime()), index);
  }

  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.parentThreadId !== null) continue;
    const index = dayIndexes.get(localDayKey(thread.createdAt));
    if (index !== undefined) activity[index] += 1;
  }

  return activity;
}
