import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  baseURL: 'http://localhost:4188/PiPicoRFIDExperiments/',
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4188/PiPicoRFIDExperiments/',
    reuseExistingServer: !process.env['CI'],
    timeout: 120000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI']
    ? [['html', { open: 'never' }], ['github']]
    : 'list',
});
