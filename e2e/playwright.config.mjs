import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 4173)
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1, // one shared runtime/harness; every test resets it
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../test-results',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node e2e/harness.mjs',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/__e2e/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // phone-sized viewport with touch; runs the scenarios tagged @mobile
    { name: 'mobile', grep: /@mobile/, use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
})
