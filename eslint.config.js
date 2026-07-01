import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default defineConfig([
  globalIgnores(["dist", "coverage", "node_modules"]),
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: "error",
      "prefer-const": "error",
      curly: "error",
    },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: "error",
      "prefer-const": "error",
      curly: "error",
    },
  },
  {
    files: ["**/*.test.{ts,js}", "**/*.spec.{ts,js}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Type-aware linting for non-test TS source. `projectService` lets
    // typescript-eslint pull real type information from the project so rules
    // that reason about Promises (floating/misused/awaited) can run. Test and
    // spec files are excluded because tsconfig.json excludes them from the TS
    // project, so keeping them off type-aware rules avoids projectService
    // errors while they stay covered by the non-type-checked parser above.
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Server/CLI code runs on the stdio transport, where stdout carries the
    // JSON-RPC protocol stream. A stray console.log/info/debug there corrupts
    // the wire, so only console.warn/error (stderr) are permitted here. Tests
    // run off-transport and are exempt.
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  // Must be last: turns off ESLint rules that conflict with Prettier formatting.
  eslintConfigPrettier,
]);
