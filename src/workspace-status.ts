/**
 * Shapes shared by the server RPC and the homepage cards. Plain types only:
 * the app bundle must not pull in zod for them.
 */

export interface WorkspaceChanges {
  files: number;
  insertions: number;
  deletions: number;
  lineStatsComplete: boolean;
}

export type WorkspaceStatus =
  | {
      kind: "available";
      environmentId: string;
      branch: string | null;
      defaultBranch: string | null;
      changes: WorkspaceChanges;
      /** Ready worktree environments this project has besides the checkout. */
      worktrees: number;
      fetchedAt: number;
    }
  | {
      kind: "unavailable";
      environmentId: string;
      message: string;
      fetchedAt: number;
    }
  | {
      /** The project has no ready checkout environment to inspect. */
      kind: "none";
      fetchedAt: number;
    };

export interface WorkspaceWorktree {
  environmentId: string;
  name: string | null;
  branch: string | null;
  status: WorkspaceStatus;
}

export function isOnDefaultBranch(
  status: Extract<WorkspaceStatus, { kind: "available" }>,
): boolean {
  return status.branch === null || status.branch === status.defaultBranch;
}

export function formatFileCount(files: number): string {
  return `${files} file${files === 1 ? "" : "s"}`;
}

export function formatChanges(changes: WorkspaceChanges): string {
  if (changes.files === 0) return "No change";
  return `${formatFileCount(changes.files)}, +${changes.insertions} -${changes.deletions}`;
}

/** Plain-text form of a card's status line, for titles and screen readers. */
export function describeWorkspaceStatus(status: WorkspaceStatus): string | null {
  if (status.kind !== "available") return null;
  const changes = formatChanges(status.changes);
  return isOnDefaultBranch(status) ? changes : `${changes} · ${status.branch}`;
}
