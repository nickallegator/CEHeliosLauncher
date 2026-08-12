'use strict'

const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
    ITEM_IDS,
    SHOWROOM_PLAYER_UUID,
    createShowroomEnvironment
} = require('../../scripts/lib/community-showroom')

const appDirectory = path.resolve(__dirname, '..', '..')

test('local showroom browses and installs every representative content type', async () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-showroom-e2e-'))
    const runtime = await createShowroomEnvironment({ appDirectory, rootDirectory })
    const application = await electron.launch({
        cwd: appDirectory,
        args: ['.', `--user-data-dir=${runtime.launcherDirectory}`],
        env: runtime.environment
    })
    try {
        const page = await application.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10_000 })
        await page.locator('#shellNavCommunity').click()
        await expect(page.locator('.schematicCard')).toHaveCount(5)
        await expect(page.locator('#launch_button')).toBeDisabled()
        await expect(page.locator('#launch_button')).toContainText('SHOWROOM')

        const schematicKey = `schematics:${ITEM_IDS.schematics}`
        const schematicCard = page.locator(`.schematicCard[data-community-key="${schematicKey}"]`)
        await expect(schematicCard.locator('.schematicPreview svg')).toBeVisible()
        await schematicCard.locator('.schematicPreview').click()
        await expect(page.locator('#schematicsDetail')).toHaveAttribute('aria-hidden', 'false')
        await expect(page.locator('#schematicsDetailCanvas')).toBeVisible()
        await expect(page.locator('#schematicsDetailPreview')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 })
        await expect(page.locator('#schematicsDetailBlocksTotal')).not.toHaveText('--')
        await page.locator('#schematicsDetailInstall').click()
        await expect(page.locator('#schematicsDetailInstall')).toHaveText('Installed', { timeout: 10_000 })
        await expect(page.locator('#schematicsDetail')).toHaveAttribute('aria-hidden', 'true')

        for(const type of ['automation', 'builder-presets', 'resource-packs', 'battle-trainers']) {
            const key = `${type}:${ITEM_IDS[type]}`
            await page.locator(`.schematicCard[data-community-key="${key}"]`).click()
            await expect(page.locator('#communityContentDetail')).toHaveAttribute('aria-hidden', 'false')
            await expect(page.locator('#communityContentDetailStatus')).toHaveText('Install')
            await page.locator('#communityContentInstall').click()
            await expect(page.locator('#communityContentDetailStatus')).toHaveText('Installed', { timeout: 10_000 })
            await page.locator('#communityContentDetailClose').click()
        }

        const owner = `${SHOWROOM_PLAYER_UUID.slice(0, 8)}-${SHOWROOM_PLAYER_UUID.slice(8, 12)}-${SHOWROOM_PLAYER_UUID.slice(12, 16)}-${SHOWROOM_PLAYER_UUID.slice(16, 20)}-${SHOWROOM_PLAYER_UUID.slice(20)}`
        const operationsDirectory = path.join(runtime.instanceRoot, 'config', 'cobblepower', 'operations', owner)
        const trainersDirectory = path.join(runtime.instanceRoot, 'config', 'cobblepower', 'trainers', owner)
        const schematicsDirectory = path.join(runtime.instanceRoot, 'config', 'cobblepower', 'schematics', owner)
        assertFiles(schematicsDirectory, 1)
        assertFiles(operationsDirectory, 2)
        assertFiles(trainersDirectory, 1)
        expect(fs.existsSync(path.join(runtime.instanceRoot, 'config', 'cobblepower', 'gradients', `ag-community-${ITEM_IDS['builder-presets']}.json`))).toBe(true)
        expect(fs.existsSync(path.join(runtime.instanceRoot, 'resourcepacks', `ag-community-${ITEM_IDS['resource-packs']}.zip`))).toBe(true)
        expect(fs.readFileSync(path.join(runtime.instanceRoot, 'options.txt'), 'utf8')).toContain(`file/ag-community-${ITEM_IDS['resource-packs']}.zip`)
    } finally {
        await application.close().catch(() => {})
        await runtime.api.close().catch(() => {})
        fs.rmSync(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})

function assertFiles(directory, count) {
    expect(fs.existsSync(directory)).toBe(true)
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.json'))).toHaveLength(count)
}
