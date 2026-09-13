// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../server.js";
import { buildNewChatActivityByProject } from "../src/activity.js";
import { formatRelativeTime } from "../src/relative-time.js";

function thread(id: string, projectId: string, updatedAt: number) {
  return {
    id,
    projectId,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none" as const,
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: updatedAt,
    updatedAt,
    lastReadAt: updatedAt,
    latestAttentionAt: updatedAt,
  };
}

beforeEach(() => {
  // Each test represents a fresh app window; remounts within a test share caches.
  vi.resetModules();
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  Reflect.deleteProperty(document, "elementFromPoint");
});

function pointAt(element: Element): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element,
  });
}

function firePointer(
  element: Element,
  type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
  init: MouseEventInit & { pointerId: number },
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: init.pointerId },
  });
  fireEvent(element, event);
}


/**
 * floating-ui asks `matches(":modal")` while positioning a popover. jsdom's
 * selector engine answers that by rescanning the document for `:fullscreen`,
 * which takes seconds per open. jsdom has no top layer, so answer no directly.
 */
function stubTopLayerSelectors(): () => void {
  const originalMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selector: string) {
    if (selector === ":modal" || selector === ":popover-open" || selector === ":fullscreen") {
      return false;
    }
    return originalMatches.call(this, selector);
  };
  return () => {
    Element.prototype.matches = originalMatches;
  };
}

async function waitForPreferences(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.textContent).not.toBe("Loading projects...");
  });
}

describe("project chat launcher", () => {
  it.each([false, true])("retains artwork, groups, and checkout counts while a return visit refreshes, failure=%s", async (failRefresh) => {
    const app = await loadPluginApp(() => import("../app"));
    const sidebarThreads = {
      projects: [
        { id: "alpha", name: "Alpha", isPersonal: false },
        { id: "beta", name: "Beta", isPersonal: false },
        { id: "hidden", name: "Hidden", isPersonal: false },
      ],
      threads: [],
    };
    const workspace = {
      kind: "available" as const, environmentId: "env-alpha",
      branch: "main", defaultBranch: "main", worktrees: 0, fetchedAt: 1,
      changes: { files: 2, insertions: 10, deletions: 3, lineStatsComplete: true },
    };
    const rpc: PluginRpcTestHandlers<Pick<typeof rpcContract,
      "listPinnedProjects" | "listProjectGroups" | "listHiddenProjects" |
      "getProjectArtwork" | "getProjectWorkspaceStatuses"
    >> = {
      listPinnedProjects: () => ({ projectIds: [] }),
      listProjectGroups: () => ({ groups: [{ id: "work", name: "Work", projectIds: ["alpha", "beta"] }] }),
      listHiddenProjects: () => ({ projectIds: ["hidden"] }),
      getProjectArtwork: ({ projectId }) => projectId === "alpha"
        ? { kind: "glyph", svg: '<svg xmlns="http://www.w3.org/2000/svg" />' }
        : { kind: "image" },
      getProjectWorkspaceStatuses: () => ({ statuses: { alpha: workspace } }),
    };
    const first = renderSlot(app.homepageSections[0]!, { projectId: null }, { rpc, sidebarThreads });
    await waitFor(() => {
      expect(first.container.querySelector("[data-homepage-project-glyph]")).not.toBeNull();
      expect(first.container.querySelector("[data-homepage-project-icon] img")).not.toBeNull();
      expect(first.container.querySelector("[data-workspace-changes]")?.textContent).toBe("2 files+10 -3");
    });
    first.lifecycle.unmount();

    let finishRefresh!: () => void;
    const pending = new Promise<void>((resolve) => { finishRefresh = resolve; });
    async function refresh<Value>(value: Value): Promise<Value> {
      await pending;
      if (failRefresh) throw new Error("offline");
      return value;
    }
    const second = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads,
      rpc: {
        listPinnedProjects: () => refresh({ projectIds: [] }),
        listProjectGroups: () => refresh({ groups: [{ id: "work", name: "Renamed", projectIds: ["alpha", "beta"] }] }),
        listHiddenProjects: () => refresh({ projectIds: ["hidden"] }),
        getProjectArtwork: () => refresh({ kind: "missing" as const }),
        getProjectWorkspaceStatuses: () => refresh({ statuses: {
          alpha: { ...workspace, changes: { ...workspace.changes, files: 0, insertions: 0, deletions: 0 } },
        } }),
      },
    });
    // Assert the first render, before any of the new visit's requests resolves.
    expect(second.container.textContent).not.toContain("Loading projects...");
    expect(second.getByRole("button", { name: "Collapse Work group" })).not.toBeNull();
    expect(second.queryByRole("button", { name: "Start a new chat in Hidden" })).toBeNull();
    expect(second.container.querySelector("[data-homepage-project-glyph]")).not.toBeNull();
    expect(second.container.querySelector("[data-homepage-project-icon] img")).not.toBeNull();
    expect(second.container.querySelector("[data-workspace-changes]")?.textContent).toBe("2 files+10 -3");

    finishRefresh();
    if (failRefresh) {
      await second.findByRole("alert");
      expect(second.container.querySelector("[data-homepage-project-glyph]")).not.toBeNull();
      expect(second.container.querySelector("[data-homepage-project-icon] img")).not.toBeNull();
      expect(second.container.querySelector("[data-workspace-changes]")?.textContent).toBe("2 files+10 -3");
    } else {
      await second.findByRole("button", { name: "Collapse Renamed group" });
      await waitFor(() => {
        expect(second.container.querySelector("[data-homepage-project-glyph]")).toBeNull();
        expect(second.container.querySelector("[data-homepage-project-icon] img")).toBeNull();
        expect(second.container.querySelector("[data-workspace-changes]")?.textContent).toBe("NoChange");
      });
    }
    second.lifecycle.unmount();

    const disabled = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads, rpc, settings: { loadProjectIcons: false, showWorkspaceStatus: false },
    });
    expect(disabled.container.querySelector("[data-homepage-project-glyph]")).toBeNull();
    expect(disabled.container.querySelector("[data-homepage-project-icon] img")).toBeNull();
    expect(disabled.container.querySelector("[data-workspace-changes]")).toBeNull();
    disabled.lifecycle.unmount();
  });

  it("fills the compact homepage viewport and cleans up on disposal", async () => {
    const recents = document.createElement("section");
    recents.dataset.rootComposeMobileRecents = "";
    document.body.append(recents);

    const viewport = document.createElement("div");
    viewport.dataset.testid = "root-compose-compact-scroll-viewport";
    const offset = document.createElement("div");
    offset.dataset.testid = "root-compose-compact-recents-offset";
    document.body.append(viewport, offset);

    const app = await loadPluginApp(() => import("../app"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "homepage" });
    const style = document.head.querySelector("style[data-bb-homepage-hide-recents]");

    expect(scripts.inspection.mountedIds).toEqual(["hide-homepage-recent-chats"]);
    expect(style?.textContent).toContain("[data-root-compose-mobile-recents]");
    expect(style?.textContent).toContain(
      '[data-testid="root-compose-compact-scroll-viewport"]',
    );
    expect(style?.textContent).toContain(
      '[data-testid="root-compose-compact-recents-offset"]',
    );
    expect(window.getComputedStyle(recents).display).toBe("none");
    // jsdom drops declarations using env(), so only the rule text is checked here.
    expect(style?.textContent).toContain(
      "top: calc(56px + env(safe-area-inset-top, 0px)) !important",
    );
    expect(window.getComputedStyle(offset).height).toBe("0px");

    await scripts.lifecycle.dispose();
    expect(style?.isConnected).toBe(false);
  });

  it("formats last-activity timestamps compactly", () => {
    const now = new Date(2026, 7, 30, 12).getTime();
    expect(formatRelativeTime(now - 20_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 6 * 86_400_000, now)).toBe("6d ago");
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toBe(
      new Date(now - 90 * 86_400_000).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      }),
    );
  });

  it("builds a 14-day series from new root chats", () => {
    const now = new Date(2026, 7, 30, 12).getTime();
    const oneDayAgo = new Date(2026, 7, 29, 9).getTime();
    const thirteenDaysAgo = new Date(2026, 7, 17, 18).getTime();
    const outsideRange = new Date(2026, 7, 16, 23).getTime();

    expect(buildNewChatActivityByProject([
      thread("today", "project-1", now),
      thread("yesterday", "project-1", oneDayAgo),
      { ...thread("archived", "project-1", oneDayAgo), isArchived: true },
      { ...thread("child", "project-1", now), parentThreadId: "today" },
      thread("old", "project-1", outsideRange),
      thread("other-project", "project-2", now),
      thread("first-day", "project-1", thirteenDaysAgo),
    ], now).get("project-1")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
    ]);
  });

  it("runs the sparkline entrance only on the first launcher mount", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const sidebarThreads = {
      projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
      threads: [thread("alpha-thread", "alpha", Date.now())],
    };

    const first = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads,
    });
    await waitForPreferences(first.container);
    expect(first.container.querySelector("[data-sparkline-entrance]"))
      .not.toBeNull();
    first.lifecycle.unmount();

    const remounted = renderSlot(app.homepageSections[0]!, { projectId: "alpha" }, {
      sidebarThreads,
    });
    await waitForPreferences(remounted.container);
    expect(remounted.container.querySelector("[data-sparkline-entrance]"))
      .toBeNull();
    remounted.lifecycle.unmount();
  });

  it("keeps projects usable when one preference request fails", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => Promise.reject(new Error("storage unavailable")),
        listHiddenProjects: () => ({ projectIds: [] }),
      },
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });

    expect((await slot.findByRole("alert")).textContent).toBe(
      "Some homepage preferences could not be loaded.",
    );
    expect(slot.getByRole("button", {
      name: "Start a new chat in Alpha",
    })).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("reorders projects from the keyboard in Manual mode", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Manual");
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups: [] }),
        listHiddenProjects: () => ({ projectIds: [] }),
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
        ],
        threads: [],
      },
    });

    const beta = await slot.findByRole("button", {
      name: "Start a new chat in Beta",
    });
    fireEvent.keyDown(beta, { altKey: true, key: "ArrowUp" });

    expect(
      slot.getAllByRole("button", { name: /Start a new chat/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Start a new chat in Beta",
      "Start a new chat in Alpha",
    ]);
    expect(beta.getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowUp Alt+ArrowDown",
    );
    slot.lifecycle.unmount();
  });

  it("keeps recent-activity order while highlighting and opening the selected project", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: "project-2" }, {
      rpc: {
        getProjectArtwork: () => ({ kind: "image" }),
      },
      sidebarThreads: {
        projects: [
          { id: "project-1", name: "Once", isPersonal: false },
          { id: "project-2", name: "Often", isPersonal: false },
          { id: "project-3", name: "Unused", isPersonal: false },
        ],
        threads: [
          thread("thread-1", "project-1", 30),
          thread("thread-2", "project-2", 10),
          thread("thread-3", "project-2", 20),
          { ...thread("child", "project-1", 50), parentThreadId: "thread-1" },
          { ...thread("archived", "project-1", 60), isArchived: true },
        ],
      },
    });

    const epochMonth = new Date(30).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
    await waitForPreferences(slot.container);
    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.textContent)).toEqual([
      `Once1 chat · ${epochMonth}`,
      `Often2 chats · ${epochMonth}`,
      "UnusedNo chats yet",
    ]);
    expect(slot.getByRole("button", { name: "Start a new chat in Often" }).getAttribute("aria-current"))
      .toBe("page");
    await waitFor(() => {
      expect(slot.container.querySelectorAll('[data-homepage-project-icon] img')).toHaveLength(3);
    });
    expect(
      slot.container.querySelector("[data-homepage-project-icon]")?.className,
    ).not.toContain("bg-muted");
    expect(slot.container.querySelector('[data-homepage-project-icon] img')?.className)
      .toContain("size-8");
    expect(slot.queryAllByRole("img", { name: /new chats? in the last 14 days/ }))
      .toHaveLength(0);
    expect(slot.container.querySelector("[data-homepage-sort]")?.className)
      .toContain("absolute -top-9 right-0");

    const onceButton = slot.getByRole("button", {
      name: "Start a new chat in Once",
    });
    fireEvent.click(onceButton);
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { projectId: "project-1", focusPrompt: true },
    });
    expect(onceButton.getAttribute("aria-current")).toBe("page");
    expect(onceButton.className).toContain("bg-state-hover");

    slot.lifecycle.unmount();
  });

  it("renders pinned projects without hover pin controls", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const pinHandlers: PluginRpcTestHandlers<typeof rpcContract> = {
      getProjectOpenContext: () => ({ source: null, ports: [] }),
      listPinnedProjects: () => ({ projectIds: ["beta"] }),
      setProjectPinned: ({ projectId, pinned }) => ({
        projectIds: pinned ? ["beta", projectId] : [],
      }),
      listProjectGroups: () => ({ groups: [] }),
      createProjectGroup: () => ({ groups: [] }),
      renameProjectGroup: () => ({ groups: [] }),
      deleteProjectGroup: () => ({ groups: [] }),
      reorderProjectGroups: () => ({ groups: [] }),
      setProjectGroup: () => ({ groups: [] }),
      listHiddenProjects: () => ({ projectIds: [] }),
      setProjectHidden: ({ projectId, hidden }) => ({
        projectIds: hidden ? [projectId] : [],
      }),
      resetHiddenProjects: () => ({ projectIds: [] }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
      getProjectArtwork: () => ({ kind: "missing" }),
      getProjectWorkspaceStatuses: () => ({ statuses: {} }),
      listProjectWorktrees: () => ({ worktrees: [] }),
    };
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: pinHandlers,
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
        ],
        threads: [],
      },
    });

    await slot.findByText("Pinned");
    expect(
      slot
        .getAllByRole("button", { name: /Start a new chat/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Start a new chat in Beta", "Start a new chat in Alpha"]);
    expect(slot.queryByRole("button", { name: /pin beta/i })).toBeNull();
    expect(slot.queryByRole("button", { name: /pin alpha/i })).toBeNull();

    slot.lifecycle.unmount();
  });

  it("pins a project dropped into the pinned section", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Manual");
    const app = await loadPluginApp(() => import("../app"));
    const rpcHandlers: PluginRpcTestHandlers<typeof rpcContract> = {
      getProjectOpenContext: () => ({ source: null, ports: [] }),
      listPinnedProjects: () => ({ projectIds: [] }),
      setProjectPinned: ({ projectId, pinned }) => ({
        projectIds: pinned ? [projectId] : [],
      }),
      listProjectGroups: () => ({ groups: [] }),
      createProjectGroup: () => ({ groups: [] }),
      renameProjectGroup: () => ({ groups: [] }),
      deleteProjectGroup: () => ({ groups: [] }),
      reorderProjectGroups: () => ({ groups: [] }),
      setProjectGroup: () => ({ groups: [] }),
      listHiddenProjects: () => ({ projectIds: [] }),
      setProjectHidden: ({ projectId, hidden }) => ({
        projectIds: hidden ? [projectId] : [],
      }),
      resetHiddenProjects: () => ({ projectIds: [] }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
      getProjectArtwork: () => ({ kind: "missing" }),
      getProjectWorkspaceStatuses: () => ({ statuses: {} }),
      listProjectWorktrees: () => ({ worktrees: [] }),
    };
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: rpcHandlers,
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });
    await waitFor(() => expect(slot.queryByText("Pinned")).toBeNull());

    const alpha = slot
      .getByRole("button", { name: "Start a new chat in Alpha" })
      .closest<HTMLElement>("[data-project-id]");
    pointAt(alpha!);
    firePointer(alpha!, "pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 100,
      pointerId: 1,
    });
    firePointer(alpha!, "pointermove", {
      clientX: 10,
      clientY: 80,
      pointerId: 1,
    });

    expect(slot.getByText("Pinned")).not.toBeNull();
    expect(slot.getByText("Drop here to pin")).not.toBeNull();
    const pinnedSection = slot.container.querySelector<HTMLElement>(
      '[data-project-section="pinned"]',
    );
    pointAt(pinnedSection!);
    firePointer(alpha!, "pointermove", {
      clientX: 10,
      clientY: 40,
      pointerId: 1,
    });
    expect(pinnedSection?.className).not.toContain("ring-");
    expect(
      pinnedSection?.querySelector('[data-section-drop-accent="pinned"]'),
    ).not.toBeNull();
    firePointer(alpha!, "pointerup", {
      clientX: 10,
      clientY: 40,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "setProjectPinned",
        input: { projectId: "alpha", pinned: true },
      });
      expect(slot.queryByText("Drop here to pin")).toBeNull();
    });
    expect(slot.queryByRole("button", { name: /pin alpha/i })).toBeNull();

    slot.lifecycle.unmount();
  });

  it("creates a custom group with hover-revealed management actions", async () => {
    let groups: Array<{ id: string; name: string; projectIds: string[] }> = [];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listProjectGroups: () => ({ groups }),
        createProjectGroup: (input: unknown) => {
          const { name, projectId } = input as { name: string; projectId?: string };
          groups = [{ id: "clients", name, projectIds: projectId ? [projectId] : [] }];
          return { groups };
        },
      },
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });

    await waitForPreferences(slot.container);
    fireEvent.click(slot.getByRole("button", { name: "New group" }));
    const createForm = slot.getByRole("form", { name: "Create project group" });
    fireEvent.change(slot.getByLabelText("Group name"), {
      target: { value: "Client work" },
    });
    fireEvent.submit(createForm);

    await slot.findByText("Client work");
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "createProjectGroup",
      input: { name: "Client work" },
    });

    const clientActions = slot.getByRole("button", {
      name: "Manage Client work group",
    });
    expect(clientActions.className).toContain("group-hover/section:opacity-100");
    expect(clientActions.closest('[data-project-section="group:clients"]'))
      .not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("collapses project groups and remembers the choice", async () => {
    const groups = [{ id: "work", name: "Work", projectIds: ["alpha"] }];
    const app = await loadPluginApp(() => import("../app"));
    const renderLauncher = () => renderSlot(
      app.homepageSections[0]!,
      { projectId: null },
      {
        rpc: {
          listPinnedProjects: () => ({ projectIds: [] }),
          listProjectGroups: () => ({ groups }),
        },
        sidebarThreads: {
          projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
          threads: [],
        },
      },
    );
    const slot = renderLauncher();

    const collapse = await slot.findByRole("button", {
      name: "Collapse Work group",
    });
    expect(slot.getByRole("button", {
      name: "Start a new chat in Alpha",
    })).not.toBeNull();
    fireEvent.click(collapse);

    expect(slot.queryByRole("button", {
      name: "Start a new chat in Alpha",
    })).toBeNull();
    expect(slot.getByRole("button", {
      name: "Expand Work group",
    }).getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(
      window.localStorage.getItem("bb-plugin-homepage:collapsed-project-groups") ?? "[]",
    )).toEqual(["work"]);
    slot.lifecycle.unmount();

    const restored = renderLauncher();
    const expand = await restored.findByRole("button", {
      name: "Expand Work group",
    });
    expect(restored.queryByRole("button", {
      name: "Start a new chat in Alpha",
    })).toBeNull();
    fireEvent.click(expand);
    expect(await restored.findByRole("button", {
      name: "Start a new chat in Alpha",
    })).not.toBeNull();
    restored.lifecycle.unmount();
  });

  it("moves a project into a custom group by dragging in Manual mode", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Manual");
    let groups = [{ id: "work", name: "Work", projectIds: ["alpha"] }];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups }),
        setProjectGroup: (input: unknown) => {
          const { projectId, groupId } = input as {
            projectId: string;
            groupId: string | null;
          };
          groups = groups.map((group) => ({
            ...group,
            projectIds: group.id === groupId
              ? [...group.projectIds.filter((id) => id !== projectId), projectId]
              : group.projectIds.filter((id) => id !== projectId),
          }));
          return { groups };
        },
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
        ],
        threads: [],
      },
    });
    await slot.findByText("Work");

    const beta = slot
      .getByRole("button", { name: "Start a new chat in Beta" })
      .closest<HTMLElement>("[data-project-id]");
    const groupSection = slot.container.querySelector<HTMLElement>(
      '[data-project-section="group:work"]',
    );
    pointAt(beta!);
    firePointer(beta!, "pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 100,
      pointerId: 2,
    });
    firePointer(beta!, "pointermove", {
      clientX: 10,
      clientY: 80,
      pointerId: 2,
    });
    pointAt(groupSection!);
    firePointer(beta!, "pointermove", {
      clientX: 10,
      clientY: 40,
      pointerId: 2,
    });
    expect(
      groupSection?.querySelector('[data-section-drop-accent="group:work"]'),
    ).not.toBeNull();
    firePointer(beta!, "pointerup", {
      clientX: 10,
      clientY: 40,
      pointerId: 2,
    });

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "setProjectGroup",
        input: { projectId: "beta", groupId: "work" },
      });
    });
    expect(groupSection?.querySelector('[data-project-id="beta"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("reorders custom groups by dragging their headers", async () => {
    let groups = [
      { id: "first", name: "First", projectIds: ["alpha"] },
      { id: "second", name: "Second", projectIds: ["beta"] },
    ];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listProjectGroups: () => ({ groups }),
        reorderProjectGroups: (input: unknown) => {
          const { groupIds } = input as { groupIds: string[] };
          const groupsById = new Map(groups.map((group) => [group.id, group]));
          groups = groupIds.map((groupId) => groupsById.get(groupId)!);
          return { groups };
        },
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
        ],
        threads: [],
      },
    });
    await slot.findByRole("button", { name: "Manage Second group" });

    const firstGroup = slot.container.querySelector<HTMLElement>(
      '[data-project-group-id="first"]',
    );
    const secondGroup = slot.container.querySelector<HTMLElement>(
      '[data-project-group-id="second"]',
    );
    const firstHeader = firstGroup?.querySelector<HTMLElement>(
      "[data-project-group-header]",
    );
    const secondHeader = secondGroup?.querySelector<HTMLElement>(
      "[data-project-group-header]",
    );
    Object.defineProperty(firstHeader, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100, height: 24 }),
    });
    pointAt(firstGroup!);
    firePointer(secondHeader!, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 200,
      pointerId: 3,
    });
    firePointer(secondHeader!, "pointermove", {
      clientX: 20,
      clientY: 90,
      pointerId: 3,
    });
    expect(
      firstGroup?.querySelector('[data-group-drop-accent="before"]'),
    ).not.toBeNull();
    firePointer(secondHeader!, "pointerup", {
      clientX: 20,
      clientY: 90,
      pointerId: 3,
    });

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "reorderProjectGroups",
        input: { groupIds: ["second", "first"] },
      });
    });
    expect(
      Array.from(slot.container.querySelectorAll("[data-project-group-id]"))
        .map((element) => element.getAttribute("data-project-group-id")),
    ).toEqual(["second", "first"]);
    slot.lifecycle.unmount();
  });

  it("wires a context menu trigger onto each project card", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        setProjectPinned: () => ({ projectIds: ["solo"] }),
      },
      sidebarThreads: {
        projects: [{ id: "solo", name: "Solo", isPersonal: false }],
        threads: [],
      },
    });

    await waitForPreferences(slot.container);
    // Radix marks closed context-menu triggers with data-state; opening the
    // menu itself deadlocks under jsdom, so the open path is verified live.
    const trigger = slot.container.querySelector('[data-state="closed"]');
    expect(trigger).not.toBeNull();
    expect(
      trigger?.querySelector('[aria-label="Start a new chat in Solo"]'),
    ).not.toBeNull();

    slot.lifecycle.unmount();
  });

  it("removes projects returned by hidden-project storage", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listHiddenProjects: () => ({ projectIds: ["alpha"] }),
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
        ],
        threads: [],
      },
    });

    await waitFor(() => {
      expect(
        slot.queryByRole("button", { name: "Start a new chat in Alpha" }),
      ).toBeNull();
    });
    expect(
      slot.getByRole("button", { name: "Start a new chat in Beta" }),
    ).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("resets hidden projects from the plugin settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.settingsSections[0]!, {}, {
      rpc: {
        listHiddenProjects: () => ({ projectIds: ["alpha", "beta"] }),
        resetHiddenProjects: () => ({ projectIds: [] }),
      },
    });

    await slot.findByText("2 hidden projects.");
    fireEvent.click(slot.getByRole("button", { name: "Reset hidden projects" }));

    await slot.findByText("No projects are hidden.");
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "resetHiddenProjects",
      input: null,
    });
    slot.lifecycle.unmount();
  });

  it("renames a project inline by right-clicking its icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpcHandlers: PluginRpcTestHandlers<typeof rpcContract> = {
      getProjectOpenContext: () => ({ source: null, ports: [] }),
      listPinnedProjects: () => ({ projectIds: [] }),
      setProjectPinned: () => ({ projectIds: [] }),
      listProjectGroups: () => ({ groups: [] }),
      createProjectGroup: () => ({ groups: [] }),
      renameProjectGroup: () => ({ groups: [] }),
      deleteProjectGroup: () => ({ groups: [] }),
      reorderProjectGroups: () => ({ groups: [] }),
      setProjectGroup: () => ({ groups: [] }),
      listHiddenProjects: () => ({ projectIds: [] }),
      setProjectHidden: ({ projectId, hidden }) => ({
        projectIds: hidden ? [projectId] : [],
      }),
      resetHiddenProjects: () => ({ projectIds: [] }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
      getProjectArtwork: () => ({ kind: "missing" }),
      getProjectWorkspaceStatuses: () => ({ statuses: {} }),
      listProjectWorktrees: () => ({ worktrees: [] }),
    };
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: rpcHandlers,
      sidebarThreads: {
        projects: [{ id: "solo", name: "Solo", isPersonal: false }],
        threads: [],
      },
    });

    await waitForPreferences(slot.container);
    const icon = slot.container.querySelector("[data-homepage-project-icon]");
    expect(icon).not.toBeNull();
    fireEvent.contextMenu(icon!);

    const input = await slot.findByRole("textbox", { name: "Rename Solo" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "renameProject",
        input: { projectId: "solo", name: "Renamed" },
      });
    });
    await slot.findByRole("button", { name: "Start a new chat in Renamed" });

    slot.lifecycle.unmount();
  });

  it("shows line sparklines only for projects with recent chats", async () => {
    const now = Date.now();
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "busy", name: "Busy", isPersonal: false },
          { id: "idle", name: "Idle", isPersonal: false },
        ],
        threads: [
          thread("busy-a", "busy", now),
          thread("busy-b", "busy", now),
          thread("idle-old", "idle", 30),
        ],
      },
    });

    const sparkline = await slot.findByRole("img", {
      name: "Busy: 2 new chats in the last 14 days",
    });
    expect(sparkline.querySelectorAll("path")).toHaveLength(2);
    expect(sparkline.querySelectorAll("circle")).toHaveLength(1);
    expect(slot.queryByRole("img", { name: /^Idle:/ })).toBeNull();
    // Cards carry no decorative plus icon; the card itself is the action.
    expect(
      slot.container.querySelectorAll(
        'button[aria-label^="Start a new chat"] svg[viewBox="0 0 16 16"]',
      ),
    ).toHaveLength(0);

    slot.lifecycle.unmount();
  });

  it("uses recent activity and then name to break equal-count ties", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
        ],
        threads: [
          thread("alpha-thread", "alpha", 10),
          thread("beta-thread", "beta", 20),
          thread("gamma-thread", "gamma", 20),
        ],
      },
    });

    await waitForPreferences(slot.container);
    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Start a new chat in Beta",
      "Start a new chat in Gamma",
      "Start a new chat in Alpha",
    ]);

    slot.lifecycle.unmount();
  });

  it("applies ranking, visibility, count, and artwork settings", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: "unused" }, {
      settings: {
        showChatCounts: false,
        showUnusedProjects: false,
        includePersonalProject: false,
        loadProjectIcons: false,
      },
      sidebarThreads: {
        projects: [
          { id: "one", name: "One", isPersonal: false },
          { id: "two", name: "Two", isPersonal: false },
          { id: "unused", name: "Unused", isPersonal: false },
          { id: "personal", name: "Personal", isPersonal: true },
        ],
        threads: [
          thread("one-thread", "one", 30),
          thread("two-a", "two", 10),
          thread("two-b", "two", 20),
          thread("personal-thread", "personal", 40),
        ],
      },
    });

    await waitForPreferences(slot.container);
    fireEvent.change(slot.getByLabelText("Sort projects"), {
      target: { value: "Most chats" },
    });

    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.textContent)).toEqual([
      "Two",
      "One",
    ]);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
    expect(slot.container.querySelectorAll('svg[viewBox="0 0 24 24"]')).toHaveLength(2);
    expect(
      Array.from(slot.container.querySelectorAll("[data-homepage-project-icon]"))
        .every((icon) => icon.className.includes("bg-muted")),
    ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("sorts alphabetically while highlighting the composer project", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      composer: {
        scope: { kind: "new-thread", projectId: "zulu" },
      },
      sidebarThreads: {
        projects: [
          { id: "zulu", name: "Zulu", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "alpha", name: "Alpha", isPersonal: false },
        ],
        threads: [],
      },
    });

    await waitForPreferences(slot.container);
    fireEvent.change(slot.getByLabelText("Sort projects"), {
      target: { value: "Alphabetical" },
    });

    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Start a new chat in Alpha",
      "Start a new chat in Beta",
      "Start a new chat in Zulu",
    ]);
    const zulu = slot.getByRole("button", { name: "Start a new chat in Zulu" });
    expect(zulu.getAttribute("aria-current")).toBe("page");
    expect(zulu.className).toContain("bg-state-hover");

    await slot.behavior.setComposerScope({
      kind: "new-thread",
      projectId: "beta",
    });
    expect(slot.getByRole("button", { name: "Start a new chat in Beta" }).getAttribute("aria-current"))
      .toBe("page");
    expect(zulu.getAttribute("aria-current")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("persists manual ordering after drag and drop", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
        ],
        threads: [],
      },
    });

    await waitForPreferences(slot.container);
    fireEvent.change(slot.getByLabelText("Sort projects"), {
      target: { value: "Manual" },
    });

    const gamma = slot
      .getByRole("button", { name: "Start a new chat in Gamma" })
      .closest<HTMLElement>("[data-project-id]");
    const alpha = slot
      .getByRole("button", { name: "Start a new chat in Alpha" })
      .closest<HTMLElement>("[data-project-id]");
    expect(gamma?.draggable).toBe(false);
    expect(alpha?.draggable).toBe(false);
    expect(slot.container.querySelector("[data-drag-handle]")).toBeNull();

    pointAt(alpha!);
    Object.defineProperty(alpha, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100, height: 40 }),
    });
    const setPointerCapture = vi.fn();
    Object.defineProperty(gamma, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture,
    });
    firePointer(gamma!, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 200,
      pointerId: 1,
    });
    expect(setPointerCapture).not.toHaveBeenCalled();
    firePointer(gamma!, "pointermove", {
      clientX: 20,
      clientY: 90,
      pointerId: 1,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(gamma?.querySelector("[data-drag-handle]")).not.toBeNull();
    firePointer(gamma!, "pointerup", {
      clientX: 20,
      clientY: 90,
      pointerId: 1,
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Start a new chat in Gamma" }),
    );
    expect(slot.container.querySelector("[data-drag-handle]")).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([]);

    expect(
      slot
        .getAllByRole("button", { name: /Start a new chat/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Start a new chat in Gamma",
      "Start a new chat in Alpha",
      "Start a new chat in Beta",
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem("bb-plugin-homepage:manual-project-order") ?? "[]",
      ),
    ).toEqual(["gamma", "alpha", "beta"]);
    expect(window.localStorage.getItem("bb-plugin-homepage:ranking-mode"))
      .toBe("Manual");

    slot.lifecycle.unmount();

    const restored = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
        ],
        threads: [],
      },
    });
    await waitForPreferences(restored.container);
    expect((restored.getByLabelText("Sort projects") as HTMLSelectElement).value)
      .toBe("Manual");
    expect(
      restored
        .getAllByRole("button", { name: /Start a new chat/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Start a new chat in Gamma",
      "Start a new chat in Alpha",
      "Start a new chat in Beta",
    ]);
    restored.lifecycle.unmount();
  });

  it("keeps manual-mode cards clickable below the drag activation distance", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Manual");
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });
    const button = await slot.findByRole("button", {
      name: "Start a new chat in Alpha",
    });
    const card = button.closest<HTMLElement>("[data-project-id]");
    const setPointerCapture = vi.fn();
    Object.defineProperty(card, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture,
    });

    firePointer(card!, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1,
    });
    firePointer(card!, "pointermove", {
      clientX: 24,
      clientY: 23,
      pointerId: 1,
    });
    firePointer(card!, "pointerup", {
      button: 0,
      clientX: 24,
      clientY: 23,
      pointerId: 1,
    });
    fireEvent.click(button);

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { projectId: "alpha", focusPrompt: true },
    });
    slot.lifecycle.unmount();
  });

  it("keeps the homepage ordering choice in browser storage", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Most chats");
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "recent", name: "Recent", isPersonal: false },
          { id: "busy", name: "Busy", isPersonal: false },
        ],
        threads: [
          thread("recent-thread", "recent", 30),
          thread("busy-a", "busy", 10),
          thread("busy-b", "busy", 20),
        ],
      },
    });

    await waitForPreferences(slot.container);
    const selector = slot.getByLabelText("Sort projects") as HTMLSelectElement;
    expect(selector.value).toBe("Most chats");
    expect(slot.getAllByRole("button", { name: /Start a new chat/ })[0]?.textContent).toContain("Busy");

    fireEvent.change(selector, { target: { value: "Alphabetical" } });
    expect(window.localStorage.getItem("bb-plugin-homepage:ranking-mode"))
      .toBe("Alphabetical");

    selector.focus();
    fireEvent.pointerDown(selector);
    fireEvent.change(selector, { target: { value: "Manual" } });
    expect(document.activeElement).not.toBe(selector);
    expect(selector.className).not.toContain("ring-");

    selector.focus();
    fireEvent.keyDown(selector, { key: "ArrowUp" });
    fireEvent.change(selector, { target: { value: "Most chats" } });
    expect(document.activeElement).toBe(selector);
    slot.lifecycle.unmount();
  });

  it.each([
    ["loading", "status", "Loading projects..."],
    ["error", "alert", "Projects could not be loaded."],
    ["ready", "status", "No projects yet."],
  ] as const)("renders the %s state", async (status, role, text) => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: { status, projects: [], threads: [] },
    });

    if (status === "ready") await waitForPreferences(slot.container);
    expect(slot.getByRole(role).textContent).toBe(text);
    slot.lifecycle.unmount();
  });

  it("uses folder fallbacks for personal projects and failed images", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        getProjectArtwork: () => ({ kind: "image" }),
      },
      sidebarThreads: {
        projects: [
          { id: "personal", name: "Personal", isPersonal: true },
          { id: "work", name: "Work", isPersonal: false },
        ],
        threads: [],
      },
    });

    await waitFor(() => {
      expect(slot.container.querySelectorAll("img")).toHaveLength(1);
    });
    const images = slot.container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toContain("projectId=work");
    fireEvent.error(images[0]!);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
    expect(slot.container.querySelectorAll('svg[viewBox="0 0 24 24"]')).toHaveLength(2);

    slot.lifecycle.unmount();
  });

  it("shows an attention pill per card and summarizes collapsed groups", async () => {
    const groups = [{ id: "work", name: "Work", projectIds: ["alpha", "beta"] }];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups }),
        listHiddenProjects: () => ({ projectIds: [] }),
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
          { id: "delta", name: "Delta", isPersonal: false },
        ],
        threads: [
          { ...thread("alpha-ask", "alpha", 10), hasPendingInteraction: true },
          { ...thread("alpha-wait", "alpha", 11), indicator: "waiting-for-input" as const },
          { ...thread("alpha-run", "alpha", 12), indicator: "runtime" as const },
          { ...thread("beta-run", "beta", 13), indicator: "runtime" as const },
          { ...thread("gamma-boom", "gamma", 14), indicator: "unread-error" as const },
          thread("delta-quiet", "delta", 15),
        ],
      },
    });

    const alpha = await slot.findByRole("button", { name: "Start a new chat in Alpha" });
    expect(alpha.querySelector("[data-attention]")?.textContent).toBe("2 need you");
    expect(alpha.querySelector("[data-attention]")?.getAttribute("data-attention")).toBe("needsYou");
    expect(
      slot.getByRole("button", { name: "Start a new chat in Beta" })
        .querySelector("[data-attention]")?.textContent,
    ).toBe("Running");
    expect(
      slot.getByRole("button", { name: "Start a new chat in Gamma" })
        .querySelector("[data-attention]")?.textContent,
    ).toBe("Failed");
    expect(
      slot.getByRole("button", { name: "Start a new chat in Delta" })
        .querySelector("[data-attention]"),
    ).toBeNull();

    expect(slot.container.querySelector("[data-group-summary]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Collapse Work group" }));
    expect(slot.container.querySelector("[data-group-summary]")?.textContent).toBe(
      "2 need you · 2 running",
    );
    slot.lifecycle.unmount();
  });

  it("filters the launcher to projects that need you", async () => {
    const groups = [
      { id: "work", name: "Work", projectIds: ["alpha"] },
      { id: "side", name: "Side", projectIds: ["beta"] },
    ];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: ["gamma"] }),
        listProjectGroups: () => ({ groups }),
        listHiddenProjects: () => ({ projectIds: [] }),
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
          { id: "delta", name: "Delta", isPersonal: false },
        ],
        threads: [
          { ...thread("alpha-ask", "alpha", 10), hasPendingInteraction: true },
          { ...thread("beta-run", "beta", 11), indicator: "runtime" as const },
          { ...thread("gamma-ask", "gamma", 12), hasPendingInteraction: true },
        ],
      },
    });
    await waitForPreferences(slot.container);

    const chip = slot.getByRole("button", { name: "Needs you 2" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(
      slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Start a new chat in Gamma", "Start a new chat in Alpha"]);
    expect(slot.queryByRole("button", { name: /Side group/ })).toBeNull();

    fireEvent.click(chip);
    expect(slot.getAllByRole("button", { name: /Start a new chat/ })).toHaveLength(4);
    expect(slot.getByRole("button", { name: "Collapse Side group" })).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("hides the filter chip when nothing needs you", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [{ ...thread("alpha-run", "alpha", 10), indicator: "runtime" as const }],
      },
    });
    await waitForPreferences(slot.container);
    expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows checkout status on cards and refreshes it on demand", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const getProjectWorkspaceStatuses = vi.fn((_input: unknown) => ({
      statuses: {
        alpha: {
          kind: "available" as const,
          environmentId: "env-alpha",
          branch: "feature/cards",
          defaultBranch: "main",
          changes: { files: 2, insertions: 537, deletions: 119, lineStatsComplete: true },
          worktrees: 0,
          fetchedAt: 1,
        },
        beta: {
          kind: "available" as const,
          environmentId: "env-beta",
          branch: "main",
          defaultBranch: "main",
          changes: { files: 0, insertions: 0, deletions: 0, lineStatsComplete: true },
          worktrees: 0,
          fetchedAt: 1,
        },
        gamma: { kind: "none" as const, fetchedAt: 1 },
      },
    }));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups: [] }),
        listHiddenProjects: () => ({ projectIds: [] }),
        getProjectWorkspaceStatuses,
      },
      sidebarThreads: {
        projects: [
          { id: "alpha", name: "Alpha", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "gamma", name: "Gamma", isPersonal: false },
          { id: "personal", name: "Personal", isPersonal: true },
        ],
        threads: [thread("gamma-chat", "gamma", 10)],
      },
    });

    const alpha = await slot.findByRole("button", { name: "Start a new chat in Alpha" });
    await waitFor(() => {
      expect(alpha.querySelector("[data-workspace-changes]")?.textContent).toBe(
        "2 files+537 -119",
      );
    });
    // The branch is a glyph with the name in its tooltip, not text on the card.
    const branchMark = alpha.querySelector("[data-workspace-branch]");
    expect(branchMark?.textContent).toBe("");
    expect(branchMark?.getAttribute("title")).toBe("feature/cards");
    expect(branchMark?.getAttribute("aria-label")).toBe("On feature/cards");
    expect(alpha.querySelector(".text-diff-added")?.textContent).toBe("+537");
    expect(alpha.querySelector(".text-diff-removed")?.textContent).toBe("-119");
    // The chat subline stays; the checkout state is its own column.
    expect(alpha.textContent).toContain("No chats yet");
    const beta = slot.getByRole("button", { name: "Start a new chat in Beta" });
    // Two stacked lines, like the dirty state.
    expect(beta.querySelector("[data-workspace-changes]")?.textContent).toBe("NoChange");
    expect(beta.querySelector("[data-workspace-branch]")).toBeNull();
    const gamma = slot.getByRole("button", { name: "Start a new chat in Gamma" });
    expect(gamma.querySelector("[data-workspace-status]")).toBeNull();
    expect(gamma.textContent).toContain("1 chat");
    expect(
      slot.getByRole("button", { name: "Start a new chat in Personal" })
        .querySelector("[data-workspace-status]"),
    ).toBeNull();
    expect(getProjectWorkspaceStatuses).toHaveBeenCalledTimes(1);
    expect(getProjectWorkspaceStatuses.mock.calls[0]?.[0]).toEqual({
      projectIds: ["gamma", "alpha", "beta"],
      refresh: false,
    });

    fireEvent.click(slot.getByRole("button", { name: "Refresh checkout status" }));
    await waitFor(() => {
      expect(getProjectWorkspaceStatuses).toHaveBeenCalledTimes(2);
    });
    expect(getProjectWorkspaceStatuses.mock.calls[1]?.[0]).toEqual({
      projectIds: ["gamma", "alpha", "beta"],
      refresh: true,
    });
    await waitFor(() => {
      expect(
        slot.getByRole("button", { name: "Refresh checkout status" }).getAttribute("title"),
      ).toBe("Updated just now");
    });
    slot.lifecycle.unmount();
  });

  it("keeps chat counts when checkout status is turned off", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const getProjectWorkspaceStatuses = vi.fn(() => ({ statuses: {} }));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      settings: { showWorkspaceStatus: false },
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups: [] }),
        listHiddenProjects: () => ({ projectIds: [] }),
        getProjectWorkspaceStatuses,
      },
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [thread("alpha-chat", "alpha", 10)],
      },
    });
    await waitForPreferences(slot.container);
    expect(slot.queryByRole("button", { name: "Refresh checkout status" })).toBeNull();
    expect(getProjectWorkspaceStatuses).not.toHaveBeenCalled();
    expect(
      slot.getByRole("button", { name: "Start a new chat in Alpha" }).textContent,
    ).toContain("1 chat");
    slot.lifecycle.unmount();
  });

  it("lists worktrees when hovering a card's checkout status", async () => {
    const restoreMatches = stubTopLayerSelectors();
    const app = await loadPluginApp(() => import("../app"));
    const listProjectWorktrees = vi.fn((_input: unknown) => ({
      worktrees: [
        {
          environmentId: "wt-1",
          name: null,
          branch: "bb/dirty-thr_1",
          status: {
            kind: "available" as const,
            environmentId: "wt-1",
            branch: "bb/dirty-thr_1",
            defaultBranch: "main",
            changes: { files: 1, insertions: 3, deletions: 1, lineStatsComplete: true },
            worktrees: 0,
            fetchedAt: 1,
          },
        },
        {
          environmentId: "wt-2",
          name: null,
          branch: "bb/gone-thr_2",
          status: {
            kind: "unavailable" as const,
            environmentId: "wt-2",
            message: "Path is gone",
            fetchedAt: 1,
          },
        },
      ],
    }));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        listPinnedProjects: () => ({ projectIds: [] }),
        listProjectGroups: () => ({ groups: [] }),
        listHiddenProjects: () => ({ projectIds: [] }),
        getProjectWorkspaceStatuses: () => ({
          statuses: {
            alpha: {
              kind: "available" as const,
              environmentId: "env-alpha",
              branch: "main",
              defaultBranch: "main",
              changes: { files: 0, insertions: 0, deletions: 0, lineStatsComplete: true },
              worktrees: 2,
              fetchedAt: 1,
            },
          },
        }),
        listProjectWorktrees,
      },
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });

    try {
      const alpha = await slot.findByRole("button", { name: "Start a new chat in Alpha" });
      const status = await waitFor(() => {
        const element = alpha.querySelector("[data-workspace-status]");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(listProjectWorktrees).not.toHaveBeenCalled();
      fireEvent.pointerEnter(status);

      // Radix portals the card to document.body, outside the slot container.
      const card = await waitFor(() => {
        const element = document.body.querySelector(
          '[data-bb-plugin="homepage"][data-state="open"]',
        );
        expect(element).not.toBeNull();
        return element!;
      });
      expect(listProjectWorktrees).toHaveBeenCalledWith({ projectId: "alpha" });
      await waitFor(() => {
        expect(
          Array.from(card.querySelectorAll("div.flex.items-center")).map((row) => row.textContent),
        ).toEqual([
          "Checkout · mainNo change",
          "bb/dirty-thr_11 file, +3 -1",
          "bb/gone-thr_2Unavailable",
        ]);
      });
    } finally {
      slot.lifecycle.unmount();
      restoreMatches();
    }
  });

  it("renders a declared BB glyph as a masked tile", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: {
        getProjectArtwork: () => ({
          kind: "glyph",
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3h6v6H3z"/></svg>',
        }),
      },
      sidebarThreads: {
        projects: [{ id: "homepage", name: "Homepage", isPersonal: false }],
        threads: [],
      },
    });

    await waitFor(() => {
      expect(slot.container.querySelector("[data-homepage-project-glyph]")).not.toBeNull();
    });
    const glyph = slot.container.querySelector<HTMLElement>("[data-homepage-project-glyph]");
    expect(glyph?.style.maskImage).toContain("data:image/svg+xml");
    expect(
      slot.container.querySelector("[data-homepage-project-icon]")?.className,
    ).toContain("bg-muted");
    expect(slot.container.querySelector("img")).toBeNull();
    slot.lifecycle.unmount();
  });
});
