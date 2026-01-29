import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["src/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "e2e",
      include: ["tests/**/*.e2e.ts"],
      setupFiles: ["tests/e2e/setup-env.ts"],
      testTimeout: 30_000,
    },
  },
]);
