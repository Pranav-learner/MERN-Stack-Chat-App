import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the Sprint 1 Crypto SDK directly from source so tests exercise the
// real SDK without requiring a prior build step. This keeps Sprint 1 untouched.
export default defineConfig({
  resolve: {
    alias: {
      "@securechat/crypto-sdk": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
