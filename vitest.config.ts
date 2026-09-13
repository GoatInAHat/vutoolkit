import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tool's own tests live in src/; hosts/<id> tests belong to their host toolchains
    // (WXT, the OpenClaw plugin SDK), which provide their own configs and dependencies.
    include: ["src/**/*.test.ts"],
  },
});
