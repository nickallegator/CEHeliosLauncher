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
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 20_000 })
    await page.locator('#shellNavCommunity').click()
    await page.locator('.schematicCard').first().waitFor({ state: 'visible', timeout: 10_000 })
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
