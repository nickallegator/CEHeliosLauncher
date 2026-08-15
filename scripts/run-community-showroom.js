'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { _electron: electron } = require('playwright')

const { createShowroomEnvironment } = require('./lib/community-showroom')

function usage() {
    return [
        'Usage: run-community-showroom.cmd [--keep-data] [--data-dir <path>] [--resources-from <path>] [--showcase-pack <zip>]',
        '',
        '  --keep-data       Keep the disposable showroom directory after exit.',
        '  --data-dir <path> Use an explicit directory and never remove it automatically.',
        '  --resources-from  Read block models and textures from an existing AG Launcher game-data directory.',
        '  --showcase-pack   Preview an external Resource Pack ZIP as the showroom Resource Pack entry.',
        '  --verify          Open, verify the catalog, then close automatically.',
        '  --help            Show this help.'
    ].join('\n')
}

function parseArguments(argv) {
    const options = { keepData: false, dataDirectory: null, resourceDataDirectory: null, showcasePackPath: null, verify: false, help: false }
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
        } else if(argument === '--showcase-pack') {
            const value = argv[index + 1]
            if(!value || value.startsWith('--')) throw new Error('--showcase-pack requires a ZIP path.')
            options.showcasePackPath = path.resolve(value)
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

async function waitForText(locator, pattern, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    let value = ''
    while(Date.now() < deadline) {
        value = String(await locator.textContent().catch(() => '') || '').trim()
        if(pattern.test(value)) return value
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${pattern}; received ${value || 'empty text'}.`)
}

async function waitForPackStudioCanvas(page, timeoutMs = 20_000) {
    const canvas = page.locator('#communityPackStudioPreviewHost canvas')
    const status = page.locator('#communityPackStudioPreviewHost .communityRichNote')
    const deadline = Date.now() + timeoutMs
    while(Date.now() < deadline) {
        if(await canvas.isVisible().catch(() => false)) return canvas
        if(await status.getAttribute('data-state').catch(() => null) === 'fallback') {
            throw new Error(String(await status.textContent() || 'Pack Studio model preview failed.').trim())
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for the Pack Studio model preview canvas.')
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
    // Windows content bounds can round by up to three CSS pixels while the
    // custom frame transitions between display scales.
    const epsilon = 4
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
        ...(options.resourceDataDirectory ? { resourceDataDirectory: options.resourceDataDirectory } : {}),
        ...(options.showcasePackPath ? { showcasePackPath: options.showcasePackPath } : {})
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
        if(runtime.showcasePackPath) console.log(`  Pack:      ${runtime.showcasePackPath}`)
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
                    if(type === 'resource-packs') {
                        const externalPack = Boolean(runtime.showcasePackPath)
                        const resources = page.locator('.communityPackResourceItem')
                        const resourceCount = await resources.count()
                        if((externalPack && resourceCount < 3) || (!externalPack && resourceCount !== 2)) throw new Error('Resource Pack showroom is missing its expected renderable resources.')
                        if(!await page.locator('[data-community-metadata="dependencies"]').isVisible()) throw new Error('Resource Pack dependencies are not visible.')
                        for(const metadata of ['license', 'rights', 'revision', 'compatibility']) {
                            if(await page.locator(`[data-community-metadata="${metadata}"]`).isVisible()) throw new Error(`Resource Pack ${metadata} metadata should be hidden.`)
                        }
                        const search = page.locator('.communityPackResourceSearch')
                        if(!externalPack){
                            await resources.nth(0).click()
                            await waitForText(page.locator('.communityResourcePackView .communityRichNote'), /^Drag to rotate · wheel to zoom$/)
                            await waitForAttribute(page.locator('.communityPackStage canvas'), 'data-texture-source', 'resources')
                            await waitForAttribute(page.locator('.communityPackStage canvas'), 'data-camera-target', '0.5000,0.5000,0.5000')
                        }
                        if(externalPack) {
                            await search.fill('aggron')
                            const aggronResource = page.locator('.communityPackResourceItem').first()
                            if(await aggronResource.count() !== 1) throw new Error('Partial Aggron override is missing from the Resource Pack resource browser.')
                            await waitForText(aggronResource.locator('.communityPackResourceScope'), /^Partial$/)
                            await aggronResource.click()
                            await page.locator('.communityPackStage canvas').waitFor({ state: 'visible', timeout: 20_000 })
                        }
                        await search.fill(externalPack ? 'cosmog' : 'pikachu')
                        const pokemonMatches = page.locator('.communityPackResourceItem')
                        if(await pokemonMatches.count() < 1) throw new Error('Resource Pack resource search did not filter the list.')
                        await pokemonMatches.first().click()
                        await waitForText(page.locator('.communityResourcePackView .communityRichNote'), /^Drag to rotate · wheel to zoom$/)
                        const pokemonCanvas = page.locator('.communityPackStage canvas')
                        await pokemonCanvas.waitFor({ state: 'visible', timeout: 10_000 })
                        if(externalPack) {
                            const controls = page.locator('.communityPackAnimationTools')
                            await controls.waitFor({ state: 'visible', timeout: 10_000 })
                            await waitForAttribute(pokemonCanvas, 'data-animation-id', 'ground_idle')
                            const firstFrame = Number(await pokemonCanvas.getAttribute('data-animation-frame'))
                            await new Promise(resolve => setTimeout(resolve, 250))
                            const laterFrame = Number(await pokemonCanvas.getAttribute('data-animation-frame'))
                            if(laterFrame <= firstFrame) throw new Error('The default Pokémon idle animation did not advance.')
                            await page.locator('.communityPackAnimationTools select').selectOption('ground_walk')
                            await waitForAttribute(pokemonCanvas, 'data-animation-id', 'ground_walk')
                            await page.locator('.communityPackAnimationTools [data-action="animation-playback"]').click()
                            await waitForAttribute(pokemonCanvas, 'data-animation-playing', 'false')
                        }
                        await page.locator('.communityPackModeControl button[data-mode="compare"]').click()
                        const comparisonCanvases = page.locator('.communityPackComparisonPane canvas')
                        await page.locator('.communityPackComparisonPane[data-mode="pack"] canvas').waitFor({ state: 'visible', timeout: 20_000 })
                        if(externalPack){
                            if(await page.locator('.communityPackComparisonPane[data-mode="base"] canvas').count() !== 0) throw new Error('The external-only Cosmog model unexpectedly resolved from base Cobblemon resources.')
                            if(!await page.locator('.communityPackComparisonPane[data-mode="base"] .communityPackPaneStatus').isVisible()) throw new Error('The Base comparison did not explain its missing external model.')
                        } else {
                            if(await comparisonCanvases.count() !== 2) throw new Error('Resource Pack comparison did not create independent Base and Pack views.')
                            if(await page.locator('.communityPackPaneStatus:visible').count() !== 0) throw new Error('Resource Pack comparison duplicated its interaction guidance.')
                            await page.locator('.communityPackModeControl button[data-mode="base"]').click()
                            await waitForText(page.locator('.communityResourcePackView .communityRichNote'), /^Drag to rotate · wheel to zoom$/)
                        }
                    }
                    await resetShowroomCatalog(page)
                }
                console.log('Verified Trainer and Resource Pack interactive stages against local game resources.')
            }
            await resetShowroomCatalog(page)
            const studioButton = page.locator('#communityPackStudioOpen')
            await studioButton.waitFor({ state: 'visible', timeout: 10_000 })
            await studioButton.click()
            const studio = page.locator('#communityPackStudio')
            await studio.waitFor({ state: 'visible', timeout: 10_000 })
            const blockComponent = page.locator('.communityPackStudioComponent[data-kind="block"]').first()
            const resourcePackEntry = runtime.entries.find(entry => entry.type === 'resource-packs')
            const hasBarbaracle = resourcePackEntry?.compositionIndex?.components?.some(component => component.key === 'pokemon:cobblemon:barbaracle')
            const hasAggron = resourcePackEntry?.compositionIndex?.components?.some(component => component.key === 'pokemon:cobblemon:aggron')
            if(runtime.showcasePackPath) {
                const components = resourcePackEntry?.compositionIndex?.components || []
                for(const species of ['darumaka', 'darmanitan', 'gliscor', 'unown', 'boltund']) {
                    const component = components.find(value => value.key === `pokemon:cobblemon:${species}`)
                    if(!component) throw new Error(`Hydro Pack Studio index is missing ${species}.`)
                    if(['gliscor', 'unown', 'boltund'].includes(species) && component.metadata?.pokemonOverride?.scope !== 'partial') {
                        throw new Error(`Hydro ${species} entry is not tagged as a partial PokÃ©mon override.`)
                    }
                }
                for(const species of ['darumaka', 'darmanitan']) {
                    const component = components.find(value => value.key === `pokemon:cobblemon:${species}`)
                    if(!component.metadata?.pokemonVariants?.some(variant => variant.aspects?.includes('galarian'))) {
                        throw new Error(`Hydro ${species} entry is missing its Galarian display variant.`)
                    }
                }
            }
            const studioSearch = page.locator('#communityPackStudioSearch')
            if(hasBarbaracle) {
                await studioSearch.fill('barbaracle')
                await page.locator('.communityPackStudioComponent[data-kind="pokemon"]').first().waitFor({ state: 'visible', timeout: 10_000 })
                await waitForText(page.locator('.communityPackStudioComponent[data-kind="pokemon"] strong').first(), /^Barbaracle$/)
                await waitForText(page.locator('.communityPackStudioComponent[data-kind="pokemon"] .communityPackStudioScopeBadge').first(), /^Full Pokémon$/)
            }
            const primaryKind = hasBarbaracle ? 'pokemon' : await blockComponent.count() > 0 ? 'block' : 'pokemon'
            const component = page.locator(`.communityPackStudioComponent[data-kind="${primaryKind}"]`).first()
            await component.waitFor({ state: 'visible', timeout: 10_000 })
            await component.click()
            await waitForText(page.locator('#communityPackStudioSelectionCount'), /^1$/)
            await waitForAttribute(page.locator('#communityPackStudioPreviewHost'), 'data-state', 'ready')
            await waitForPackStudioCanvas(page)
            if(primaryKind === 'block') await waitForAttribute(page.locator('#communityPackStudioPreviewHost canvas'), 'data-texture-source', 'resources')
            if(hasBarbaracle) {
                await waitForAttribute(page.locator('#communityPackStudioPreviewHost canvas'), 'data-animation-id', 'ground_idle')
                if(hasAggron) {
                    await studioSearch.fill('aggron')
                    const aggron = page.locator('.communityPackStudioComponent[data-kind="pokemon"]').first()
                    await aggron.waitFor({ state: 'visible', timeout: 10_000 })
                    await waitForText(aggron.locator('strong'), /^Aggron$/)
                    await waitForText(aggron.locator('.communityPackStudioScopeBadge'), /^Partial override$/)
                    await aggron.click()
                    await waitForText(page.locator('#communityPackStudioSelectionCount'), /^2$/)
                    await waitForAttribute(page.locator('#communityPackStudioPreviewHost'), 'data-state', 'ready')
                    const aggronCanvas = await waitForPackStudioCanvas(page)
                    await waitForAttribute(aggronCanvas, 'data-animation-id', 'ground_idle')
                    const animationSelect = page.locator('#communityPackStudioPreviewHost .communityPackAnimationTools select')
                    await animationSelect.selectOption('cry')
                    await waitForAttribute(aggronCanvas, 'data-animation-id', 'cry')
                    await waitForAttribute(aggronCanvas, 'data-animation-layered', 'true')
                    await animationSelect.selectOption('ground_idle')
                    await waitForAttribute(aggronCanvas, 'data-animation-layered', 'false')
                }
                await studioSearch.fill('')
                await waitForText(page.locator('#communityPackStudioStatus'), /^(?!1 composable resources found\.$)\d+ composable resources found\.$/)
            }
            const componentPreviewChecks = [
                ['pokemon', 'canvas'],
                ['item', '.communityPackStudioItemPreview'],
                ['texture', '.communityPackStudioTexturePreview'],
                ['ui', '.communityPackStudioTexturePreview'],
                ['sound', '.communityPackStudioAudioPreview'],
                ['language', '.communityPackStudioTranslationList'],
                ['font', '.communityPackStudioFontPreview']
            ]
            for(const [kind, selector] of componentPreviewChecks) {
                if(kind === primaryKind) continue
                const result = page.locator(`.communityPackStudioComponent[data-kind="${kind}"]`).first()
                if(await result.count() === 0) continue
                await result.click()
                await waitForAttribute(page.locator('#communityPackStudioPreviewHost'), 'data-state', 'ready')
                await page.locator(`#communityPackStudioPreviewHost ${selector}`).waitFor({ state: 'visible', timeout: 20_000 })
            }
            await waitForText(page.locator('#communityPackStudioConflicts'), /^No unresolved conflicts\.$/)
            await page.locator('#communityPackStudioInstall').click()
            await waitForText(page.locator('#communityPackStudioStatus'), /installed, and enabled at highest priority\./, 30_000)
            await page.locator('#communityPackStudioPreviewCombined').click()
            await page.locator('#communityPackStudioPreviewHost .communityPackModeControl').waitFor({ state: 'visible', timeout: 30_000 })
            await page.locator('#communityPackStudioPreviewHost .communityPackModeControl [data-mode="compare"]').click()
            if(await page.locator('#communityPackStudioPreviewHost .communityPackComparisonPane').count() !== 2) throw new Error('Pack Studio combined comparison did not create separate Base and Pack views.')
            const installedPacks = fs.readdirSync(path.join(runtime.instanceRoot, 'resourcepacks')).filter(name => /^ag-studio-[a-f0-9-]{36}\.zip$/i.test(name))
            if(installedPacks.length !== 1) throw new Error('Pack Studio did not install exactly one deterministic project pack.')
            if(rendererErrors.length > 0) throw new Error(`Renderer error during Pack Studio verification: ${rendererErrors[0]}`)
            await page.locator('#communityPackStudioBack').click()
            await studio.waitFor({ state: 'hidden', timeout: 10_000 })
            console.log('Verified Pack Studio discovery, local projects, combined Base/Pack preview, deterministic build, and highest-priority installation.')
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

module.exports = { closeOpenDetail, parseArguments, resetShowroomCatalog, run, usage, waitForApplicationClose, waitForAttribute, waitForText }
