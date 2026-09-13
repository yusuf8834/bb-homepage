import type { WorkspaceStatus, WorkspaceWorktree } from "./workspace-status.js";

/** The environment fields the service reads; a subset of BB's Environment. */
export interface WorkspaceEnvironment {
  id: string;
  projectId: string;
  name: string | null;
  branchName: string | null;
  isGitRepo: boolean;
  isWorktree: boolean;
  status: string;
  lifecycle: { phase: string };
  workspaceProvisionType: string | null;
  environmentProviderId: string | null;
  updatedAt: number;
}

export type WorkspaceStatusReading =
  | {
      outcome: "available";
      branch: string | null;
      defaultBranch: string | null;
      files: number;
      insertions: number;
      deletions: number;
      lineStatsComplete: boolean;
    }
  | { outcome: "unavailable"; message: string };

export interface WorkspaceStatusSources {
  listEnvironments(signal: AbortSignal): Promise<WorkspaceEnvironment[]>;
  readStatus(environmentId: string, signal: AbortSignal): Promise<WorkspaceStatusReading>;
}

export interface WorkspaceStatusServiceOptions {
  /** How long a checkout reading and the environment list stay fresh. */
  ttlMs?: number;
  /** Simultaneous git status reads. */
  concurrency?: number;
  now?: () => number;
}

interface StatusEntry {
  status: WorkspaceStatus;
  expiresAt: number;
}

export const PROJECT_CHECKOUT_PROVIDER_ID = "project-checkout";

export function isInspectableEnvironment(environment: WorkspaceEnvironment): boolean {
  return (
    environment.status === "ready" &&
    environment.lifecycle.phase === "active" &&
    environment.isGitRepo &&
    environment.workspaceProvisionType !== "personal"
  );
}

/** Prefer BB's own project checkout; otherwise the newest non-worktree repo. */
export function pickCheckoutEnvironment(
  environments: readonly WorkspaceEnvironment[],
): WorkspaceEnvironment | null {
  let best: WorkspaceEnvironment | null = null;
  for (const environment of environments) {
    if (!isInspectableEnvironment(environment) || environment.isWorktree) continue;
    if (best === null) {
      best = environment;
      continue;
    }
    const bestIsCheckout = best.environmentProviderId === PROJECT_CHECKOUT_PROVIDER_ID;
    const isCheckout = environment.environmentProviderId === PROJECT_CHECKOUT_PROVIDER_ID;
    if (isCheckout !== bestIsCheckout) {
      if (isCheckout) best = environment;
      continue;
    }
    if (environment.updatedAt > best.updatedAt) best = environment;
  }
  return best;
}

/**
 * Reads checkout state for homepage cards with a short cache, request
 * coalescing, and a concurrency cap so a page of projects does not fan out
 * into an unbounded burst of git commands.
 */
export class WorkspaceStatusService {
  readonly #sources: WorkspaceStatusSources;
  readonly #ttlMs: number;
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #abortController = new AbortController();
  readonly #statuses = new Map<string, StatusEntry>();
  readonly #inFlight = new Map<string, Promise<WorkspaceStatus>>();
  #environments: { list: WorkspaceEnvironment[]; expiresAt: number } | null = null;
  #environmentsInFlight: Promise<WorkspaceEnvironment[]> | null = null;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(sources: WorkspaceStatusSources, options: WorkspaceStatusServiceOptions = {}) {
    this.#sources = sources;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#now = options.now ?? Date.now;
  }

  async getCheckoutStatuses(
    projectIds: readonly string[],
    refresh = false,
  ): Promise<Record<string, WorkspaceStatus>> {
    const environments = await this.#listEnvironments(refresh);
    const byProject = new Map<string, WorkspaceEnvironment[]>();
    for (const environment of environments) {
      const list = byProject.get(environment.projectId) ?? [];
      list.push(environment);
      byProject.set(environment.projectId, list);
    }

    const entries = await Promise.all(
      [...new Set(projectIds)].map(async (projectId): Promise<[string, WorkspaceStatus]> => {
        const candidates = byProject.get(projectId) ?? [];
        const checkout = pickCheckoutEnvironment(candidates);
        if (checkout === null) return [projectId, { kind: "none", fetchedAt: this.#now() }];
        const status = await this.#readStatus(checkout.id, refresh);
        if (status.kind !== "available") return [projectId, status];
        const worktrees = candidates.filter(
          (environment) => environment.isWorktree && isInspectableEnvironment(environment),
        ).length;
        return [projectId, { ...status, worktrees }];
      }),
    );
    return Object.fromEntries(entries);
  }

  async getWorktrees(projectId: string, refresh = false): Promise<WorkspaceWorktree[]> {
    const environments = (await this.#listEnvironments(refresh)).filter(
      (environment) =>
        environment.projectId === projectId &&
        environment.isWorktree &&
        isInspectableEnvironment(environment),
    );
    environments.sort((left, right) => right.updatedAt - left.updatedAt);
    return Promise.all(
      environments.map(async (environment) => ({
        environmentId: environment.id,
        name: environment.name,
        branch: environment.branchName,
        status: await this.#readStatus(environment.id, refresh),
      })),
    );
  }

  dispose(): void {
    this.#abortController.abort();
    this.#statuses.clear();
    this.#environments = null;
  }

  #listEnvironments(refresh: boolean): Promise<WorkspaceEnvironment[]> {
    if (!refresh && this.#environments && this.#environments.expiresAt > this.#now()) {
      return Promise.resolve(this.#environments.list);
    }
    if (this.#environmentsInFlight) return this.#environmentsInFlight;

    const load = this.#sources
      .listEnvironments(this.#abortController.signal)
      .then((list) => {
        if (!this.#abortController.signal.aborted) {
          this.#environments = { list, expiresAt: this.#now() + this.#ttlMs };
        }
        return list;
      })
      .finally(() => {
        this.#environmentsInFlight = null;
      });
    this.#environmentsInFlight = load;
    return load;
  }

  #readStatus(environmentId: string, refresh: boolean): Promise<WorkspaceStatus> {
    const cached = this.#statuses.get(environmentId);
    if (!refresh && cached && cached.expiresAt > this.#now()) {
      return Promise.resolve(cached.status);
    }
    const pending = this.#inFlight.get(environmentId);
    if (pending) return pending;

    const load = this.#withSlot(() => this.#fetchStatus(environmentId))
      .then((status) => {
        if (!this.#abortController.signal.aborted) {
          this.#statuses.set(environmentId, {
            status,
            expiresAt: this.#now() + this.#ttlMs,
          });
        }
        return status;
      })
      .finally(() => this.#inFlight.delete(environmentId));
    this.#inFlight.set(environmentId, load);
    return load;
  }

  async #fetchStatus(environmentId: string): Promise<WorkspaceStatus> {
    const fetchedAt = this.#now();
    try {
      const reading = await this.#sources.readStatus(
        environmentId,
        this.#abortController.signal,
      );
      if (reading.outcome === "unavailable") {
        return { kind: "unavailable", environmentId, message: reading.message, fetchedAt };
      }
      return {
        kind: "available",
        environmentId,
        branch: reading.branch,
        defaultBranch: reading.defaultBranch,
        changes: {
          files: reading.files,
          insertions: reading.insertions,
          deletions: reading.deletions,
          lineStatsComplete: reading.lineStatsComplete,
        },
        worktrees: 0,
        fetchedAt,
      };
    } catch (error) {
      return {
        kind: "unavailable",
        environmentId,
        message: error instanceof Error ? error.message : String(error),
        fetchedAt,
      };
    }
  }

  async #withSlot<Result>(task: () => Promise<Result>): Promise<Result> {
    if (this.#active >= this.#concurrency) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }
}
