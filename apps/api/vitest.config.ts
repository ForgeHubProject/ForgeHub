import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Ensures each test file gets a fresh module registry so vi.mock works correctly
    isolate: true,
  },
});
