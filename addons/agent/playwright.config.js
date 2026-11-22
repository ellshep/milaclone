// The agent page's browser test (W3.3). The spec starts the board, the MCP
// add-on and the page itself; @playwright/test comes from the repo root's
// install, so run `npm ci` there first.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' },
});
