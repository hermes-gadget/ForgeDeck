import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.FORGEDECK_ANALYZE === "true" ? [visualizer({ filename: "dist/bundle-report.html", gzipSize: true, brotliSize: true, open: false })] : [])
  ],
  build: {
    outDir: "dist",
    sourcemap: process.env.FORGEDECK_SOURCEMAP === "true"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/events": "http://127.0.0.1:4173"
    }
  }
});
