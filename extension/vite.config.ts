import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

function copyStatic(): Plugin {
  let dist = path.join(root, "dist");
  return {
    name: "copy-simmer-extension",
    configResolved(config) {
      dist = config.build.outDir;
    },
    async closeBundle() {
      for (const file of ["manifest.json", "background.js", "api-auth.mjs", "page-match.mjs", "options.html", "options.js", "popup.html"]) {
        copyFileSync(path.join(root, file), path.join(dist, file));
      }
      const iconsDir = path.join(dist, "icons");
      mkdirSync(iconsDir, { recursive: true });
      for (const file of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
        copyFileSync(path.join(root, "icons", file), path.join(iconsDir, file));
      }
      await build({
        absWorkingDir: root,
        entryPoints: ["src/popup.ts"],
        bundle: true,
        format: "iife",
        platform: "browser",
        outfile: path.join(dist, "popup.js"),
      });
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
        codeSplitting: false,
        entryFileNames: "content.js",
      },
    },
  },
});
