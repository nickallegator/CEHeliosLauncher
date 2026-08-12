const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const asar = require('@electron/asar')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('packaged Windows launcher contains and boots the Allegator workshop shell', async () => {
    test.skip(!process.env.E2E_VISUAL_SHELL_EXE, 'Set E2E_VISUAL_SHELL_EXE to run the packaged visual-shell smoke test.')
    const executablePath = path.resolve(process.env.E2E_VISUAL_SHELL_EXE)
    const applicationDirectory = path.dirname(executablePath)
    const archivePath = path.join(applicationDirectory, 'resources', 'app.asar')
    const packagedFiles = asar.listPackage(archivePath).map(file => file.replaceAll('\\', '/'))
    const expectedAssets = [
        '/app/assets/brand/allegator-games-intro.svg',
        '/app/assets/brand/allegator-games-loading-chomp.svg',
        '/app/assets/brand/allegator-games-logo.svg',
        '/app/assets/brand/allegator-games-app-icon.png',
        '/app/assets/brand/allegator-icons.svg',
        '/app/assets/fonts/PixelifySans-Variable.ttf',
        '/app/assets/fonts/AtkinsonHyperlegible-Regular.ttf',
        '/app/assets/fonts/AtkinsonHyperlegible-Bold.ttf'
    ]
    expectedAssets.forEach(asset => expect(packagedFiles).toContain(asset))
    expect(packagedFiles).not.toContain('/app/assets/brand/allegator-games-mark.svg')
    expect(packagedFiles.some(file => /\/build\/branding\//.test(file))).toBe(false)
    expect(packagedFiles.some(file => /\/app\/assets\/images\/backgrounds\//.test(file))).toBe(false)
    expect(packagedFiles.some(file => /\/app\/assets\/images\/(LoadingSeal|LoadingText)\.png$/.test(file))).toBe(false)

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-visual-package-'))
    const userDataDirectory = path.join(temporaryRoot, 'user-data')
    fs.mkdirSync(userDataDirectory, { recursive: true })
    const application = await electron.launch({
        executablePath,
        cwd: applicationDirectory,
        args: [`--user-data-dir=${userDataDirectory}`],
        env: {
            ...process.env,
            ELECTRON_IS_DEV: '1',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: path.resolve(__dirname, '..', '..', 'distribution_dev.json'),
            APPDATA: path.join(temporaryRoot, 'appdata'),
            LOCALAPPDATA: path.join(temporaryRoot, 'local-appdata')
        }
    })

    try {
        const page = await application.firstWindow()
        const rendererErrors = []
        page.on('pageerror', error => rendererErrors.push(error.message))
        await expect(page.locator('#startupIntroImage')).toBeVisible({ timeout: 10000 })
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 15000 })
        await expect(page.locator('#welcomeContainer')).toBeVisible()
        const bounds = await application.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            return { size: window.getSize(), minimum: window.getMinimumSize() }
        })
        expect(bounds.size).toEqual([1180, 680])
        expect(bounds.minimum).toEqual([980, 600])
        expect(rendererErrors).toEqual([])
    } finally {
        await application.close()
        fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
