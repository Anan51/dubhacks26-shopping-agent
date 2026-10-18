import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

function copyStatic(): Plugin {
  return {
    name: "copy-simmer-extension",
    closeBundle() {
      const dist = path.join(root, "dist");
      for (const file of ["manifest.json", "background.js", "options.html", "options.js"]) {
        copyFileSync(path.join(root, file), path.join(dist, file));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyStatic()],
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, "src", "content.ts"),
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "content.js",
      },
    },
  },
});
