import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { findProjectIcon } from "./project-icons.js";

const FOUND_CACHE_CONTROL = "private, max-age=300";
const MISSING_CACHE_CONTROL = "private, max-age=60";

export default function plugin(bb: BbPluginApi) {
  bb.http.route("GET", "/project-icon", async (context) => {
    const projectId = context.req.query("projectId")?.trim();
    if (!projectId) return new Response(null, { status: 400 });

    try {
      const icon = await findProjectIcon(
        {
          listFiles: (args) => bb.sdk.projects.files(args),
          readFile: (args) => bb.sdk.projects.fileContent(args),
        },
        projectId,
        context.req.raw.signal,
      );

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
