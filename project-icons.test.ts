import { describe, expect, it } from "vitest";
import {
  PROJECT_ICON_MAX_BYTES,
  findProjectIcon,
  normalizeProjectIconPath,
  projectIconMimeType,
  projectIconScore,
} from "./project-icons.js";

describe("project icon policy", () => {
  it.each([
    ["./icons/project.svg", "icons/project.svg"],
    [".\\icons\\project.png", "icons/project.png"],
    ["public/favicon.ico", "public/favicon.ico"],
    ["../secret.svg", null],
    ["/tmp/icon.svg", null],
    ["https://example.com/icon.svg", null],
    ["node_modules/package/icon.svg", null],
    ["dist/icon.svg", null],
    ["icon.gif", null],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeProjectIconPath(input)).toBe(expected);
  });

  it("prefers declared branding, then common public icons", () => {
    expect(projectIconScore("icons/brand.svg", "icons/brand.svg")).toBe(10_000);
    expect(projectIconScore("public/favicon.svg", null)).toBeGreaterThan(
      projectIconScore("src/deep/company-logo-light.png", null),
    );
  });

  it.each([
    ["icon.svg", "image/svg+xml"],
    ["icon.png", "image/png"],
    ["icon.webp", "image/webp"],
    ["icon.jpeg", "image/jpeg"],
    ["favicon.ico", "image/x-icon"],
    ["icon.gif", null],
  ])("maps %s to a safe MIME type", (path, expected) => {
    expect(projectIconMimeType(path)).toBe(expected);
  });

  it("skips oversized candidates", async () => {
    const icon = await findProjectIcon(
      {
        listFiles: async ({ query }) => ({
          files: query === "icon" ? [{ path: "public/icon.png" }] : [],
        }),
        readFile: async ({ path }) => {
          if (path === "package.json") throw new Error("not found");
          return {
            content: "too large",
            contentEncoding: "utf8",
            mimeType: "image/png",
            sizeBytes: PROJECT_ICON_MAX_BYTES + 1,
          };
        },
      },
      "project-1",
      new AbortController().signal,
    );

    expect(icon).toBeNull();
  });
});
