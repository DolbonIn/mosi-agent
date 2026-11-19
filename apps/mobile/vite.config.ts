import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PICKLE_API lets parallel QA runs point at their own server (default: the dev server on 8787)
const target = process.env.PICKLE_API ?? "http://127.0.0.1:8787";
const api = { "/api": { target, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy: api },
  preview: { proxy: api },
  build: {
    target: "es2022",
    outDir: "dist",
    rolldownOptions: {
      output: {
        // first load = two parallel, modulepreloaded files: the libraries (react, framer-motion — cache-stable across
        // app deploys) and the app (shell + chat route). Everything not statically reachable from the entry
        // (lazyScreen() screens, the gallery, three/R3F, liquid-glass) stays in automatic lazy chunks.
        // Budget and measurements: FOUNDATION.md "Performance".
        codeSplitting: {
          groups: [
            { name: "vendor", tags: ["$initial"], test: /node_modules/, priority: 2 },
            { name: "app", tags: ["$initial"], priority: 1 },
          ],
        },
      },
    },
  },
});
