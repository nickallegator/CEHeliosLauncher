const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 60000,
    expect: {
        timeout: 10000
    },
    retries: 0,
    reporter: [['list']],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    }
})
