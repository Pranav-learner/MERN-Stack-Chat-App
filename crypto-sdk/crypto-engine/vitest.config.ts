import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the Sprint 1 Crypto SDK from source so tests exercise the real SDK
// without a build step. Sprints 1 & 2 remain untouched.
export default defineConfig({
  resolve: {
    alias: {
      "@securechat/crypto-sdk": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
