import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverProjectApps, openProjectInApp } from "../src/project-open.js";

afterEach(() => vi.unstubAllGlobals());
const source = { hostId: "local", path: "/projects/a folder" };
const targets = [
  { id: "finder", label: "Finder", icon: { kind: "builtin", name: "finder" }, capabilities: { openDirectory: true } },
  { id: "code", label: "VS Code", capabilities: { openDirectory: true }, remoteSshCapabilities: { openDirectory: true } },
  { id: "viewer", label: "Viewer", capabilities: { openDirectory: false } },
];
function mockHelper() {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/status")) return Response.json({ hostId: "local", serverUrl: "https://bb.test" });
    if (options?.method === "POST") return Response.json({ ok: true });
    return Response.json({ targets });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("BB project app launcher", () => {
  it("discovers directory apps and opens the exact local checkout through BB's helper", async () => {
    const fetch = mockHelper();
    const apps = await discoverProjectApps(source, [1234], "https://bb.test", new AbortController().signal);
    expect(apps.targets.map((app) => app.id)).toEqual(["finder", "code"]);
    expect(apps.targets[0]?.icon).toEqual({ kind: "builtin", name: "finder" });
    expect(fetch.mock.calls[1]?.[0]).toBe("http://127.0.0.1:1234/workspace-open-targets?path=%2Fprojects%2Fa+folder");
    await openProjectInApp(apps, "code");
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toEqual({
      context: { kind: "local" }, path: source.path, targetId: "code", lineNumber: null, columnNumber: null,
    });
  });

  it("filters remote apps and passes the remote host instead of treating its path as local", async () => {
    const fetch = mockHelper();
    const apps = await discoverProjectApps({ ...source, hostId: "remote" }, [1234], "https://bb.test", new AbortController().signal);
    expect(apps.targets.map((app) => app.id)).toEqual(["code"]);
    expect(fetch.mock.calls[1]?.[0]).toBe("http://127.0.0.1:1234/workspace-open-targets");
    await openProjectInApp(apps, "code");
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string).context).toEqual({
      kind: "remote-ssh", hostId: "remote", serverOrigin: "https://bb.test",
    });
    await expect(openProjectInApp(apps, "finder")).rejects.toThrow("unavailable");
  });

  it("reports an unavailable desktop helper", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(discoverProjectApps(source, [1234], "https://bb.test", new AbortController().signal))
      .rejects.toThrow("Open the BB desktop app");
  });

  it("surfaces native launch failures", async () => {
    const fetch = mockHelper();
    const apps = await discoverProjectApps(source, [1234], "https://bb.test", new AbortController().signal);
    fetch.mockResolvedValueOnce(Response.json({ message: "App was uninstalled" }, { status: 400 }));
    await expect(openProjectInApp(apps, "code")).rejects.toThrow("App was uninstalled");
  });
});
