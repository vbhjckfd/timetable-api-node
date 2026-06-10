import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pin the suite to UTC so timezone-sensitive code (e.g. Europe/Kyiv
    // service-day resolution) is tested the same way on dev machines in
    // Kyiv time and on UTC CI/servers.
    env: { TZ: "UTC" },
  },
});
