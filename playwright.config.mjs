import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:43857";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.mjs",
  workers: 2,
  reporter: "list",
  use: { baseURL, browserName: "chromium", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "python3 -m http.server 43857 --bind 127.0.0.1 --directory site",
    url: baseURL + "/map/",
  },
});
