'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = 4322;

// ponytail: the app auto-saves to SQLite, so tests run against a throwaway
// DATA_DIR (wiped each run) on a non-default port — never touches real boards.
module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `rm -rf .e2e-data && DATA_DIR=.e2e-data PORT=${PORT} node server.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20000,
  },
});
