// Flat ESLint config for the whole Crypto SDK stack (Sprints 1–4).
// The three packages nest under crypto-sdk/, so this single config lints them all.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  // Non-type-checked recommended rules: fast, deterministic, no per-package tsconfig wiring.
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Tests may use throwaway bindings and looser typing.
    files: ["**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Config files and plain JS/MJS scripts run in Node with console access.
    files: ["**/*.config.ts", "**/*.config.js", "**/*.{js,mjs,cjs}", "scripts/**/*"],
    languageOptions: { globals: { ...globals.node }, sourceType: "module" },
    rules: { "no-console": "off" },
  },
);
