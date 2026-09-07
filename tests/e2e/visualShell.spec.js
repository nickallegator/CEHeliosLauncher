const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const appDir = path.resolve(__dirname, '..', '..')
const distributionPath = path.join(appDir, 'distribution_dev.json')
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

const newsFixture = {
    schemaVersion: 1,
    generatedAt: '2026-09-07T12:00:00.000Z',
    items: [
        {
            id: 'launcher:v2.10.0-test.1',
            slug: 'launcher-2-10-workshop-news',
            title: 'A new workshop for Allegator Games News',
            summary: 'Browse dispatches, release notes, and Community stories without leaving the launcher.',
            author: 'Allegator Games',
            category: 'launcher-release',
            tags: ['launcher', 'news'],
            publishedAt: '2026-09-07T12:00:00.000Z',
            updatedAt: '2026-09-07T12:00:00.000Z',
            canonicalUrl: 'https://news.allegatorgames.com/news/launcher-2-10-workshop-news/',
            heroImage: null,
            contentHtml: '<h2>Built for the workshop</h2><p>The new News workspace keeps the archive close while giving every story room to breathe.</p><ul><li>Search every dispatch.</li><li>Filter by category.</li><li>Keep reading positions during the session.</li></ul>'
        },
        {
            id: 'community:creator-spotlight',
            slug: 'creator-spotlight',
            title: 'Creator spotlight: Community builders',
            summary: 'A look at what players are making for Cobble Power.',
            author: 'Workshop Team',
            category: 'community',
            tags: ['community', 'creators'],
            publishedAt: '2026-09-06T12:00:00.000Z',
            updatedAt: '2026-09-06T12:00:00.000Z',
            canonicalUrl: 'https://news.allegatorgames.com/news/creator-spotlight/',
            heroImage: null,
            contentHtml: '<p>Community creations are arriving in the workshop.</p>'
        },
        {
            id: 'maintenance:service-window',
            slug: 'service-window',
            title: 'Planned service window',
            summary: 'A short maintenance window for the test service.',
            author: 'Allegator Games Operations',
            category: 'maintenance',
            tags: ['service'],
            publishedAt: '2026-09-05T12:00:00.000Z',
            updatedAt: '2026-09-05T12:00:00.000Z',
            canonicalUrl: 'https://news.allegatorgames.com/news/service-window/',
            heroImage: null,
            contentHtml: '<p>Installed content remains available during maintenance.</p>'
        }
    ]
}

async function startNewsFixtureServer(){
    const server = http.createServer((request, response) => {
        if(request.url === '/api/v1/news.json'){
            response.writeHead(200, { 'Content-Type': 'application/json', ETag: '"visual-news-fixture"' })
            response.end(JSON.stringify(newsFixture))
            return
        }
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('Not found')
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    return server
}

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
    const newsServer = await startNewsFixtureServer()
    const newsPort = newsServer.address().port
    const localDistributionPath = path.join(userDataDirectory, 'distribution-visual-shell.json')
    const localDistribution = JSON.parse(fs.readFileSync(distributionPath, 'utf8'))
    localDistribution.rss = `http://127.0.0.1:${newsPort}/rss.xml`
    localDistribution.news = {
        schemaVersion: 1,
        enabled: true,
        indexUrl: `http://127.0.0.1:${newsPort}/api/v1/news.json`,
        rssUrl: `http://127.0.0.1:${newsPort}/rss.xml`,
        siteUrl: 'https://news.allegatorgames.com',
        refreshSeconds: 900
    }
    fs.writeFileSync(localDistributionPath, JSON.stringify(localDistribution))
    const application = await electron.launch({
        cwd: appDir,
        args: ['.', `--user-data-dir=${userDataDirectory}`],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: localDistributionPath,
            ...(schematics ? { HELIOS_SCHEMATICS_API_URL: 'http://127.0.0.1:65534' } : {})
        }
    })
    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    return { application, page, userDataDirectory, newsServer }
}

async function closeVisualShell(application, userDataDirectory, newsServer){
    await application.close()
    await new Promise(resolve => newsServer.close(resolve))
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
    const { application, page, userDataDirectory, newsServer } = await launchVisualShell()
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
        await closeVisualShell(application, userDataDirectory, newsServer)
    }
})

test('persistent shell routes preserve Home, Community, News, Settings, and the launch dock', async () => {
    const { application, page, userDataDirectory, newsServer } = await launchVisualShell({ signedIn: true })
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
            mask: [page.locator('#player_count'), page.locator('#homeServerChecked')],
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
        await expect(page.locator('#newsArticleTitle')).toContainText('new workshop')
        await expect(page.locator('#newsArchiveList .newsArchiveItemButton')).toHaveCount(3)
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
        await closeVisualShell(application, userDataDirectory, newsServer)
    }
})

test('unified Community catalog loads directly and the compact shell fits 980 by 600', async () => {
    const { application, page, userDataDirectory, newsServer } = await launchVisualShell({ signedIn: true, schematics: true })
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
        await closeVisualShell(application, userDataDirectory, newsServer)
    }
})

test('News workspace filters, scales, and restores focus from Home', async () => {
    const { application, page, userDataDirectory, newsServer } = await launchVisualShell({ signedIn: true })
    const rendererErrors = []
    page.on('pageerror', error => rendererErrors.push(error.message))
    try {
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10000 })
        await expect(page.locator('#homeNewsList [data-news-id]')).toHaveCount(3)
        const origin = page.locator('#homeNewsList [data-news-id]').first()
        await origin.focus()
        await origin.click()
        await expect(page.locator('#newsArticleTitle')).toContainText('new workshop')

        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 900))
        const wideLayout = await page.locator('.newsEditorialFrame').boundingBox()
        expect(wideLayout.x).toBeGreaterThanOrEqual(0)
        expect(wideLayout.x + wideLayout.width).toBeLessThanOrEqual(1600)
        await expect(page.locator('#newsArchive')).toBeVisible()
        await expect(page.locator('#newsArchiveToggle')).toBeHidden()
        await expect(page.locator('#newsContainer')).toHaveScreenshot('news-workshop-wide.png', { animations: 'disabled' })

        await page.locator('#newsSearchInput').fill('creator builders')
        await expect(page.locator('#newsArchiveList .newsArchiveItemButton')).toHaveCount(1)
        await expect(page.locator('#newsArticleTitle')).toContainText('Creator spotlight')
        await page.locator('#newsSearchInput').fill('')
        await page.locator('[data-news-category="maintenance"]').click()
        await expect(page.locator('#newsArticleTitle')).toContainText('Planned service window')

        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 600))
        await expect(page.locator('#newsArchive')).toBeVisible()
        await expect(page.locator('#newsContainer')).toHaveScreenshot('news-workshop-minimum.png', { animations: 'disabled' })

        await application.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            window.setMinimumSize(760, 560)
            window.setSize(800, 600)
        })
        await expect(page.locator('#newsArchiveToggle')).toBeVisible()
        await page.locator('#newsArchiveToggle').click()
        await expect(page.locator('#newsArchive')).toHaveAttribute('data-open', 'true')
        await expect(page.locator('#newsContainer')).toHaveScreenshot('news-workshop-drawer.png', { animations: 'disabled' })
        await page.keyboard.press('Escape')
        await expect(page.locator('#newsArchive')).toHaveAttribute('data-open', 'false')

        await page.locator('#shellNavHome').click()
        await expect(page.locator('#upper')).toBeVisible()
        await expect(origin).toBeFocused()
        expect(rendererErrors).toEqual([])
    } finally {
        await closeVisualShell(application, userDataDirectory, newsServer)
    }
})
