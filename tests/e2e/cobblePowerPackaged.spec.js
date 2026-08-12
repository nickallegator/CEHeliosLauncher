const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

test('packaged Cobble Power tester contains its channel and locked mod', async () => {
    test.setTimeout(60000)
    test.skip(
        !process.env.E2E_PACKAGED_EXE,
        'Set E2E_PACKAGED_EXE to run the packaged tester smoke test.'
    )

    const executablePath = path.resolve(process.env.E2E_PACKAGED_EXE)
    const appArchive = path.join(path.dirname(executablePath), 'resources', 'app.asar')
    const packagedFiles = asar.listPackage(appArchive)
    expect(packagedFiles.some(file => /^[/\\](backend|packs|scripts|tests|patches|deps)([/\\]|$)/.test(file))).toBe(false)
    expect(packagedFiles.some(file => /(^|[/\\])\.env$/.test(file))).toBe(false)
    const useRealProfile = process.env.E2E_PACKAGED_REAL_PROFILE === '1'
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-packaged-e2e-'))
    const appDataDirectory = path.join(tempRoot, 'appdata')
    const userDataDirectory = path.join(tempRoot, 'user-data')
    fs.mkdirSync(appDataDirectory, { recursive: true })
    fs.mkdirSync(userDataDirectory, { recursive: true })
    if(process.env.E2E_PACKAGED_CONFIG){
        fs.copyFileSync(
            path.resolve(process.env.E2E_PACKAGED_CONFIG),
            path.join(userDataDirectory, 'config.json')
        )
    }

    const electronApp = await electron.launch(useRealProfile ? {
        executablePath,
        cwd: path.dirname(executablePath)
    } : {
        executablePath,
        cwd: path.dirname(executablePath),
        args: [`--user-data-dir=${userDataDirectory}`],
        env: {
            ...process.env,
            APPDATA: appDataDirectory,
            LOCALAPPDATA: path.join(tempRoot, 'local-appdata')
        }
    })

    try {
        const page = await electronApp.firstWindow()
        const rendererErrors = []
        const rendererConsole = []
        page.on('pageerror', err => rendererErrors.push(err.message))
        page.on('console', message => rendererConsole.push(`[${message.type()}] ${message.text()}`))
        await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 25000 })
        const settleTime = Number.parseInt(process.env.E2E_PACKAGED_SETTLE_MS || '0', 10)
        if(settleTime > 0){
            await page.waitForTimeout(settleTime)
        }

        const fatalOverlay = page.locator('#overlayContainer', {
            has: page.getByText('Unable to Load Distribution Index', { exact: false })
        })
        const fatalStartupError = await fatalOverlay.isVisible()
        expect(
            fatalStartupError,
            `Packaged launcher reported a fatal startup error.\n${rendererConsole.join('\n')}`
        ).toBe(false)
        await page.locator('#main').waitFor({ state: 'visible', timeout: 5000 })

        const appState = await electronApp.evaluate(({ app }) => ({
            appName: app.getName(),
            appVersion: app.getVersion()
        }))
        const distributionPath = path.join(
            path.dirname(executablePath),
            'resources',
            'tester',
            'distribution_test.json'
        )
        const distribution = JSON.parse(fs.readFileSync(distributionPath, 'utf8'))
        const profile = distribution.servers.find(server => server.id === 'Cobble-Power-1.21.1')
        const expectedDataDirectory = useRealProfile
            ? JSON.parse(fs.readFileSync(process.env.E2E_PACKAGED_CONFIG, 'utf8')).settings.launcher.dataDirectory
            : path.join(appDataDirectory, '.ag-launcher')
        const state = {
            ...appState,
            dataDirectory: expectedDataDirectory,
            profileName: profile.name,
            profileVersion: profile.version,
            modules: profile.modules.map(module => module.id)
        }

        expect(state.appName).toBe('Allegator Games Launcher')
        expect(state.appVersion).toBe('2.2.1-test.4')
        expect(state.dataDirectory).toBe(expectedDataDirectory)
        expect(state.profileName).toBe('Cobble Power Test (Minecraft 1.21.1)')
        expect(state.profileVersion).toBe('1.0.0-test.4')
        expect(state.modules).toHaveLength(20)
        expect(state.modules).toContain('net.allegator.cobblepower:cobblepower:1.0.0')

        const bundledModPath = path.join(
            state.dataDirectory,
            'common',
            'modstore',
            'net',
            'allegator',
            'cobblepower',
            'cobblepower',
            '1.0.0',
            'cobblepower-1.0.0.jar'
        )
        expect(fs.existsSync(bundledModPath)).toBe(true)
        expect(crypto.createHash('sha256').update(fs.readFileSync(bundledModPath)).digest('hex')).toBe(
            '89997fd3e8d7bc53e36fc3396892547c5e545f596ff5775274c38ccfb36231a5'
        )
        expect(rendererErrors, rendererConsole.join('\n')).toEqual([])
    } finally {
        await electronApp.close()
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
