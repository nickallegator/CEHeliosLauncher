# E2E Test Scaffold

End-to-end smoke tests use Playwright + Electron.

Setup:
1) Install browser deps:
   `npm run test:e2e:install`

Run:
`npm run test:e2e`

Current coverage:
- Launches the app
- Opens the Community schematics page
- Verifies the schematics library header is visible
