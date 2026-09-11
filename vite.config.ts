import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  base: "./",
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/backend/**"],
    },
  },
});
