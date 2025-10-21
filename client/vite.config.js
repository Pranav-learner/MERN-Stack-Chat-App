import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Only enable proxy during local development
    proxy:
      process.env.NODE_ENV === "development"
        ? {
            "/api": {
              target: "http://localhost:5000",
              changeOrigin: true,
            },
          }
        : undefined,
  },
  build: {
    outDir: "dist",
  },
});
