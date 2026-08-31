import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  outputDir: "output/playwright/test-results",
  reporter: "line",
  testDir: "tests/browser",
  timeout: 45_000,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 720, width: 1280 },
  },
  workers: 1,
});
