import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], env: { RUNI_TEST_MODE: "1" } } });
