'use strict'

const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')

const {
    ITEM_IDS,
    SHOWROOM_PLAYER_UUID,
    createRgbaPng,
    createShowroomEnvironment
} = require('../../scripts/lib/community-showroom')

const appDirectory = path.resolve(__dirname, '..', '..')

test('local showroom browses and installs every representative content type', async () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-showroom-e2e-'))
    const resourceDataDirectory = createMinecraftResourceFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-resources-e2e-')))
    const runtime = await createShowroomEnvironment({ appDirectory, rootDirectory, resourceDataDirectory })
    const application = await electron.launch({
        cwd: appDirectory,
        args: ['.', `--user-data-dir=${runtime.launcherDirectory}`],
        env: runtime.environment
    })
    const rendererErrors = []
    try {
        const page = await application.firstWindow()
        page.on('pageerror', error => rendererErrors.push(error?.message || String(error)))
        await page.waitForLoadState('domcontentloaded')
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10_000 })
        await page.locator('#shellNavCommunity').click()
        await expect(page.locator('.schematicCard')).toHaveCount(5)
        await expect(page.locator('#launch_button')).toBeDisabled()
        await expect(page.locator('#launch_button')).toContainText('SHOWROOM')

        const schematicKey = `schematics:${ITEM_IDS.schematics}`
        const schematicCard = page.locator(`.schematicCard[data-community-key="${schematicKey}"]`)
        await expect(schematicCard.locator('.schematicPreviewImage')).toBeVisible()
        await schematicCard.locator('.schematicPreview').click()
        await expect(page.locator('#schematicsDetail')).toHaveAttribute('aria-hidden', 'false')
        await expect(page.locator('#schematicsDetailCanvas')).toBeVisible()
        await expect(page.locator('#schematicsDetailPreview')).toHaveAttribute('data-preview-state', 'ready', { timeout: 20_000 })
        await expect(page.locator('#schematicsDetailPreview')).toHaveAttribute('data-preview-vertices', /^[1-9]\d*$/)
        await expect(page.locator('#schematicsDetailPreview')).toHaveAttribute('data-texture-source', 'resources')
        await expect(page.locator('#schematicsDetailPreview')).toHaveAttribute('data-textures-resolved', /^[1-9]\d*$/)
        await expect(page.locator('#schematicsDetailBlocksTotal')).not.toHaveText('--')
        await page.locator('#schematicsDetailInstall').click()
        await expect(page.locator('#schematicsDetailInstall')).toHaveText('Installed', { timeout: 10_000 })
        await expect(page.locator('#schematicsDetail')).toHaveAttribute('aria-hidden', 'true')

        for(const type of ['automation', 'builder-presets', 'resource-packs', 'battle-trainers']) {
            const key = `${type}:${ITEM_IDS[type]}`
            await page.locator(`.schematicCard[data-community-key="${key}"]`).click()
            await expect(page.locator('#communityContentDetail')).toHaveAttribute('aria-hidden', 'false')
            await expect(page.locator('#communityContentDetailStatus')).toHaveText('Install')
            if(type === 'resource-packs') {
                const previewStatus = page.locator('.communityResourcePackView .communityRichNote')
                await expect(previewStatus).toHaveText('Drag to rotate · wheel to zoom', { timeout: 20_000 })
                await expect(page.locator('.communityPackStage canvas')).toHaveAttribute('data-texture-source', 'resources')
                await expect(page.locator('.communityPackStage canvas')).toHaveAttribute('data-camera-target', '0.5000,0.5000,0.5000')
                await expect(page.locator('[data-community-metadata="dependencies"]')).toBeVisible()
                for(const field of ['license', 'rights', 'revision', 'compatibility']) {
                    await expect(page.locator(`[data-community-metadata="${field}"]`)).toBeHidden()
                }
                const search = page.locator('.communityPackResourceSearch')
                await expect(search).toBeVisible()
                await expect(page.locator('.communityPackResourceItem')).toHaveCount(2)
                await search.fill('pikachu')
                await expect(page.locator('.communityPackResourceItem')).toHaveCount(1)
                await page.locator('.communityPackResourceItem').click()
                await expect(previewStatus).toHaveText('Drag to rotate · wheel to zoom', { timeout: 20_000 })
                await page.locator('.communityPackModeControl button[data-mode="compare"]').click()
                await expect(page.locator('.communityPackComparisonPane')).toHaveCount(2)
                const comparisonCanvases = page.locator('.communityPackComparisonPane canvas')
                await expect(comparisonCanvases).toHaveCount(2, { timeout: 20_000 })
                await expect(page.locator('.communityPackPaneStatus:visible')).toHaveCount(0)
                await expect(page.getByText('Drag to rotate · wheel to zoom', { exact: true })).toHaveCount(1)
                const firstYaw = await comparisonCanvases.nth(0).getAttribute('data-camera-yaw')
                const secondYaw = await comparisonCanvases.nth(1).getAttribute('data-camera-yaw')
                const bounds = await comparisonCanvases.nth(0).boundingBox()
                expect(bounds).not.toBeNull()
                await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
                await page.mouse.down()
                await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height / 2)
                await page.mouse.up()
                await expect(comparisonCanvases.nth(0)).not.toHaveAttribute('data-camera-yaw', firstYaw)
                await expect(comparisonCanvases.nth(1)).toHaveAttribute('data-camera-yaw', secondYaw)
                await page.locator('.communityPackModeControl button[data-mode="base"]').click()
                await expect(previewStatus).toHaveText('Drag to rotate · wheel to zoom', { timeout: 20_000 })
            }
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
        expect(rendererErrors).toEqual([])
    } finally {
        await application.close().catch(() => {})
        await runtime.api.close().catch(() => {})
        fs.rmSync(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        fs.rmSync(resourceDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})

function assertFiles(directory, count) {
    expect(fs.existsSync(directory)).toBe(true)
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.json'))).toHaveLength(count)
}

function createMinecraftResourceFixture(dataDirectory) {
    const profileDirectory = path.join(dataDirectory, 'instances', 'Cobble-Power-1.21.1')
    const jarPath = path.join(dataDirectory, 'common', 'versions', '1.21.1', '1.21.1.jar')
    fs.mkdirSync(path.join(profileDirectory, 'resourcepacks'), { recursive: true })
    fs.mkdirSync(path.dirname(jarPath), { recursive: true })
    const cobblemonVersion = '1.6.0+1.21.1-HEAD-f77af7c'
    const cobblemonCoordinate = `com.cobblemon:neoforge:${cobblemonVersion}`
    const cobblemonJarPath = path.join(dataDirectory, 'common', 'modstore', 'com', 'cobblemon', 'neoforge', cobblemonVersion, `neoforge-${cobblemonVersion}.jar`)
    fs.writeFileSync(path.join(profileDirectory, 'forgeMods.list'), `${cobblemonCoordinate}\n`)

    const zip = new AdmZip()
    const json = value => Buffer.from(JSON.stringify(value), 'utf8')
    const texture = fs.readFileSync(path.join(appDirectory, 'app', 'assets', 'brand', 'allegator-games-app-icon.png'))
    const faces = Object.fromEntries(['north', 'south', 'west', 'east', 'up', 'down'].map(face => [face, { texture: '#all' }]))
    zip.addFile('assets/minecraft/models/block/cube_all.json', json({
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }]
    }))
    for(const block of ['deepslate_tiles', 'stripped_spruce_log', 'spruce_planks', 'cut_copper', 'oxidized_cut_copper', 'glass', 'lantern']) {
        zip.addFile(`assets/minecraft/blockstates/${block}.json`, json({ variants: { '': { model: `minecraft:block/${block}` } } }))
        zip.addFile(`assets/minecraft/models/block/${block}.json`, json({
            parent: 'minecraft:block/cube_all',
            textures: { all: `minecraft:block/${block}` }
        }))
        zip.addFile(`assets/minecraft/textures/block/${block}.png`, texture)
    }
    zip.writeZip(jarPath)
    fs.mkdirSync(path.dirname(cobblemonJarPath), { recursive: true })
    const cobblemon = new AdmZip()
    cobblemon.addFile('assets/cobblemon/bedrock/pokemon/resolvers/0025_pikachu/0_pikachu_base.json', json({
        species: 'cobblemon:pikachu', order: 0,
        variations: [{ aspects: [], model: 'cobblemon:pikachu_male.geo', texture: 'cobblemon:textures/pokemon/0025_pikachu/pikachu.png' }]
    }))
    cobblemon.addFile('assets/cobblemon/bedrock/pokemon/models/0025_pikachu/pikachu_male.geo.json', json({
        format_version: '1.12.0',
        'minecraft:geometry': [{
            description: { identifier: 'geometry.pikachu', texture_width: 64, texture_height: 64 },
            bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }]
        }]
    }))
    cobblemon.addFile('assets/cobblemon/textures/pokemon/0025_pikachu/pikachu.png', createRgbaPng(64, 64, (x, y) => [
        224 + ((x + y) % 16), 180 + ((x * 3 + y) % 20), 28, 255
    ]))
    cobblemon.writeZip(cobblemonJarPath)
    return dataDirectory
}
