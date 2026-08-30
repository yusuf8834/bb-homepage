import { SaxesParser } from "saxes";

const PROJECT_ICON_EXTENSIONS = new Set(["svg", "png", "webp", "jpg", "jpeg", "ico"]);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const BLOCKED_SVG_ELEMENTS = new Set([
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "foreignobject",
  "iframe",
  "image",
  "script",
  "set",
  "style",
  "video",
]);

export const PROJECT_ICON_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_MANIFEST_MAX_BYTES = 1024 * 1024;

interface ProjectFileContent {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType: string;
  sizeBytes: number;
}

export interface ProjectIconSource {
  listFiles(args: {
    projectId: string;
    query: string;
    limit: string;
    signal: AbortSignal;
  }): Promise<{ files: readonly { path: string }[] }>;
  readFile(args: {
    projectId: string;
    path: string;
    signal: AbortSignal;
  }): Promise<ProjectFileContent>;
}

export interface ProjectIcon {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export async function findProjectIcon(
  source: ProjectIconSource,
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectIcon | null> {
  const manifestIcon = await readManifestIconPath(source, projectId, signal);
  if (manifestIcon !== null) {
    const declaredIcon = await readProjectIcon(source, projectId, manifestIcon, signal);
    if (declaredIcon !== null) return declaredIcon;
  }

  const [iconFiles, logoFiles] = await Promise.all([
    listProjectImageCandidates(source, projectId, "icon", signal),
    listProjectImageCandidates(source, projectId, "logo", signal),
  ]);
  const paths = new Set([...iconFiles, ...logoFiles]);
  if (manifestIcon !== null) paths.delete(manifestIcon);

  const rankedPaths = Array.from(paths).sort(
    (left, right) =>
      projectIconScore(right, manifestIcon) - projectIconScore(left, manifestIcon) ||
      left.localeCompare(right),
  );

  for (const path of rankedPaths) {
    signal.throwIfAborted();
    const icon = await readProjectIcon(source, projectId, path, signal);
    if (icon !== null) return icon;
  }

  return null;
}

async function readProjectIcon(
  source: ProjectIconSource,
  projectId: string,
  path: string,
  signal: AbortSignal,
): Promise<ProjectIcon | null> {
  try {
    const file = await source.readFile({ projectId, path, signal });
    const mimeType = projectIconMimeType(path);
    if (file.sizeBytes > PROJECT_ICON_MAX_BYTES || mimeType === null) return null;

    const bytes = file.contentEncoding === "base64"
      ? Uint8Array.from(Buffer.from(file.content, "base64"))
      : new TextEncoder().encode(file.content);
    if (bytes.byteLength > PROJECT_ICON_MAX_BYTES) return null;
    if (mimeType === "image/svg+xml" && !isSafeSvg(bytes)) return null;
    return { bytes, mimeType };
  } catch (error) {
    if (signal.aborted) throw error;
    // A stale, unreadable, or unsafe candidate should not hide the next match.
    return null;
  }
}

export function isSafeSvg(bytes: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }

  let rootSeen = false;
  let rejected = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    rejected = true;
  });
  parser.on("processinginstruction", ({ target }) => {
    if (target.toLowerCase() !== "xml") rejected = true;
  });
  parser.on("opentag", (node) => {
    const localName = node.local.toLowerCase();
    if (!rootSeen) {
      rootSeen = true;
      if (localName !== "svg" || node.uri !== SVG_NAMESPACE) rejected = true;
    }
    if (node.uri !== SVG_NAMESPACE || BLOCKED_SVG_ELEMENTS.has(localName)) {
      rejected = true;
    }

    for (const attribute of Object.values(node.attributes)) {
      const attributeName = attribute.local.toLowerCase();
      if (
        attributeName.startsWith("on") ||
        (attribute.uri !== "" &&
          attribute.uri !== XML_NAMESPACE &&
          attribute.uri !== XLINK_NAMESPACE &&
          attribute.uri !== XMLNS_NAMESPACE) ||
        (attribute.uri === XML_NAMESPACE && attributeName === "base")
      ) {
        rejected = true;
        continue;
      }

      if (
        (attributeName === "href" || attributeName === "src") &&
        !isSameDocumentReference(attribute.value)
      ) {
        rejected = true;
      }
      if (/url\s*\(/i.test(attribute.value) && !isSafeSvgCss(attribute.value)) rejected = true;
      if (attributeName === "style" && !isSafeSvgCss(attribute.value)) rejected = true;
    }
  });
  parser.on("error", () => {
    rejected = true;
  });

  try {
    parser.write(source).close();
  } catch {
    return false;
  }
  return rootSeen && !rejected;
}

function isSameDocumentReference(value: string): boolean {
  const reference = value.trim();
  return reference.length === 0 || reference.startsWith("#");
}

function isSafeSvgCss(value: string): boolean {
  if (/@import|expression\s*\(|javascript\s*:|data\s*:|-moz-binding/i.test(value)) return false;
  const urlCalls = value.match(/url\s*\(([^)]*)\)/gi) ?? [];
  if ((value.match(/url\s*\(/gi) ?? []).length !== urlCalls.length) return false;
  return urlCalls.every((call) => {
    const target = call.slice(call.indexOf("(") + 1, -1).trim().replace(/^(['"])(.*)\1$/, "$2");
    return target.startsWith("#");
  });
}

async function listProjectImageCandidates(
  source: ProjectIconSource,
  projectId: string,
  query: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const result = await source.listFiles({ projectId, query, limit: "100", signal });
    return result.files
      .map((file) => normalizeProjectIconPath(file.path))
      .filter((path): path is string => path !== null);
  } catch (error) {
    if (signal.aborted) throw error;
    return [];
  }
}

async function readManifestIconPath(
  source: ProjectIconSource,
  projectId: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const file = await source.readFile({ projectId, path: "package.json", signal });
    if (
      file.contentEncoding !== "utf8" ||
      file.sizeBytes > PROJECT_MANIFEST_MAX_BYTES
    ) {
      return null;
    }

    const manifest = JSON.parse(file.content) as {
      bb?: { branding?: { icon?: unknown; logo?: { light?: unknown } } };
    };
    const declared = manifest.bb?.branding?.icon ?? manifest.bb?.branding?.logo?.light;
    return typeof declared === "string" ? normalizeProjectIconPath(declared) : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

export function normalizeProjectIconPath(value: string): string | null {
  let path = value.trim().replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);

  const extension = path.split(".").at(-1)?.toLowerCase();
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.includes("\0") ||
    path.split("/").includes("..") ||
    extension === undefined ||
    !PROJECT_ICON_EXTENSIONS.has(extension)
  ) {
    return null;
  }

  const lower = `/${path.toLowerCase()}`;
  const ignoredDirectories = ["/node_modules/", "/.git/", "/dist/", "/build/", "/coverage/"];
  if (ignoredDirectories.some((directory) => lower.includes(directory))) return null;

  return path;
}

export function projectIconMimeType(path: string): string | null {
  switch (path.split(".").at(-1)?.toLowerCase()) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "ico":
      return "image/x-icon";
    default:
      return null;
  }
}

export function projectIconScore(path: string, manifestIcon: string | null): number {
  if (path === manifestIcon) return 10_000;

  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  const depth = lower.split("/").length - 1;
  let score = 0;

  if (name.startsWith("favicon.")) score += 900;
  else if (name.startsWith("icon.")) score += 850;
  else if (name.startsWith("apple-touch-icon.")) score += 825;
  else if (name.startsWith("logo.")) score += 800;
  else if (name.includes("icon")) score += 650;
  else if (name.includes("logo")) score += 600;

  if (lower.startsWith("public/")) score += 120;
  else if (lower.startsWith("app/") || lower.startsWith("src/app/")) score += 100;
  else if (depth === 0) score += 90;

  if (/\.svg$/i.test(lower)) score += 60;
  else if (/\.png$/i.test(lower)) score += 50;
  else if (/\.webp$/i.test(lower)) score += 40;
  else if (/\.ico$/i.test(lower)) score += 30;

  if (/(dark|light|maskable|monochrome)/i.test(name)) score -= 80;
  return score - depth * 5;
}
