import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: ["terminal-pull.spec.ts", "viewport.spec.ts", "default-view.spec.ts"], fullyParallel: false,
  reporter: "list", timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5206", viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" },
  projects: [
    { name: "mobile-webkit", testMatch: "terminal-pull.spec.ts", use: { browserName: "webkit", isMobile: true } },
    { name: "webkit", testMatch: ["viewport.spec.ts", "default-view.spec.ts"], use: { browserName: "webkit" } },
  ],
  webServer: { command: "npm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5206 --strictPort", url: "http://127.0.0.1:5206", reuseExistingServer: false },
  outputDir: "test-results/gesture",
});
