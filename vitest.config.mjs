import { defineConfig } from 'vitest/config';

// UI unit tests: front-end modules imported into jsdom with the app's real markup.
// Modules that boot the whole app (anything importing main.js) stay in Playwright.
export default defineConfig({
  test: {
    include: ['test/ui/**/*.test.mjs'],
    environment: 'jsdom',
    setupFiles: ['test/ui/setup.mjs'],
    // Node 25+ ships its own localStorage global, which shadows jsdom's
    execArgv: ['--no-experimental-webstorage'],
    coverage: {
      provider: 'v8',
      include: ['public/js/**'],
      // ponytail: floor applies per unit-tested module; add a glob entry as more modules get unit tests
      thresholds: {
        'public/js/{state,util,viewport}.js': { lines: 80, branches: 80, functions: 80, statements: 80 },
      },
    },
  },
});
