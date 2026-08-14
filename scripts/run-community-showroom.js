'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { _electron: electron } = require('playwright')

const { createShowroomEnvironment } = require('./lib/community-showroom')

function usage() {
    return [
        'Usage: run-community-showroom.cmd [--keep-data] [--data-dir <path>] [--resources-from <path>]',
        '',
        '  --keep-data       Keep the disposable showroom directory after exit.',
        '  --data-dir <path> Use an explicit directory and never remove it automatically.',
        '  --resources-from  Read block models and textures from an existing AG Launcher game-data directory.',
        '  --verify          Open, verify the catalog, then close automatically.',
        '  --help            Show this help.'
    ].join('\n')
}

function parseArguments(argv) {
    const options = { keepData: false, dataDirectory: null, resourceDataDirectory: null, verify: false, help: false }
    for(let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if(argument === '--keep-data') options.keepData = true
        else if(argument === '--verify') options.verify = true
        else if(argument === '--help' || argument === '-h' || argument === '/?') options.help = true
        else if(argument === '--data-dir') {
            const value = argv[index + 1]
            if(!value || value.startsWith('--')) throw new Error('--data-dir requires a path.')
            options.dataDirectory = path.resolve(value)
            options.keepData = true
            index += 1
        } else if(argument === '--resources-from') {
            const value = argv[index + 1]
            if(!value || value.startsWith('--')) throw new Error('--resources-from requires a path.')
            options.resourceDataDirectory = path.resolve(value)
            index += 1
        } else throw new Error(`Unknown argument: ${argument}`)
    }
    return options
}

async function waitForApplicationClose(application) {
    await new Promise(resolve => application.once('close', resolve))
}

async function waitForAttribute(locator, name, expected, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    let value = null
    while(Date.now() < deadline) {
        value = await locator.getAttribute(name)
        if(value === expected) return value
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    const text = await locator.textContent().catch(() => '')
    throw new Error(`Timed out waiting for ${name}=${expected}; received ${value || 'unset'}. ${String(text || '').trim()}`)
}

async function closeOpenDetail(page, closeSelector, detailSelector) {
    // The custom Windows title bar can overlap the modal's visual close button
    // in automated, maximized windows. Use a clear point on the modal scrim so
    // this remains a real user event without relying on page evaluation.
    const scrim = page.locator(`${detailSelector} > .schematicsModalScrim`)
    if(await scrim.count()) await scrim.click({ position: { x: 5, y: 100 } })
    else await page.locator(closeSelector).press('Enter')
    await page.locator(detailSelector).waitFor({ state: 'hidden', timeout: 10_000 })
}

async function resetShowroomCatalog(page) {
    for(const selector of ['#communityContentDetail', '#schematicsDetail']) {
        const root = page.locator(selector)
        if(await root.getAttribute('data-open') === 'true') {
            await page.keyboard.press('Escape')
            await root.waitFor({ state: 'hidden', timeout: 10_000 })
        }
    }
    const nav = page.locator('#shellNavCommunity')
    if(await nav.getAttribute('aria-current') !== 'page') await nav.click()
    await page.locator('.schematicCard').first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function setShowroomWindowSize(application, width, height) {
    await application.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if(!window) throw new Error('The showroom window is unavailable.')
        window.setContentSize(size.width, size.height)
        window.center()
    }, { width, height })
    await new Promise(resolve => setTimeout(resolve, 180))
}

async function verifyResponsiveDetailLayout(application, page, width, height) {
    await setShowroomWindowSize(application, width, height)
    await resetShowroomCatalog(page)
    const cardPreview = page.locator('.schematicCard[data-community-key^="builder-presets:"] .schematicPreview').first()
    await cardPreview.click()
    const root = page.locator('#communityContentDetail')
    const panel = page.locator('#communityContentDetailPanel')
    const header = panel.locator('.communityDialogHeader')
    const footer = panel.locator('.communityDialogFooter')
    const media = panel.locator('.communityContentDetailMedia')
    const copy = panel.locator('.communityContentDetailCopy')
    await root.waitFor({ state: 'visible', timeout: 10_000 })
    await waitForAttribute(page.locator('#communityContentRichView'), 'data-state', 'ready')
    const [viewportBox, panelBox, headerBox, footerBox, mediaBox, copyBox] = await Promise.all([
        page.locator('html').boundingBox(), panel.boundingBox(), header.boundingBox(), footer.boundingBox(), media.boundingBox(), copy.boundingBox()
    ])
    if(!viewportBox || !panelBox || !headerBox || !footerBox || !mediaBox || !copyBox) throw new Error(`Unable to measure the ${width}x${height} Community dialog.`)
    const epsilon = 2
    if(panelBox.x < -epsilon || panelBox.y < -epsilon || panelBox.x + panelBox.width > viewportBox.width + epsilon || panelBox.y + panelBox.height > viewportBox.height + epsilon) {
        throw new Error(`Community dialog exceeds the ${width}x${height} viewport (viewport ${JSON.stringify(viewportBox)}, panel ${JSON.stringify(panelBox)}).`)
    }
    if(headerBox.y < panelBox.y - epsilon || footerBox.y + footerBox.height > panelBox.y + panelBox.height + epsilon) {
        throw new Error(`Community dialog navigation is clipped at ${width}x${height}.`)
    }
    const compact = width < 1100 || height < 640
    if(compact && mediaBox.y + mediaBox.height > copyBox.y + epsilon) throw new Error(`Compact Community detail does not stack at ${width}x${height}.`)
    if(!compact && mediaBox.x + mediaBox.width > copyBox.x + epsilon) throw new Error(`Wide Community detail does not split at ${width}x${height}.`)
    const canvas = page.locator('.communityGradientCanvas')
    const canvasBox = await canvas.boundingBox()
    const deadline = Date.now() + 10_000
    let backingWidth = 0
    while(Date.now() < deadline) {
        backingWidth = Number(await canvas.getAttribute('width')) || 0
        if(canvasBox && backingWidth >= Math.floor(canvasBox.width)) break
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    if(!canvasBox || backingWidth < Math.floor(canvasBox.width)) throw new Error(`Builder canvas backing store did not resize at ${width}x${height}.`)
    await page.keyboard.press('Escape')
    await root.waitFor({ state: 'hidden', timeout: 10_000 })
    if(await page.locator('.schematicCard:focus').count() === 0) throw new Error(`Community detail did not restore focus at ${width}x${height}.`)
}

async function run(argv = process.argv.slice(2)) {
    const options = parseArguments(argv)
    if(options.help) {
        console.log(usage())
        return 0
    }
    const appDirectory = path.resolve(__dirname, '..')
    const electronExecutable = path.join(appDirectory, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    if(!fs.existsSync(electronExecutable)) {
        throw new Error('Electron dependencies are not installed. Run npm install in the launcher repository first.')
    }
    const runtime = await createShowroomEnvironment({
        appDirectory,
        ...(options.dataDirectory ? { rootDirectory: options.dataDirectory } : {}),
        ...(options.resourceDataDirectory ? { resourceDataDirectory: options.resourceDataDirectory } : {})
    })
    let application = null
    let shuttingDown = false
    const cleanup = async () => {
        if(shuttingDown) return
        shuttingDown = true
        if(application) await application.close().catch(() => {})
        await runtime.api.close().catch(() => {})
        if(!options.keepData) fs.rmSync(runtime.rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    const handleSignal = () => {
        cleanup().then(() => { process.exitCode = 130 }).catch(error => {
            console.error(error.stack || error.message || error)
            process.exitCode = 1
        })
    }
    process.once('SIGINT', handleSignal)
    process.once('SIGTERM', handleSignal)
    try {
        console.log('AG Launcher Local Community Showroom')
        console.log(`  API:      ${runtime.apiBaseUrl}`)
        console.log(`  Data:     ${runtime.rootDirectory}`)
        console.log(`  Instance: ${runtime.instanceRoot}`)
        console.log(`  Resources:${runtime.resourceDataDirectory ? ` ${runtime.resourceDataDirectory}` : ' palette fallback'}`)
        console.log(`  Cleanup:  ${options.keepData ? 'preserved after exit' : 'automatic after exit'}`)
        console.log('  Safety:   publishing and game launch are disabled')
        console.log('')
        console.log('Close the launcher window when you are finished.')
        application = await electron.launch({
            cwd: appDirectory,
            args: ['.', `--user-data-dir=${runtime.launcherDirectory}`],
            env: runtime.environment
        })
        const page = await application.firstWindow()
        const rendererErrors = []
        page.on('pageerror', error => rendererErrors.push(error?.stack || error?.message || String(error)))
        await page.waitForLoadState('domcontentloaded')
        await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 20_000 })
        await page.locator('#shellNavCommunity').click()
        await page.locator('.schematicCard').first().waitFor({ state: 'visible', timeout: 10_000 })
        console.log(`Showroom ready with ${runtime.entries.length} representative creations.`)
        if(options.verify) {
            const builderEntry = runtime.entries.find(entry => entry.type === 'builder-presets')
            if(options.resourceDataDirectory && builderEntry?.typeData?.previewMode !== 'textures') {
                throw new Error('Builder Preset catalog preview did not resolve its Minecraft block textures.')
            }
            for(const type of ['builder-presets', 'automation']) {
                const card = page.locator(`.schematicCard[data-community-key^="${type}:"]`).first()
                await card.locator('.schematicPreview').click()
                await page.locator('#communityContentDetail').waitFor({ state: 'visible', timeout: 10_000 })
                await waitForAttribute(page.locator('#communityContentRichView'), 'data-state', 'ready')
                if(type === 'builder-presets' && options.resourceDataDirectory) {
                    await waitForAttribute(page.locator('.communityGradientCanvas'), 'data-texture-source', 'resources')
                }
                if(type === 'automation') {
                    if(!await page.locator('#communityContentTypeSidebar .communityGraphInspector').isVisible()) {
                        throw new Error('Automation node inspection was not moved into the detail sidebar.')
                    }
                    if(await page.locator('.communityAutomationBody > .communityGraphInspector').count() > 0) {
                        throw new Error('Automation preview still reserves canvas space for its node inspector.')
                    }
                    if(!await page.locator('[data-community-metadata="license"]').isHidden()
                        || !await page.locator('[data-community-metadata="dependencies"]').isVisible()) {
                        throw new Error('Automation detail metadata was not reduced to dependencies.')
                    }
                }
                await resetShowroomCatalog(page)
            }
            console.log('Verified interactive Builder Preset and Automation renderers.')
            if(options.resourceDataDirectory) console.log('Verified textured Builder Preset catalog and interactive previews.')
            if(runtime.resourceDataDirectory) {
                const schematicCard = page.locator('.schematicCard[data-community-key^="schematics:"]').first()
                await schematicCard.locator('.schematicPreview').click()
                const detailPreview = page.locator('#schematicsDetailPreview')
                await detailPreview.waitFor({ state: 'visible', timeout: 10_000 })
                await waitForAttribute(detailPreview, 'data-texture-source', 'resources')
                console.log('Verified Minecraft block models and textures from the read-only resource source.')
                await resetShowroomCatalog(page)
                for(const type of ['battle-trainers', 'resource-packs']) {
                    const card = page.locator(`.schematicCard[data-community-key^="${type}:"]`).first()
                    await card.locator('.schematicPreview').click()
                    await page.locator('#communityContentDetail').waitFor({ state: 'visible', timeout: 10_000 })
                    await waitForAttribute(page.locator('#communityContentRichView'), 'data-state', 'ready')
                    await resetShowroomCatalog(page)
                }
                console.log('Verified Trainer and Resource Pack interactive stages against local game resources.')
            }
            for(const [width, height] of [[1600, 900], [1180, 680], [980, 600]]) {
                await verifyResponsiveDetailLayout(application, page, width, height)
            }
            console.log('Verified responsive Community dialogs at large, default, and minimum launcher sizes.')
            if(rendererErrors.length > 0) throw new Error(`Renderer error during showroom verification: ${rendererErrors[0]}`)
            await application.close()
            application = null
            console.log('Showroom verification completed successfully.')
            return 0
        }
        await waitForApplicationClose(application)
        application = null
        return 0
    } finally {
        process.removeListener('SIGINT', handleSignal)
        process.removeListener('SIGTERM', handleSignal)
        await cleanup()
        if(options.keepData) console.log(`Showroom data preserved at: ${runtime.rootDirectory}`)
    }
}

if(require.main === module) {
    run().then(code => { process.exitCode = code }).catch(error => {
        console.error(`Unable to start the Community showroom: ${error.stack || error.message || error}`)
        process.exitCode = 1
    })
}

module.exports = { closeOpenDetail, parseArguments, resetShowroomCatalog, run, usage, waitForApplicationClose, waitForAttribute }
