import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// @maipai/ui's own source files import each other through `@/kit/*`,
// `@/ui/*`, `@/primitives/*`, `@/elements/*` and `@/dashboard/*`, meaning
// THEIR OWN `src/*`. The admin page's own code uses relative imports only,
// so every `@/` specifier that reaches Vite comes from the kit; this plugin
// sends it back through the package specifier (one id per file, so a
// context created in a kit module is never created twice). Same fix as
// Home's frontend/vite.config.ts, without the Home-specific half.
function kitAlias(): Plugin {
  const known = ["kit/", "ui/", "primitives/", "elements/", "dashboard/"];
  return {
    name: "maipai-stack-admin-kit-alias",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.startsWith("@/") || !importer) return null;
      const rest = source.slice(2);
      if (!known.some((prefix) => rest.startsWith(prefix))) return null;
      const path = rest.startsWith("kit/") ? rest.slice(4) : rest;
      return this.resolve(`@maipai/ui/src/${path}`, importer, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  // The Stack serves the built page at /admin/.
  base: "/admin/",
  plugins: [kitAlias(), react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 5188,
    // `bun run dev` here, the Stack on its own loopback port: the page and the API share one origin.
    proxy: {
      "/stack": { target: `http://127.0.0.1:${process.env.STACK_PORT ?? "8788"}`, changeOrigin: false },
      "/healthz": { target: `http://127.0.0.1:${process.env.STACK_PORT ?? "8788"}`, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
