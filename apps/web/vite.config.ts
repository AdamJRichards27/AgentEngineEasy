import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Replit (and similar cloud IDEs) serve the dev server through a proxy
    // on a dynamic, per-project *.replit.dev hostname. Vite's default host
    // check rejects any Host header it doesn't recognize ("Blocked
    // request"), so we allow all hosts here — this dev server is not
    // exposed as a production build, only as a local/sandboxed preview.
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
