import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx,js,jsx}", "scripts/**/*.{test,spec}.{ts,tsx,js,jsx}"],
    coverage: {
      provider: "v8",
      all: true,
      // "text" prints the summary in CI logs; "lcov" writes coverage/lcov.info
      // for Codecov upload.
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "scripts/**/*.js"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.js", "**/*.spec.js"],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
