import { defineConfig } from "vite";
import path from "node:path";

const repoRoot = import.meta.dirname;

export default defineConfig({
  root: path.join(repoRoot, "map-app"),
  base: "./",
  build: {
    outDir: path.join(repoRoot, "site", "map"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
