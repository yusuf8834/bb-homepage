import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  buildProjectAttention,
  formatAttention,
  primaryAttention,
  sumAttention,
  summarizeAttention,
} from "../src/attention.js";

function thread(
  id: string,
  projectId: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
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
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  };
}

describe("project attention", () => {
  it("counts blocked, failed, and running threads per project", () => {
    const attention = buildProjectAttention([
      thread("ask", "alpha", { hasPendingInteraction: true }),
      thread("wait", "alpha", { indicator: "waiting-for-input" }),
      thread("child-ask", "alpha", { parentThreadId: "ask", hasPendingInteraction: true }),
      thread("boom", "alpha", { indicator: "unread-error" }),
      thread("busy", "alpha", { indicator: "runtime" }),
      thread("agents", "beta", {
        activity: { workflows: 0, backgroundAgents: 2, backgroundCommands: 0, planMode: 0, goals: 0 },
      }),
      thread("archived", "beta", { isArchived: true, hasPendingInteraction: true }),
      thread("done", "beta", { indicator: "unread-success" }),
      thread("quiet", "gamma"),
    ]);

    expect(attention.get("alpha")).toEqual({ needsYou: 3, failed: 1, running: 1 });
    expect(attention.get("beta")).toEqual({ needsYou: 0, failed: 0, running: 1 });
    expect(attention.has("gamma")).toBe(false);
  });

  it("counts a thread once under its most urgent state", () => {
    const attention = buildProjectAttention([
      thread("ask-while-running", "alpha", {
        hasPendingInteraction: true,
        indicator: "runtime",
      }),
    ]);
    expect(attention.get("alpha")).toEqual({ needsYou: 1, failed: 0, running: 0 });
  });

  it("picks the pill state by precedence and words counts", () => {
    expect(primaryAttention(undefined)).toBeNull();
    expect(primaryAttention({ needsYou: 0, failed: 0, running: 0 })).toBeNull();
    expect(primaryAttention({ needsYou: 2, failed: 1, running: 3 })).toEqual({
      kind: "needsYou",
      count: 2,
    });
    expect(primaryAttention({ needsYou: 0, failed: 1, running: 3 })).toEqual({
      kind: "failed",
      count: 1,
    });
    expect(formatAttention("needsYou", 1)).toBe("Needs you");
    expect(formatAttention("needsYou", 2)).toBe("2 need you");
    expect(formatAttention("failed", 2)).toBe("2 failed");
    expect(formatAttention("running", 1)).toBe("Running");
  });

  it("summarizes a group of projects", () => {
    const total = sumAttention([
      { needsYou: 2, failed: 0, running: 1 },
      undefined,
      { needsYou: 0, failed: 1, running: 2 },
    ]);
    expect(summarizeAttention(total)).toBe("2 need you · Failed · 3 running");
    expect(summarizeAttention({ needsYou: 0, failed: 0, running: 0 })).toBeNull();
  });
});
