const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

test('packaged authenticated channel starts from a JAR-free bootstrap at shortcut cwd', async () => {
    test.setTimeout(60000)
    test.skip(!process.env.E2E_CHANNEL_EXE, 'Set E2E_CHANNEL_EXE to run the authenticated channel package smoke test.')
    const executablePath = path.resolve(process.env.E2E_CHANNEL_EXE)
    const appArchive = path.join(path.dirname(executablePath), 'resources', 'app.asar')
    const packagedFiles = asar.listPackage(appArchive)
    expect(packagedFiles.some(file => /^[/\\](backend|packs|scripts|tests|patches|deps)([/\\]|$)/.test(file))).toBe(false)
    expect(packagedFiles.some(file => /(^|[/\\])\.env$/.test(file))).toBe(false)
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-e2e-'))
    const appData = path.join(tempRoot, 'appdata')
    const userData = path.join(tempRoot, 'user-data')
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(userData, { recursive: true })
    const app = await electron.launch({
        executablePath,
        cwd: path.dirname(executablePath),
        args: [`--user-data-dir=${userData}`],
        env: { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(tempRoot, 'local-appdata') }
    })
    try {
        const page = await app.firstWindow()
        const rendererErrors = []
        page.on('pageerror', err => rendererErrors.push(err.message))
        await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 25000 })
        const resources = path.join(path.dirname(executablePath), 'resources', 'tester')
        const channel = JSON.parse(fs.readFileSync(path.join(resources, 'tester-channel.json'), 'utf8'))
        expect(channel.schemaVersion).toBe(2)
        expect(channel.requiredEntitlement).toBe('cobblepower:test')
        expect(fs.readdirSync(resources).sort()).toEqual(['distribution_bootstrap.json', 'tester-channel.json'])
        expect(rendererErrors).toEqual([])
    } finally {
        await app.close()
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
