import { defineConfig } from "vitest/config";

export default defineConfig({
  // template/ holds a bundled Starter at release time; its tests belong to the Starter.
  test: { include: ["test/**/*.test.ts"] },
});
