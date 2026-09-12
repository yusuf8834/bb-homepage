import { z } from "zod";

// BB's local helper contract: packages/host-daemon-contract/src/local.ts.
// Keep launches in the client so remote BB servers open apps on the user's machine.
const statusSchema = z.object({ hostId: z.string().min(1), serverUrl: z.string() });
const targetsSchema = z.object({
  targets: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    icon: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("builtin"), name: z.string().min(1) }),
      z.object({ kind: z.literal("data-url"), dataUrl: z.string().startsWith("data:image/").max(200_000) }),
      z.object({ kind: z.literal("symbol"), name: z.enum(["default-app", "file-manager", "terminal", "app"]) }),
    ]).optional(),
    capabilities: z.object({ openDirectory: z.boolean() }),
    remoteSshCapabilities: z.object({ openDirectory: z.boolean() }).optional(),
  })),
});

export interface ProjectOpenSource { hostId: string; path: string }
export interface ProjectOpenApps {
  baseUrl: string;
  source: ProjectOpenSource;
  context: { kind: "local" } | { kind: "remote-ssh"; hostId: string; serverOrigin: string };
  targets: z.infer<typeof targetsSchema>["targets"];
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`BB app discovery failed: HTTP ${response.status}`);
  return response.json();
}

export async function discoverProjectApps(
  source: ProjectOpenSource,
  ports: number[],
  serverOrigin: string,
  signal: AbortSignal,
): Promise<ProjectOpenApps> {
  const connections = await Promise.all([...new Set(ports)].map(async (port) => {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const status = statusSchema.parse(await readJson(`${baseUrl}/status`,
        AbortSignal.any([signal, AbortSignal.timeout(3000)])));
      return { baseUrl, status };
    } catch { return null; }
  }));
  signal.throwIfAborted();
  const available = connections.filter((connection) => connection !== null);
  const connection = available.find(({ status }) => {
    try { return new URL(status.serverUrl).origin === serverOrigin; } catch { return false; }
  }) ?? available[0];
  if (!connection) throw new Error("Open the BB desktop app to choose an app.");
  const isLocal = connection.status.hostId === source.hostId;
  const context: ProjectOpenApps["context"] = isLocal
    ? { kind: "local" }
    : { kind: "remote-ssh", hostId: source.hostId, serverOrigin };
  const query = isLocal ? `?${new URLSearchParams({ path: source.path })}` : "";
  const { targets } = targetsSchema.parse(await readJson(
    `${connection.baseUrl}/workspace-open-targets${query}`,
    AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  ));
  return {
    baseUrl: connection.baseUrl, source, context,
    targets: targets.filter((target) =>
      (isLocal ? target.capabilities : target.remoteSshCapabilities)?.openDirectory),
  };
}

export async function openProjectInApp(apps: ProjectOpenApps, targetId: string): Promise<void> {
  if (!apps.targets.some((target) => target.id === targetId)) throw new Error("App is unavailable.");
  const response = await fetch(`${apps.baseUrl}/open-in-target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: apps.context, path: apps.source.path, targetId,
      lineNumber: null, columnNumber: null }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = z.object({ message: z.string().min(1) }).safeParse(body);
    throw new Error(error.success ? error.data.message : `Could not open app: HTTP ${response.status}`);
  }
}
