// Browser smoke tests (tests/e2e). Run with `npm run test:e2e`.
//
// The app is served from the repo root by tests/e2e/server.js, exactly as
// GitHub Pages serves it (no build). Every request that is not to that server
// is aborted, except api.discogs.com, which tests/e2e/fixtures.js fakes.
//
// Browser: @playwright/test is pinned to the release whose Chromium build
// `npx playwright install chromium` fetches (CI does that). To use some other
// Chromium/Chrome binary instead (e.g. one already on disk), set
//   PW_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 41730);
const BASE_URL = 'http://127.0.0.1:' + PORT + '/';
const CI = !!process.env.CI;

module.exports = defineConfig({
    testDir: 'tests/e2e',
    testMatch: '**/*.spec.js',
    fullyParallel: true,
    forbidOnly: CI,
    // One retry on CI so a one-off hiccup is reported as "flaky" (visible in
    // the report) rather than failing the run; locally a failure is a failure.
    retries: CI ? 1 : 0,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: BASE_URL,
        // The app registers none, but a worker could bypass page.route().
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        launchOptions: {
            executablePath: process.env.PW_CHROMIUM_PATH || undefined,
        },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'node tests/e2e/server.js ' + PORT,
        url: BASE_URL + 'index.html',
        reuseExistingServer: !CI,
        timeout: 10_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
