// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

// Reads docs/user/ and docs/dev.md + docs/dev/*.md via scripts/sync-
// content.mjs (run before every dev/build - Starlight's own docsLoader()
// only reads this project's own src/content/docs/, so that script is the
// bridge, not a duplication of content) and docs/api/openapi.json
// (generated later by the Stack's own `bun run gen:api-docs`, never
// hand-written) via starlight-openapi.
export default defineConfig({
  integrations: [
    starlight({
      title: "MaiPai Stack",
      description: "Docs for MaiPai Stack, the easy way to run your own local AI.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/getmaipai/stack" }],
      plugins: [
        starlightOpenAPI([
          {
            base: "api",
            schema: "../api/openapi.json",
            label: "API reference",
          },
        ]),
      ],
      sidebar: [
        {
          label: "Guide",
          items: [
            { slug: "guide/install" },
            { slug: "guide/getting-started" },
            { slug: "guide/update" },
            { slug: "guide/uninstall" },
            { slug: "guide/the-tray" },
            { slug: "guide/on-your-phone" },
            { slug: "guide/connect-a-coding-tool" },
            { slug: "guide/privacy" },
            { slug: "guide/fix-a-problem" },
          ],
        },
        {
          label: "Developer",
          items: [{ autogenerate: { directory: "dev" } }],
        },
        ...openAPISidebarGroups,
      ],
    }),
  ],
});
