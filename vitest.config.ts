import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Subprocess golden tests spawn tsx, which pays full ts-morph startup cost per run.
    testTimeout: 30_000,
  },
});
