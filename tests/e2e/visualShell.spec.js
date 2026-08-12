const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appDir = path.resolve(__dirname, '..', '..')
const distributionPath = path.join(appDir, 'distribution_dev.json')
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

function createTestDirectory(prefix){
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const safeRoot = path.resolve(os.tmpdir()) + path.sep
    if(!path.resolve(directory).startsWith(safeRoot) || !path.basename(directory).startsWith(prefix)){
        throw new Error(`Unexpected E2E directory: ${directory}`)
    }
    return directory
}

function writeSignedInConfig(userDataDirectory){
    const uuid = '12345678123412341234123456789abc'
    fs.writeFileSync(path.join(userDataDirectory, 'config.json'), JSON.stringify({
        selectedServer: 'Cobble-Power-1.21.1',
        selectedAccount: uuid,
        authenticationDatabase: {
            [uuid]: {
                type: 'microsoft',
                accessToken: 'visual-shell-test-token',
                username: 'Workshop Tester',
                uuid,
                displayName: 'Workshop Tester',
                expiresAt: Date.now() + 3_600_000,
                microsoft: {
                    access_token: 'visual-shell-ms-token',
                    refresh_token: 'visual-shell-refresh-token',
                    expires_at: Date.now() + 3_600_000
                }
            }
        }
    }))
}

async function launchVisualShell({ signedIn = false, schematics = false } = {}){
    const userDataDirectory = createTestDirectory('cehelios-visual-shell-')
    if(signedIn) writeSignedInConfig(userDataDirectory)
    const application = await electron.launch({
        cwd: appDir,
        args: ['.', `--user-data-dir=${userDataDirectory}`],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: distributionPath,
            ...(schematics ? { HELIOS_SCHEMATICS_API_URL: 'http://127.0.0.1:65534' } : {})
        }
    })
    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    return { application, page, userDataDirectory }
}

async function closeVisualShell(application, userDataDirectory){
    await application.close()
    fs.rmSync(userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function expectNoSeriousAccessibilityViolations(application, page, selector){
    const session = await application.context().newCDPSession(page)
    await session.send('Runtime.enable')
    await session.send('Runtime.evaluate', { expression: axeSource })
    const evaluation = await session.send('Runtime.evaluate', {
        expression: `(async () => {
            const results = await axe.run(document.querySelector(${JSON.stringify(selector)}))
            return results.violations.map(({ id, impact, help, nodes }) => ({
                id,
                impact,
                help,
                targets: nodes.map(node => node.target)
            }))
        })()`,
        awaitPromise: true,
        returnByValue: true
    })
    await session.detach()
    expect(evaluation.exceptionDetails).toBeUndefined()
    const violations = evaluation.result.value
    const blocking = violations.filter(violation => ['serious', 'critical'].includes(violation.impact))
    expect(blocking, blocking.map(violation => `${violation.id}: ${violation.help}`).join('\n')).toEqual([])
}

test('Allegator intro is local, becomes skippable, and yields to signed-out authentication', async () => {
    const { application, page, userDataDirectory } = await launchVisualShell()
    try {
        await expect(page.locator('#startupIntroImage')).toBeVisible()
        await expect(page.locator('#startupSkip')).toBeVisible({ timeout: 1500 })
        await page.locator('#startupSkip').click()
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10000 })
        await expect(page.locator('#welcomeContainer')).toBeVisible()
        await expect(page.locator('#appShell')).toBeHidden()
        await expectNoSeriousAccessibilityViolations(application, page, '#welcomeContainer')
        await expect(page.locator('#welcomeContainer')).toHaveScreenshot('welcome-workshop.png', { animations: 'disabled' })
    } finally {
        await closeVisualShell(application, userDataDirectory)
    }
})

test('persistent shell routes preserve Home, Community, News, Settings, and the launch dock', async () => {
    const { application, page, userDataDirectory } = await launchVisualShell({ signedIn: true })
    const rendererErrors = []
    page.on('pageerror', error => rendererErrors.push(error.message))
    try {
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10000 })
        await expect(page.locator('#appShell')).toBeVisible()
        await expect(page.locator('#upper')).toBeVisible()
        await expect(page.locator('#lower')).toBeVisible()
        await expect(page.locator('#shellNavHome')).toHaveAttribute('aria-current', 'page')
        await expectNoSeriousAccessibilityViolations(application, page, '#appShell')
        await expect(page.locator('#appShell')).toHaveScreenshot('home-workshop.png', {
            animations: 'disabled',
            mask: [page.locator('#player_count')],
            maskColor: '#15211f'
        })

        await page.locator('#shellNavCommunity').click()
        await expect(page.locator('#schematicsContainer')).toBeVisible({ timeout: 10000 })
        await expect(page.locator('[data-community-category="all"]')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('[data-community-category="schematics"]')).toBeVisible()
        await expect(page.locator('#schematicsCategorySelect')).toHaveCount(0)
        await expect(page.locator('[data-community-deferred="collections"]:visible')).toHaveCount(0)
        await expect(page.locator('#lower')).toBeVisible()
        await expectNoSeriousAccessibilityViolations(application, page, '#appShell')
        await expect(page.locator('#appShellViewport')).toHaveScreenshot('community-empty-workshop.png', { animations: 'disabled' })

        await page.locator('#shellNavNews').click()
        await expect(page.locator('#newsContainer')).toBeVisible()
        await expect(page.locator('#shellNavNews')).toHaveAttribute('aria-current', 'page')
        await expectNoSeriousAccessibilityViolations(application, page, '#appShell')

        await page.locator('#settingsMediaButton').click()
        await expect(page.locator('#settingsContainer')).toBeVisible()
        await expect(page.locator('#settingsMediaButton')).toHaveAttribute('aria-current', 'page')
        await page.locator('[rSc="settingsTabMods"]').click()
        await expect(page.locator('#settingsTabMods')).toBeVisible()
        await expect(page.locator('.settingsSelServContent .serverListingImg').first()).toHaveAttribute(
            'src',
            'assets/brand/allegator-games-app-icon.png'
        )
        await page.locator('#settingsTabMods .settingsSwitchServerButton').click({ force: true })
        await expect(page.locator('#serverSelectContent')).toBeVisible()
        await expect(page.locator('#serverSelectListScrollable [servid="Cobble-Power-1.21.1"] .serverListingImg')).toHaveAttribute(
            'src',
            'assets/brand/allegator-games-app-icon.png'
        )
        await page.locator('#serverSelectCancel').click()
        await expectNoSeriousAccessibilityViolations(application, page, '#appShell')

        await page.locator('#shellNavHome').click()
        await expect(page.locator('#upper')).toBeVisible()
        await expect(page.locator('#homeProfileName')).toContainText('Cobble Power')
        expect(rendererErrors).toEqual([])
    } finally {
        await closeVisualShell(application, userDataDirectory)
    }
})

test('unified Community catalog loads directly and the compact shell fits 980 by 600', async () => {
    const { application, page, userDataDirectory } = await launchVisualShell({ signedIn: true, schematics: true })
    try {
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10000 })
        await application.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setSize(980, 600)
        })
        await expect(page.locator('#shellNavHome')).toBeVisible()
        await expect(page.locator('#shellNavHome .shellNavLabel')).toBeHidden()
        await expect(page.locator('#lower')).toBeVisible()

        await page.locator('#shellNavCommunity').click()
        await expect(page.locator('#schematicsContainer')).toBeVisible({ timeout: 10000 })
        await expect(page.locator('[data-community-category="all"]')).toHaveAttribute('aria-pressed', 'true')
        await page.locator('[data-community-category="schematics"]').click()
        await expect(page.locator('[data-community-category="schematics"]')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('#schematicsTypeManageControls')).toBeVisible()
        await expect(page.locator('#lower')).toBeVisible()
    } finally {
        await closeVisualShell(application, userDataDirectory)
    }
})
