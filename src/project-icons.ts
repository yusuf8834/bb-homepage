import { SaxesParser } from "saxes";

import { renderGlyphSvg } from "./glyphs.js";

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
const PROJECT_MANIFEST_MAX_BYTES = 1024 * 1024;

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
  kind: "image";
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export interface ProjectGlyph {
  kind: "glyph";
  svg: string;
}

export type ProjectArtwork = ProjectGlyph | ProjectIcon;

interface ManifestArtwork {
  glyph: string | null;
  path: string | null;
}

export async function findProjectArtwork(
  source: ProjectIconSource,
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectArtwork | null> {
  const manifestArtwork = await readManifestArtwork(source, projectId, signal);
  if (manifestArtwork.glyph !== null) {
    const svg = renderGlyphSvg(manifestArtwork.glyph);
    if (svg !== null) return { kind: "glyph", svg };
  }

  if (manifestArtwork.path !== null) {
    const declaredIcon = await readProjectIcon(
      source,
      projectId,
      manifestArtwork.path,
      signal,
    );
    if (declaredIcon !== null) return declaredIcon;
  }

  const [iconFiles, logoFiles] = await Promise.all([
    listProjectImageCandidates(source, projectId, "icon", signal),
    listProjectImageCandidates(source, projectId, "logo", signal),
  ]);
  const paths = new Set([...iconFiles, ...logoFiles]);
  if (manifestArtwork.path !== null) paths.delete(manifestArtwork.path);

  const rankedPaths = Array.from(paths).sort(
    (left, right) =>
      projectIconScore(right, manifestArtwork.path) -
        projectIconScore(left, manifestArtwork.path) ||
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
    return { kind: "image", bytes, mimeType };
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
      .filter((path): path is string => path !== null && isDiscoverableProjectIcon(path));
  } catch (error) {
    if (signal.aborted) throw error;
    return [];
  }
}

function isDiscoverableProjectIcon(path: string): boolean {
  // File search is fuzzy: its results can include screenshots and other assets.
  // Only infer artwork from conventional filenames. Arbitrary filenames can
  // still be selected explicitly through bb.branding in package.json.
  const name = path.split("/").at(-1) ?? path;
  return /^(?:favicon|icon|logo|apple-touch-icon)(?:[-_.](?:\d+(?:x\d+)?|dark|light|maskable|monochrome|precomposed))*\.(?:svg|png|webp|jpe?g|ico)$/i.test(name);
}

async function readManifestArtwork(
  source: ProjectIconSource,
  projectId: string,
  signal: AbortSignal,
): Promise<ManifestArtwork> {
  try {
    const file = await source.readFile({ projectId, path: "package.json", signal });
    if (
      file.contentEncoding !== "utf8" ||
      file.sizeBytes > PROJECT_MANIFEST_MAX_BYTES
    ) {
      return { glyph: null, path: null };
    }

    const manifest = JSON.parse(file.content) as {
      bb?: { branding?: { icon?: unknown; logo?: { light?: unknown } } };
    };
    const declaredIcon = manifest.bb?.branding?.icon;
    if (typeof declaredIcon === "string") {
      const path = normalizeProjectIconPath(declaredIcon);
      if (path !== null) return { glyph: null, path };

      const glyph = normalizeProjectGlyphName(declaredIcon);
      if (glyph !== null) return { glyph, path: null };
    }

    const declaredLogo = manifest.bb?.branding?.logo?.light;
    return {
      glyph: null,
      path:
        typeof declaredLogo === "string"
          ? normalizeProjectIconPath(declaredLogo)
          : null,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { glyph: null, path: null };
  }
}

export function normalizeProjectGlyphName(value: string): string | null {
  const name = value.trim();
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : null;
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
