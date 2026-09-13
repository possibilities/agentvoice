import { defineConfig } from "@playwright/test";

const port = Number(process.env["AGENTVOICE_TEST_PORT"] ?? 5198);
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
