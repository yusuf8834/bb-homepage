// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("project chat launcher", () => {
  it("hides the main-page recent chats section and cleans up on disposal", async () => {
    const recents = document.createElement("section");
    recents.dataset.rootComposeMobileRecents = "";
    document.body.append(recents);

    const app = await loadPluginApp(() => import("../app"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "homepage" });
    const style = document.head.querySelector("style[data-bb-homepage-hide-recents]");

    expect(scripts.inspection.mountedIds).toEqual(["hide-homepage-recent-chats"]);
    expect(style?.textContent).toContain("[data-root-compose-mobile-recents]");
    expect(window.getComputedStyle(recents).display).toBe("none");

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
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1,
    ]);
  });

  it("ranks active root chats by count and opens the selected project", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: "project-2" }, {
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
    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.textContent)).toEqual([
      `Often2 chats · ${epochMonth}`,
      `Once1 chat · ${epochMonth}`,
      "UnusedNo chats yet",
    ]);
    expect(slot.getByRole("button", { name: "Start a new chat in Often" }).getAttribute("aria-current"))
      .toBe("page");
    expect(slot.container.querySelectorAll('img[loading="lazy"]')).toHaveLength(3);
    expect(slot.queryAllByRole("img", { name: /new chats? in the last 14 days/ }))
      .toHaveLength(0);
    expect(slot.container.querySelector("[data-homepage-sort]")?.className)
      .toContain("absolute -top-9 right-0");

    fireEvent.click(slot.getByRole("button", { name: "Start a new chat in Once" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { projectId: "project-1", focusPrompt: true },
    });

    slot.lifecycle.unmount();
  });

  it("renders pinned projects without hover pin controls", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const pinHandlers: PluginRpcTestHandlers<typeof rpcContract> = {
      listPinnedProjects: () => ({ projectIds: ["beta"] }),
      setProjectPinned: ({ projectId, pinned }) => ({
        projectIds: pinned ? ["beta", projectId] : [],
      }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
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
      listPinnedProjects: () => ({ projectIds: [] }),
      setProjectPinned: ({ projectId, pinned }) => ({
        projectIds: pinned ? [projectId] : [],
      }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
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

    // Radix marks closed context-menu triggers with data-state; opening the
    // menu itself deadlocks under jsdom, so the open path is verified live.
    const trigger = slot.container.querySelector('[data-state="closed"]');
    expect(trigger).not.toBeNull();
    expect(
      trigger?.querySelector('[aria-label="Start a new chat in Solo"]'),
    ).not.toBeNull();

    slot.lifecycle.unmount();
  });

  it("renames a project inline by right-clicking its icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpcHandlers: PluginRpcTestHandlers<typeof rpcContract> = {
      listPinnedProjects: () => ({ projectIds: [] }),
      setProjectPinned: () => ({ projectIds: [] }),
      renameProject: ({ projectId, name }) => ({ projectId, name }),
    };
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      rpc: rpcHandlers,
      sidebarThreads: {
        projects: [{ id: "solo", name: "Solo", isPersonal: false }],
        threads: [],
      },
    });

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

    const sparkline = slot.getByRole("img", {
      name: "Busy: 2 new chats in the last 14 days",
    });
    expect(sparkline.querySelectorAll("path")).toHaveLength(2);
    expect(sparkline.querySelectorAll("circle")).toHaveLength(1);
    expect(slot.queryByRole("img", { name: /^Idle:/ })).toBeNull();
    expect(slot.container.querySelectorAll('svg[viewBox="0 0 16 16"]')).toHaveLength(2);

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
        currentProjectFirst: false,
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

    fireEvent.change(slot.getByLabelText("Sort projects"), {
      target: { value: "Most chats" },
    });

    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.textContent)).toEqual([
      "Two",
      "One",
    ]);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
    expect(slot.container.querySelectorAll('svg[viewBox="0 0 24 24"]')).toHaveLength(2);
    slot.lifecycle.unmount();
  });

  it("supports alphabetical ordering while keeping the current project first", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: "zulu" }, {
      settings: { currentProjectFirst: true },
      sidebarThreads: {
        projects: [
          { id: "zulu", name: "Zulu", isPersonal: false },
          { id: "beta", name: "Beta", isPersonal: false },
          { id: "alpha", name: "Alpha", isPersonal: false },
        ],
        threads: [],
      },
    });

    fireEvent.change(slot.getByLabelText("Sort projects"), {
      target: { value: "Alphabetical" },
    });

    expect(slot.getAllByRole("button", { name: /Start a new chat/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Start a new chat in Zulu",
      "Start a new chat in Alpha",
      "Start a new chat in Beta",
    ]);
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
    firePointer(gamma!, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 200,
      pointerId: 1,
    });
    firePointer(gamma!, "pointermove", {
      clientX: 20,
      clientY: 90,
      pointerId: 1,
    });
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
    expect(slot.inspection.sidebarActionCalls).toEqual([]);

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

  it("still opens a project when a manual-mode pointer press does not move", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Manual");
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [{ id: "alpha", name: "Alpha", isPersonal: false }],
        threads: [],
      },
    });
    const button = slot.getByRole("button", {
      name: "Start a new chat in Alpha",
    });
    const card = button.closest<HTMLElement>("[data-project-id]");

    firePointer(card!, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1,
    });
    firePointer(card!, "pointerup", {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1,
    });
    fireEvent.click(button);

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

    const selector = slot.getByLabelText("Sort projects") as HTMLSelectElement;
    expect(selector.value).toBe("Most chats");
    expect(slot.getAllByRole("button", { name: /Start a new chat/ })[0]?.textContent).toContain("Busy");

    fireEvent.change(selector, { target: { value: "Alphabetical" } });
    expect(window.localStorage.getItem("bb-plugin-homepage:ranking-mode"))
      .toBe("Alphabetical");
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

    expect(slot.getByRole(role).textContent).toBe(text);
    slot.lifecycle.unmount();
  });

  it("uses folder fallbacks for personal projects and failed images", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: {
        projects: [
          { id: "personal", name: "Personal", isPersonal: true },
          { id: "work", name: "Work", isPersonal: false },
        ],
        threads: [],
      },
    });

    const images = slot.container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toContain("projectId=work");
    fireEvent.error(images[0]!);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
    expect(slot.container.querySelectorAll('svg[viewBox="0 0 24 24"]')).toHaveLength(2);

    slot.lifecycle.unmount();
  });
});
