import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ProjectIconCache } from "./src/project-icon-cache.js";
import { findProjectIcon } from "./src/project-icons.js";

const FOUND_CACHE_CONTROL = "private, max-age=300";
const MISSING_CACHE_CONTROL = "private, max-age=60";
const PINNED_PROJECTS_KEY = "pinned-projects";

export const rpcContract = defineRpcContract({
  listPinnedProjects: {
    input: z.null(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  setProjectPinned: {
    input: z.object({ projectId: z.string().min(1), pinned: z.boolean() }).strict(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  renameProject: {
    input: z
      .object({
        projectId: z.string().min(1),
        name: z.string().trim().min(1).max(200),
      })
      .strict(),
    output: z.object({ projectId: z.string(), name: z.string() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    currentProjectFirst: {
      type: "boolean",
      label: "Current project first",
      description: "Keep the currently selected project at the top.",
      default: true,
    },
    showChatCounts: {
      type: "boolean",
      label: "Show chat counts",
      default: true,
    },
    showUnusedProjects: {
      type: "boolean",
      label: "Show projects without chats",
      default: true,
    },
    includePersonalProject: {
      type: "boolean",
      label: "Include Personal",
      default: true,
    },
    loadProjectIcons: {
      type: "boolean",
      label: "Load project artwork",
      description: "Discover icons and logos from project files.",
      default: true,
    },
  });

  async function readPinnedProjects(): Promise<string[]> {
    const stored = await bb.storage.kv.get<unknown>(PINNED_PROJECTS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is string => typeof value === "string");
  }

  bb.rpc.register(rpcContract, {
    async listPinnedProjects() {
      return { projectIds: await readPinnedProjects() };
    },
    async setProjectPinned({ projectId, pinned }) {
      const current = await readPinnedProjects();
      const next = pinned
        ? current.includes(projectId)
          ? current
          : [...current, projectId]
        : current.filter((id) => id !== projectId);
      if (next.length !== current.length) {
        await bb.storage.kv.set(PINNED_PROJECTS_KEY, next);
        bb.realtime.publish("pins-changed", null);
      }
      return { projectIds: next };
    },
    async renameProject({ projectId, name }) {
      const project = await bb.sdk.projects.update({ projectId, name });
      return { projectId: project.id, name: project.name };
    },
  });

  const iconCache = new ProjectIconCache((projectId, signal) =>
    findProjectIcon(
      {
        listFiles: (args) => bb.sdk.projects.files(args),
        readFile: (args) => bb.sdk.projects.fileContent(args),
      },
      projectId,
      signal,
    ),
  );
  bb.onDispose(() => iconCache.dispose());

  bb.http.route("GET", "/project-icon", async (context) => {
    const projectId = context.req.query("projectId")?.trim();
    if (!projectId) return new Response(null, { status: 400 });

    try {
      const icon = await iconCache.get(projectId);

      if (icon === null) {
        return new Response(null, {
          status: 404,
          headers: { "cache-control": MISSING_CACHE_CONTROL },
        });
      }

      return new Response(icon.bytes, {
        headers: {
          "cache-control": FOUND_CACHE_CONTROL,
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "content-type": icon.mimeType,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      bb.log.debug(
        `Could not load an icon for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Response(null, {
        status: 404,
        headers: { "cache-control": MISSING_CACHE_CONTROL },
      });
    }
  });
}
