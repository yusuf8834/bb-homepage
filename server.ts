import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ProjectIconCache } from "./src/project-icon-cache.js";
import {
  findProjectArtwork,
  type ProjectArtwork,
} from "./src/project-icons.js";

const FOUND_CACHE_CONTROL = "private, max-age=300";
const MISSING_CACHE_CONTROL = "private, max-age=60";
const PINNED_PROJECTS_KEY = "pinned-projects";
const HIDDEN_PROJECTS_KEY = "hidden-projects";
const PROJECT_GROUPS_KEY = "project-groups";
const MAX_PROJECT_GROUPS = 100;

const projectGroupSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    projectIds: z.array(z.string().min(1)).max(10_000),
  })
  .strict();

export type ProjectGroup = z.infer<typeof projectGroupSchema>;

export const rpcContract = defineRpcContract({
  listPinnedProjects: {
    input: z.null(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  setProjectPinned: {
    input: z.object({ projectId: z.string().min(1), pinned: z.boolean() }).strict(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  listProjectGroups: {
    input: z.null(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  createProjectGroup: {
    input: z
      .object({
        name: z.string().trim().min(1).max(80),
        projectId: z.string().min(1).optional(),
      })
      .strict(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  renameProjectGroup: {
    input: z
      .object({
        groupId: z.string().min(1),
        name: z.string().trim().min(1).max(80),
      })
      .strict(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  deleteProjectGroup: {
    input: z.object({ groupId: z.string().min(1) }).strict(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  reorderProjectGroups: {
    input: z
      .object({ groupIds: z.array(z.string().min(1)).max(MAX_PROJECT_GROUPS) })
      .strict(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  setProjectGroup: {
    input: z
      .object({
        projectId: z.string().min(1),
        groupId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ groups: z.array(projectGroupSchema) }),
  },
  listHiddenProjects: {
    input: z.null(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  setProjectHidden: {
    input: z.object({ projectId: z.string().min(1), hidden: z.boolean() }).strict(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  resetHiddenProjects: {
    input: z.null(),
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
  getProjectArtwork: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("glyph"), svg: z.string() }),
      z.object({ kind: z.literal("image") }),
      z.object({ kind: z.literal("missing") }),
    ]),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
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

  async function readHiddenProjects(): Promise<string[]> {
    const stored = await bb.storage.kv.get<unknown>(HIDDEN_PROJECTS_KEY);
    if (!Array.isArray(stored)) return [];
    return [...new Set(
      stored.filter((value): value is string =>
        typeof value === "string" && value.length > 0,
      ),
    )].slice(0, 10_000);
  }

  async function readProjectGroups(): Promise<ProjectGroup[]> {
    const stored = await bb.storage.kv.get<unknown>(PROJECT_GROUPS_KEY);
    if (!Array.isArray(stored)) return [];

    const groups: ProjectGroup[] = [];
    const groupIds = new Set<string>();
    const assignedProjectIds = new Set<string>();
    for (const value of stored) {
      const parsed = projectGroupSchema.safeParse(value);
      if (!parsed.success || groupIds.has(parsed.data.id)) continue;

      groupIds.add(parsed.data.id);
      const projectIds = [...new Set(parsed.data.projectIds)].filter((projectId) => {
        if (assignedProjectIds.has(projectId)) return false;
        assignedProjectIds.add(projectId);
        return true;
      });
      groups.push({ ...parsed.data, projectIds });
      if (groups.length === MAX_PROJECT_GROUPS) break;
    }
    return groups;
  }

  async function writeProjectGroups(groups: ProjectGroup[]): Promise<ProjectGroup[]> {
    await bb.storage.kv.set(PROJECT_GROUPS_KEY, groups);
    bb.realtime.publish("project-groups-changed", null);
    return groups;
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
    async listProjectGroups() {
      return { groups: await readProjectGroups() };
    },
    async createProjectGroup({ name, projectId }) {
      const current = await readProjectGroups();
      if (current.length >= MAX_PROJECT_GROUPS) {
        throw new Error(`A maximum of ${MAX_PROJECT_GROUPS} project groups is allowed.`);
      }

      const groups = projectId
        ? current.map((group) => ({
            ...group,
            projectIds: group.projectIds.filter((id) => id !== projectId),
          }))
        : current;
      groups.push({
        id: crypto.randomUUID(),
        name,
        projectIds: projectId ? [projectId] : [],
      });
      return { groups: await writeProjectGroups(groups) };
    },
    async renameProjectGroup({ groupId, name }) {
      const current = await readProjectGroups();
      if (!current.some((group) => group.id === groupId)) {
        throw new Error("Project group not found.");
      }
      const groups = current.map((group) =>
        group.id === groupId ? { ...group, name } : group,
      );
      return { groups: await writeProjectGroups(groups) };
    },
    async deleteProjectGroup({ groupId }) {
      const current = await readProjectGroups();
      const groups = current.filter((group) => group.id !== groupId);
      if (groups.length === current.length) return { groups: current };
      return { groups: await writeProjectGroups(groups) };
    },
    async reorderProjectGroups({ groupIds }) {
      const current = await readProjectGroups();
      const groupsById = new Map(current.map((group) => [group.id, group]));
      const orderedIds = [...new Set(groupIds)].filter((id) => groupsById.has(id));
      const requestedIds = new Set(orderedIds);
      const groups = [
        ...orderedIds.map((id) => groupsById.get(id)!),
        ...current.filter((group) => !requestedIds.has(group.id)),
      ];
      if (groups.every((group, index) => group.id === current[index]?.id)) {
        return { groups: current };
      }
      return { groups: await writeProjectGroups(groups) };
    },
    async setProjectGroup({ projectId, groupId }) {
      const current = await readProjectGroups();
      if (groupId !== null && !current.some((group) => group.id === groupId)) {
        throw new Error("Project group not found.");
      }
      const groups = current.map((group) => ({
        ...group,
        projectIds: group.projectIds.filter((id) => id !== projectId),
      }));
      if (groupId !== null) {
        const target = groups.find((group) => group.id === groupId)!;
        target.projectIds.push(projectId);
      }
      const changed = current.some((group, index) =>
        group.projectIds.join("\0") !== groups[index]!.projectIds.join("\0"),
      );
      return { groups: changed ? await writeProjectGroups(groups) : current };
    },
    async listHiddenProjects() {
      return { projectIds: await readHiddenProjects() };
    },
    async setProjectHidden({ projectId, hidden }) {
      const current = await readHiddenProjects();
      const next = hidden
        ? current.includes(projectId)
          ? current
          : [...current, projectId]
        : current.filter((id) => id !== projectId);
      if (next.length !== current.length) {
        await bb.storage.kv.set(HIDDEN_PROJECTS_KEY, next);
        bb.realtime.publish("hidden-projects-changed", null);
      }
      return { projectIds: next };
    },
    async resetHiddenProjects() {
      const current = await readHiddenProjects();
      if (current.length > 0) {
        await bb.storage.kv.delete(HIDDEN_PROJECTS_KEY);
        bb.realtime.publish("hidden-projects-changed", null);
      }
      return { projectIds: [] };
    },
    async renameProject({ projectId, name }) {
      const project = await bb.sdk.projects.update({ projectId, name });
      return { projectId: project.id, name: project.name };
    },
    async getProjectArtwork({ projectId }) {
      const artwork = await iconCache.get(projectId);
      if (artwork === null) return { kind: "missing" as const };
      return artwork.kind === "glyph"
        ? { kind: "glyph" as const, svg: artwork.svg }
        : { kind: "image" as const };
    },
  });

  const iconCache = new ProjectIconCache<ProjectArtwork>((projectId, signal) =>
    findProjectArtwork(
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

      if (icon === null || icon.kind !== "image") {
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
