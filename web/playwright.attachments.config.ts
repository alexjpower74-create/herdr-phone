import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "attachments.spec.ts", fullyParallel: false,
  workers: 1, reporter: "list", timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5196", viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [{ name: "webkit", use: { browserName: "webkit" } }, { name: "chromium", use: { browserName: "chromium" } }],
  webServer: { command: "npm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5196 --strictPort", url: "http://127.0.0.1:5196", reuseExistingServer: false },
  outputDir: "test-results/attachments",
});
