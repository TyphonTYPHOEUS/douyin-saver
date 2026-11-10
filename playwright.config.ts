import { defineConfig } from "@playwright/test";

const baseURL = process.env.BROWSER_TEST_URL || "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: ".browser-test/results",
  reporter: "list",
  use: { baseURL, headless: true, trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { channel: "chrome" } },
    ...(process.env.EDGE_EXECUTABLE_PATH ? [{
      name: "edge",
      use: { launchOptions: { executablePath: process.env.EDGE_EXECUTABLE_PATH } },
    }] : []),
  ],
  webServer: {
    command: "npm run setup && npm run dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
