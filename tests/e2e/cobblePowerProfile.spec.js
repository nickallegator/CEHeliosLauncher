const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('launcher loads the locked Cobble Power development profile', async () => {
    const appDir = path.resolve(__dirname, '..', '..')
    const distributionPath = path.join(appDir, 'distribution_dev.json')
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-e2e-'))
    const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep
    const resolvedUserData = path.resolve(userDataDir)
    if(!resolvedUserData.startsWith(resolvedTempRoot) || !path.basename(resolvedUserData).startsWith('cehelios-e2e-')){
        throw new Error(`Unexpected E2E directory: ${resolvedUserData}`)
    }
    const electronApp = await electron.launch({
        cwd: appDir,
        args: ['.', `--user-data-dir=${userDataDir}`],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: distributionPath
        }
    })

    try {
        const page = await electronApp.firstWindow()
        const rendererErrors = []
        page.on('pageerror', err => rendererErrors.push(err.message))

        await page.waitForLoadState('domcontentloaded')
        await expect(page.locator('#main')).toBeVisible({ timeout: 15000 })
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 15000 })

        const profile = await electronApp.evaluate(async ({ app }, devDistributionPath) => {
            const fs = process.getBuiltinModule('fs')
            const distribution = JSON.parse(fs.readFileSync(devDistributionPath, 'utf8'))
            const server = distribution.servers.find((candidate) => candidate.id === 'Cobble-Power-1.21.1')
            return server ? {
                appPath: app.getAppPath(),
                id: server.id,
                java: server.javaOptions,
                minecraftVersion: server.minecraftVersion,
                moduleCount: server.modules.length,
                optionalDefaults: server.modules
                    .filter((module) => module.required?.value === false)
                    .map((module) => module.required.def)
            } : null
        }, distributionPath)

        expect(profile).not.toBeNull()
        expect(path.resolve(profile.appPath)).toBe(appDir)
        expect(profile.id).toBe('Cobble-Power-1.21.1')
        expect(profile.minecraftVersion).toBe('1.21.1')
        expect(profile.java.supported).toBe('21.x')
        expect(profile.java.suggestedMajor).toBe(21)
        expect(profile.moduleCount).toBe(19)
        expect(profile.optionalDefaults).toEqual([true, true, true, true])

        expect(rendererErrors).toEqual([])
    } finally {
        await electronApp.close()
        fs.rmSync(resolvedUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
