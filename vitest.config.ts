import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./cli/src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    include: ["cli/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
  },
});
