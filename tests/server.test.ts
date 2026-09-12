import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

describe("project renaming", () => {
  it("trims the name and updates the project through the BB SDK", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          update: async ({ projectId, name }) => ({
            createdAt: 1,
            gitRemoteUrl: null,
            id: projectId,
            kind: "standard" as const,
            name: name ?? "Old name",
            sources: [],
            updatedAt: 2,
          }),
        },
      },
    });
    plugin(bb);

    await expect(
      harness.behavior.callRpc("renameProject", {
        projectId: "project-1",
        name: "  New name  ",
      }),
    ).resolves.toEqual({ projectId: "project-1", name: "New name" });
    expect(harness.inspection.sdk.callsTo("projects.update")).toEqual([
      [{ projectId: "project-1", name: "New name" }],
    ]);
  });

  it("rejects an empty project name", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await expect(
      harness.behavior.callRpc("renameProject", {
        projectId: "project-1",
        name: "   ",
      }),
    ).rejects.toThrow();
  });
});

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

  it("normalizes malformed stored project IDs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    await bb.storage.kv.set(
      "pinned-projects",
      ["a", "", 42, "a", null, "b"],
    );
    plugin(bb);

    await expect(harness.behavior.callRpc("listPinnedProjects")).resolves.toEqual({
      projectIds: ["a", "b"],
    });
  });
});

describe("project groups", () => {
  it("creates, renames, assigns, and deletes synced groups", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await expect(harness.behavior.callRpc("listProjectGroups")).resolves.toEqual({
      groups: [],
    });
    const first = await harness.behavior.callRpc("createProjectGroup", {
      name: "  Client work  ",
      projectId: "alpha",
    }) as { groups: Array<{ id: string; name: string; projectIds: string[] }> };
    expect(first.groups).toEqual([
      {
        id: expect.any(String),
        name: "Client work",
        projectIds: ["alpha"],
      },
    ]);

    const second = await harness.behavior.callRpc("createProjectGroup", {
      name: "Internal",
    }) as { groups: Array<{ id: string; name: string; projectIds: string[] }> };
    const clientGroupId = second.groups[0]!.id;
    const internalGroupId = second.groups[1]!.id;
    await expect(
      harness.behavior.callRpc("setProjectGroup", {
        projectId: "alpha",
        groupId: internalGroupId,
      }),
    ).resolves.toMatchObject({
      groups: [
        { id: clientGroupId, projectIds: [] },
        { id: internalGroupId, projectIds: ["alpha"] },
      ],
    });
    await expect(
      harness.behavior.callRpc("renameProjectGroup", {
        groupId: internalGroupId,
        name: "Product",
      }),
    ).resolves.toMatchObject({
      groups: [{ name: "Client work" }, { name: "Product" }],
    });
    await expect(
      harness.behavior.callRpc("deleteProjectGroup", { groupId: internalGroupId }),
    ).resolves.toMatchObject({
      groups: [{ id: clientGroupId, projectIds: [] }],
    });
  });

  it("rejects assignments to a missing group", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await expect(
      harness.behavior.callRpc("setProjectGroup", {
        projectId: "alpha",
        groupId: "missing",
      }),
    ).rejects.toThrow("Project group not found");
  });

  it("persists group order while preserving groups omitted by a stale client", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    const first = await harness.behavior.callRpc("createProjectGroup", {
      name: "First",
    }) as { groups: Array<{ id: string }> };
    const second = await harness.behavior.callRpc("createProjectGroup", {
      name: "Second",
    }) as { groups: Array<{ id: string }> };
    const firstId = first.groups[0]!.id;
    const secondId = second.groups[1]!.id;

    await expect(
      harness.behavior.callRpc("reorderProjectGroups", {
        groupIds: [secondId],
      }),
    ).resolves.toMatchObject({
      groups: [{ id: secondId }, { id: firstId }],
    });
    await expect(harness.behavior.callRpc("listProjectGroups")).resolves.toMatchObject({
      groups: [{ id: secondId }, { id: firstId }],
    });
  });

  it("serializes concurrent group creation without losing writes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        harness.behavior.callRpc("createProjectGroup", {
          name: `Group ${index}`,
        }),
      ),
    );
    const result = await harness.behavior.callRpc("listProjectGroups") as {
      groups: Array<{ name: string }>;
    };

    expect(result.groups).toHaveLength(20);
    expect(new Set(result.groups.map((group) => group.name))).toEqual(
      new Set(Array.from({ length: 20 }, (_, index) => `Group ${index}`)),
    );
  });
});

describe("hidden projects", () => {
  it("persists hidden projects and resets them", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    await expect(harness.behavior.callRpc("listHiddenProjects")).resolves.toEqual({
      projectIds: [],
    });
    await expect(
      harness.behavior.callRpc("setProjectHidden", {
        projectId: "a",
        hidden: true,
      }),
    ).resolves.toEqual({ projectIds: ["a"] });
    await harness.behavior.callRpc("setProjectHidden", {
      projectId: "b",
      hidden: true,
    });
    await harness.behavior.callRpc("setProjectHidden", {
      projectId: "a",
      hidden: true,
    });
    await expect(harness.behavior.callRpc("listHiddenProjects")).resolves.toEqual({
      projectIds: ["a", "b"],
    });

    await expect(harness.behavior.callRpc("resetHiddenProjects")).resolves.toEqual({
      projectIds: [],
    });
    await expect(harness.behavior.callRpc("listHiddenProjects")).resolves.toEqual({
      projectIds: [],
    });
  });
});

describe("project icon route", () => {
  it("declares configurable homepage behavior", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "homepage" });
    plugin(bb);

    expect(harness.inspection.registrations.settingsDescriptors.rankingMode).toBeUndefined();
    expect(
      harness.inspection.registrations.settingsDescriptors.currentProjectFirst,
    ).toBeUndefined();
    expect(harness.inspection.registrations.settingsDescriptors).toMatchObject({
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

  it("returns a named BB glyph through RPC without treating it as an image", async () => {
    let searches = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: {
          files: async () => {
            searches += 1;
            return { files: [], truncated: false };
          },
          fileContent: async ({ path }) => {
            if (path !== "package.json") throw new Error("not found");
            const content = JSON.stringify({
              bb: { branding: { icon: "GridView" } },
            });
            return {
              content,
              contentEncoding: "utf8" as const,
              mimeType: "application/json",
              sizeBytes: content.length,
            };
          },
        },
      },
    });
    plugin(bb);

    await expect(
      harness.behavior.callRpc("getProjectArtwork", { projectId: "project-1" }),
    ).resolves.toEqual({ kind: "glyph", svg: expect.stringContaining("<svg") });
    expect(searches).toBe(0);

    const response = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=project-1",
    );
    expect(response.status).toBe(404);
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


describe("project app opening context", () => {
  it.each([true, false])("resolves the default checkout, present: %s", async (hasSources) => {
    const sources = hasSources ? [
      { hostId: "other", path: "/other", isDefault: false },
      { hostId: "default", path: "/default", isDefault: true },
    ] : [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "homepage",
      sdk: {
        projects: { get: vi.fn().mockResolvedValue({ sources }) },
        system: { config: vi.fn().mockResolvedValue({ localHelperPorts: [1234] }) },
      },
    });
    plugin(bb);
    await expect(harness.behavior.callRpc("getProjectOpenContext", { projectId: "project-1" }))
      .resolves.toEqual({
        source: hasSources ? { hostId: "default", path: "/default" } : null,
        ports: [1234],
      });
    expect(harness.inspection.sdk.callsTo("projects.get")).toEqual([[{ projectId: "project-1" }]]);
  });
});
