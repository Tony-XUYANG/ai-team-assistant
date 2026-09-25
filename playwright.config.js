const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/ui",
  testMatch: process.env.UI_BASE_URL ? "workspace-live.spec.js" : "workspace-ui.spec.js",
  workers: 1,
  timeout: 15000,
  expect: { timeout: 5000 },
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.UI_BASE_URL || "http://127.0.0.1:8090",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.platform === "win32" ? {
      executablePath: process.env.BROWSER_EXECUTABLE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    } : {},
  },
  webServer: process.env.UI_BASE_URL ? undefined : { command: "node scripts/ui-fixture-server.js", url: "http://127.0.0.1:8090", reuseExistingServer: false, timeout: 10000 },
});
