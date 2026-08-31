import { describe, expect, it } from "vitest";
import {
  PROJECT_ICON_MAX_BYTES,
  findProjectIcon,
  isSafeSvg,
  normalizeProjectIconPath,
  projectIconMimeType,
  projectIconScore,
} from "../src/project-icons.js";

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

  it("returns a declared icon without running fuzzy project searches", async () => {
    let searches = 0;
    const icon = await findProjectIcon(
      {
        listFiles: async () => {
          searches += 1;
          return { files: [] };
        },
        readFile: async ({ path }) => {
          const content = path === "package.json"
            ? JSON.stringify({ bb: { branding: { icon: "brand.svg" } } })
            : '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
          return {
            content,
            contentEncoding: "utf8",
            mimeType: path === "package.json" ? "application/json" : "image/svg+xml",
            sizeBytes: content.length,
          };
        },
      },
      "project-1",
      new AbortController().signal,
    );

    expect(icon?.mimeType).toBe("image/svg+xml");
    expect(searches).toBe(0);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://example.com/x)"/></svg>',
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="fill"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '<svg xmlns="https://example.com/not-svg"/>',
  ])("rejects unsafe SVG: %s", (source) => {
    expect(isSafeSvg(new TextEncoder().encode(source))).toBe(false);
  });

  it("accepts inert SVG markup and same-document paint references", () => {
    const source = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<defs><linearGradient id="paint"><stop offset="1"/></linearGradient></defs>',
      '<path fill="url(#paint)" style="stroke:url(\'#paint\')" d="M0 0h10v10z"/>',
      "</svg>",
    ].join("");
    expect(isSafeSvg(new TextEncoder().encode(source))).toBe(true);
  });

  it("skips an unsafe SVG and serves the next safe bitmap", async () => {
    const icon = await findProjectIcon(
      {
        listFiles: async ({ query }) => ({
          files: query === "icon"
            ? [{ path: "icon.svg" }, { path: "fallback-icon.png" }]
            : [],
        }),
        readFile: async ({ path }) => {
          if (path === "package.json") throw new Error("not found");
          const content = path.endsWith(".svg")
            ? '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'
            : Buffer.from("png").toString("base64");
          return {
            content,
            contentEncoding: path.endsWith(".svg") ? "utf8" : "base64",
            mimeType: path.endsWith(".svg") ? "image/svg+xml" : "image/png",
            sizeBytes: content.length,
          };
        },
      },
      "project-1",
      new AbortController().signal,
    );

    expect(icon?.mimeType).toBe("image/png");
  });
});
