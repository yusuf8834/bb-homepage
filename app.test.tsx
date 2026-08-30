// @vitest-environment jsdom

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

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
});

describe("project chat launcher", () => {
  it("ranks active root chats by count and opens the selected project", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    expect(slot.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Often2 chats+",
      "Once1 chat+",
      "UnusedNo chats yet+",
    ]);
    expect(slot.getByRole("button", { name: "Start a new chat in Often" }).getAttribute("aria-current"))
      .toBe("page");
    expect(slot.container.querySelectorAll('img[loading="lazy"]')).toHaveLength(3);
    expect(slot.container.querySelector("[data-homepage-sort]")?.className)
      .toContain("absolute -top-9 right-0");

    fireEvent.click(slot.getByRole("button", { name: "Start a new chat in Once" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "openNewThread",
      options: { projectId: "project-1", focusPrompt: true },
    });

    slot.lifecycle.unmount();
  });

  it("uses recent activity and then name to break equal-count ties", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    expect(slot.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Start a new chat in Beta",
      "Start a new chat in Gamma",
      "Start a new chat in Alpha",
    ]);

    slot.lifecycle.unmount();
  });

  it("applies ranking, visibility, count, and artwork settings", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    expect(slot.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Two+",
      "One+",
    ]);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
    expect(slot.container.querySelectorAll("svg")).toHaveLength(2);
    slot.lifecycle.unmount();
  });

  it("supports alphabetical ordering while keeping the current project first", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    expect(slot.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Start a new chat in Zulu",
      "Start a new chat in Alpha",
      "Start a new chat in Beta",
    ]);
    slot.lifecycle.unmount();
  });

  it("keeps the homepage ordering choice in browser storage", async () => {
    window.localStorage.setItem("bb-plugin-homepage:ranking-mode", "Most chats");
    const app = await loadPluginApp(() => import("./app"));
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
    expect(slot.getAllByRole("button")[0]?.textContent).toContain("Busy");

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
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, {
      sidebarThreads: { status, projects: [], threads: [] },
    });

    expect(slot.getByRole(role).textContent).toBe(text);
    slot.lifecycle.unmount();
  });

  it("uses folder fallbacks for personal projects and failed images", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
    expect(slot.container.querySelectorAll("svg")).toHaveLength(2);

    slot.lifecycle.unmount();
  });
});
