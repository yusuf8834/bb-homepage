import { describe, expect, it } from "vitest";
import { ProjectIconCache } from "./project-icon-cache.js";

const icon = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

describe("project icon cache", () => {
  it("coalesces concurrent loads and caches successful results", async () => {
    let resolveLoad: ((value: typeof icon) => void) | undefined;
    let loads = 0;
    const cache = new ProjectIconCache(() => {
      loads += 1;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    });

    const first = cache.get("project-1");
    const second = cache.get("project-1");
    expect(first).toBe(second);
    expect(loads).toBe(1);

    resolveLoad?.(icon);
    await expect(first).resolves.toBe(icon);
    await expect(cache.get("project-1")).resolves.toBe(icon);
    expect(loads).toBe(1);
  });

  it("uses separate expiries for found and missing icons", async () => {
    let now = 0;
    const loads = new Map<string, number>();
    const cache = new ProjectIconCache(
      async (projectId) => {
        loads.set(projectId, (loads.get(projectId) ?? 0) + 1);
        return projectId === "found" ? icon : null;
      },
      { foundTtlMs: 100, missingTtlMs: 20, now: () => now },
    );

    await cache.get("found");
    await cache.get("missing");
    now = 21;
    await cache.get("found");
    await cache.get("missing");

    expect(loads.get("found")).toBe(1);
    expect(loads.get("missing")).toBe(2);
  });

  it("evicts the least recently used project and aborts work on dispose", async () => {
    let lastSignal: AbortSignal | undefined;
    let loads = 0;
    const cache = new ProjectIconCache(
      async (_projectId, signal) => {
        lastSignal = signal;
        loads += 1;
        return icon;
      },
      { maxEntries: 2 },
    );

    await cache.get("one");
    await cache.get("two");
    await cache.get("one");
    await cache.get("three");
    await cache.get("two");
    expect(loads).toBe(4);

    cache.dispose();
    expect(lastSignal?.aborted).toBe(true);
  });
});
