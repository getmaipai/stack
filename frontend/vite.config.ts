import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The built UI is served by the same Stack process. The dev server proxies
// the same paths so the browser stays on one origin during development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { rollupOptions: { output: { entryFileNames: "assets/index.js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } } },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8770",
      "/stack": "http://127.0.0.1:8770",
      "/v1": "http://127.0.0.1:8770",
      "/healthz": "http://127.0.0.1:8770",
    },
  },
});
