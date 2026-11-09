import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tool's own tests live in src/; hosts/<id> tests belong to their host toolchains
    // (WXT, the OpenClaw plugin SDK), which provide their own configs and dependencies.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Hermetic loopback: hosts set credentials-bearing HTTP(S)_PROXY without NO_PROXY,
    // which routes loopback test-server fetches through the proxy and breaks them.
    env: {
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
  },
});
