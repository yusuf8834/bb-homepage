import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** Live thread states a project card rolls up, in display precedence. */
export interface ProjectAttention {
  needsYou: number;
  failed: number;
  running: number;
}

export type AttentionKind = keyof ProjectAttention;

const EMPTY_ATTENTION: ProjectAttention = { needsYou: 0, failed: 0, running: 0 };

const RUNNING_INDICATORS: ReadonlySet<string> = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "plan-mode",
  "goal",
]);

function isRunning(thread: PluginSidebarThread): boolean {
  if (RUNNING_INDICATORS.has(thread.indicator)) return true;
  const activity = thread.activity;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0
  );
}

/**
 * Count, per project, the unarchived threads that are blocked on the user,
 * ended in an unread error, or are still working. Child threads count too: a
 * spawned agent asking a question needs the user as much as its parent does.
 */
export function buildProjectAttention(
  threads: readonly PluginSidebarThread[],
): Map<string, ProjectAttention> {
  const byProject = new Map<string, ProjectAttention>();
  for (const thread of threads) {
    if (thread.isArchived) continue;
    const needsYou =
      thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
    const failed = thread.indicator === "unread-error";
    const running = !needsYou && !failed && isRunning(thread);
    if (!needsYou && !failed && !running) continue;

    const current = byProject.get(thread.projectId) ?? { ...EMPTY_ATTENTION };
    if (needsYou) current.needsYou += 1;
    else if (failed) current.failed += 1;
    else current.running += 1;
    byProject.set(thread.projectId, current);
  }
  return byProject;
}

export function sumAttention(
  attentions: Iterable<ProjectAttention | undefined>,
): ProjectAttention {
  const total = { ...EMPTY_ATTENTION };
  for (const attention of attentions) {
    if (!attention) continue;
    total.needsYou += attention.needsYou;
    total.failed += attention.failed;
    total.running += attention.running;
  }
  return total;
}

/** The single state a card pill shows: attention before failure before work. */
export function primaryAttention(
  attention: ProjectAttention | undefined,
): { kind: AttentionKind; count: number } | null {
  if (!attention) return null;
  if (attention.needsYou > 0) return { kind: "needsYou", count: attention.needsYou };
  if (attention.failed > 0) return { kind: "failed", count: attention.failed };
  if (attention.running > 0) return { kind: "running", count: attention.running };
  return null;
}

export function formatAttention(kind: AttentionKind, count: number): string {
  switch (kind) {
    case "needsYou":
      return count === 1 ? "Needs you" : `${count} need you`;
    case "failed":
      return count === 1 ? "Failed" : `${count} failed`;
    case "running":
      return count === 1 ? "Running" : `${count} running`;
  }
}

/** "2 need you · 1 failed · 3 running", or null when nothing is happening. */
export function summarizeAttention(attention: ProjectAttention): string | null {
  const parts: string[] = [];
  if (attention.needsYou > 0) parts.push(formatAttention("needsYou", attention.needsYou));
  if (attention.failed > 0) parts.push(formatAttention("failed", attention.failed));
  if (attention.running > 0) parts.push(formatAttention("running", attention.running));
  return parts.length > 0 ? parts.join(" · ") : null;
}
