import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

describe("pinned projects", () => {
  it("persists pin order and drops unpinned projects", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await expect(harness.behavior.callRpc("listPinnedProjects")).resolves.toEqual({
      projectIds: [],
    });
    await expect(
      harness.behavior.callRpc("setProjectPinned", { projectId: "a", pinned: true }),
    ).resolves.toEqual({ projectIds: ["a"] });
    await harness.behavior.callRpc("setProjectPinned", { projectId: "b", pinned: true });
    await harness.behavior.callRpc("setProjectPinned", { projectId: "a", pinned: true });
    await expect(harness.behavior.callRpc("listPinnedProjects")).resolves.toEqual({
      projectIds: ["a", "b"],
    });
    await expect(
      harness.behavior.callRpc("setProjectPinned", { projectId: "a", pinned: false }),
    ).resolves.toEqual({ projectIds: ["b"] });
    await expect(harness.behavior.callRpc("listPinnedProjects")).resolves.toEqual({
      projectIds: ["b"],
    });
  });
});

describe("project icon route", () => {
  it("declares configurable homepage behavior", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    expect(harness.inspection.registrations.settingsDescriptors.rankingMode).toBeUndefined();
    expect(harness.inspection.registrations.settingsDescriptors).toMatchObject({
      currentProjectFirst: { type: "boolean", default: true },
      showChatCounts: { type: "boolean", default: true },
      showUnusedProjects: { type: "boolean", default: true },
      includePersonalProject: { type: "boolean", default: true },
      loadProjectIcons: { type: "boolean", default: true },
    });
  });

  it("serves a declared project icon with private caching and browser hardening", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          files: async () => ({ files: [], truncated: false }),
          fileContent: async ({ path }) => {
            if (path === "package.json") {
              const content = JSON.stringify({ bb: { branding: { icon: "./icons/project.svg" } } });
              return {
                content,
                contentEncoding: "utf8" as const,
                mimeType: "application/json",
                sizeBytes: content.length,
              };
            }
            if (path === "icons/project.svg") {
              const content = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
              return {
                content,
                contentEncoding: "utf8" as const,
                mimeType: "image/svg+xml",
                sizeBytes: content.length,
              };
            }
            throw new Error("not found");
          },
        },
      },
    });
    plugin(bb);

    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("<svg");
  });

  it("tries the next ranked candidate when the first file is unreadable", async () => {
    const reads: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          files: async ({ query }) => ({
            files: query === "icon"
              ? [
                  { name: "favicon.svg", path: "public/favicon.svg" },
                  { name: "icon.png", path: "src/icon.png" },
                ]
              : [],
            truncated: false,
          }),
          fileContent: async ({ path }) => {
            reads.push(path);
            if (path === "public/favicon.svg" || path === "package.json") {
              throw new Error("not found");
            }
            return {
              content: Buffer.from("png-bytes").toString("base64"),
              contentEncoding: "base64" as const,
              mimeType: "image/png",
              sizeBytes: 9,
            };
          },
        },
      },
    });
    plugin(bb);

    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(reads).toContain("public/favicon.svg");
    expect(reads.at(-1)).toBe("src/icon.png");
  });

  it("returns bounded errors for missing input and missing icons", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          files: async () => ({ files: [], truncated: false }),
          fileContent: async () => {
            throw new Error("not found");
          },
        },
      },
    });
    plugin(bb);

    const invalid = await harness.behavior.fetchHttp("GET", "/project-icon");
    expect(invalid.status).toBe(400);

    const missing = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, max-age=60");
  });

  it("coalesces and caches repeated icon requests", async () => {
    let manifestReads = 0;
    let releaseManifest: (() => void) | undefined;
    const manifestGate = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          files: async () => ({ files: [], truncated: false }),
          fileContent: async ({ path }) => {
            if (path === "package.json") {
              manifestReads += 1;
              await manifestGate;
              const content = JSON.stringify({ bb: { branding: { icon: "icon.png" } } });
              return {
                content,
                contentEncoding: "utf8" as const,
                mimeType: "application/json",
                sizeBytes: content.length,
              };
            }
            return {
              content: Buffer.from("png").toString("base64"),
              contentEncoding: "base64" as const,
              mimeType: "image/png",
              sizeBytes: 3,
            };
          },
        },
      },
    });
    plugin(bb);

    const first = harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1");
    const second = harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1");
    await Promise.resolve();
    expect(manifestReads).toBe(1);
    releaseManifest?.();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await harness.behavior.fetchHttp("GET", "/project-icon?projectId=project-1")).status)
      .toBe(200);
    expect(manifestReads).toBe(1);
  });
});
