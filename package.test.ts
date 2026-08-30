import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("package boundaries", () => {
  it("uses only public SDK imports", async () => {
    const result = experimental_scanPublicSdkOnly(new URL(".", import.meta.url).pathname, {
      allow: [
        /^react(?:\/.*)?$/,
        /^saxes$/,
        /^zod$/,
        /^@radix-ui\/react-context-menu$/,
        /^@testing-library\/react$/,
        /^vitest\/config$/,
      ],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
