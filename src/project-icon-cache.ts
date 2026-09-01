export interface ProjectIconCacheOptions {
  maxEntries?: number;
  foundTtlMs?: number;
  missingTtlMs?: number;
  now?: () => number;
}

interface CacheEntry<Value> {
  icon: Value | null;
  expiresAt: number;
}

export class ProjectIconCache<Value> {
  readonly #entries = new Map<string, CacheEntry<Value>>();
  readonly #inFlight = new Map<string, Promise<Value | null>>();
  readonly #abortController = new AbortController();
  readonly #loader: (projectId: string, signal: AbortSignal) => Promise<Value | null>;
  readonly #maxEntries: number;
  readonly #foundTtlMs: number;
  readonly #missingTtlMs: number;
  readonly #now: () => number;

  constructor(
    loader: (projectId: string, signal: AbortSignal) => Promise<Value | null>,
    options: ProjectIconCacheOptions = {},
  ) {
    this.#loader = loader;
    this.#maxEntries = options.maxEntries ?? 128;
    this.#foundTtlMs = options.foundTtlMs ?? 5 * 60_000;
    this.#missingTtlMs = options.missingTtlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  get(projectId: string): Promise<Value | null> {
    const cached = this.#entries.get(projectId);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      this.#entries.delete(projectId);
      this.#entries.set(projectId, cached);
      return Promise.resolve(cached.icon);
    }
    if (cached !== undefined) this.#entries.delete(projectId);

    const pending = this.#inFlight.get(projectId);
    if (pending !== undefined) return pending;

    const load = this.#loader(projectId, this.#abortController.signal)
      .then((icon) => {
        if (!this.#abortController.signal.aborted) this.#store(projectId, icon);
        return icon;
      })
      .finally(() => this.#inFlight.delete(projectId));
    this.#inFlight.set(projectId, load);
    return load;
  }

  dispose(): void {
    this.#abortController.abort();
    this.#entries.clear();
  }

  #store(projectId: string, icon: Value | null): void {
    this.#entries.delete(projectId);
    this.#entries.set(projectId, {
      icon,
      expiresAt: this.#now() + (icon === null ? this.#missingTtlMs : this.#foundTtlMs),
    });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
