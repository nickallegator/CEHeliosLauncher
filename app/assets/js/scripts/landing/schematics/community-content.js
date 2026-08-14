'use strict'

let { CommunityInstallManager } = require('./assets/js/communityinstallmanager')
let { prepareCommunityArtifact, validatePublishSource } = require('./assets/js/communitypublisher')
let { webUtils: genericCommunityWebUtils } = require('electron')
let genericCommunitySemver = require('semver')
let { Worker: GenericCommunityWorker } = require('worker_threads')
let genericCommunityPath = require('path')
let { CommunityRichPreviewHost } = require('./assets/js/communitypreviews')
let { defaultShowcase, discoverResourcePackShowcase } = require('./assets/js/communityresourcepackshowcase')
let {
    renderTexturedGradientSvg: genericRenderTexturedGradientSvg,
    sampleGradient: genericSampleGradient
} = require(genericCommunityPath.resolve(process.cwd(), 'libraries', 'community-rendering'))
let { resolveBlockTopTexture: genericResolveBlockTopTexture } = require(genericCommunityPath.resolve(process.cwd(), 'libraries', 'minecraft-resources'))

let genericCommunityInstallManager = null
let genericCommunityDetailEntry = null
let genericCommunityPublishType = null
let genericCommunityPublishTarget = null
let genericCommunityPreparedPublication = null
let genericCommunityRichPreview = null
let genericCommunityShowcase = null
let genericCommunityContractCache = null

function genericCommunityElement(id){ return document.getElementById(id) }

function genericCommunityTypeLabel(type){
    const definition = communityContentRegistry?.get(type)
    return definition ? Lang.query(definition.labelKey) : type
}

function genericCommunitySelectedFile(input){
    const file = input?.files?.[0]
    if(!file) return null
    if(genericCommunityWebUtils?.getPathForFile) return genericCommunityWebUtils.getPathForFile(file)
    return file.path || null
}

function genericCommunitySvgToPng(svg){
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas')
                canvas.width = image.naturalWidth || 768
                canvas.height = image.naturalHeight || 432
                canvas.getContext('2d').drawImage(image, 0, 0)
                canvas.toBlob(blob => blob ? blob.arrayBuffer().then(value => resolve(Buffer.from(value))).catch(reject) : reject(new Error('Unable to render Community preview.')), 'image/png')
            } catch(error) { reject(error) }
        }
        image.onerror = () => reject(new Error('Unable to decode Community preview.'))
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    })
}

async function generateCommunityPreview(type, artifact){
    if(type === 'builder-presets'){
        const stack = await buildCommunityCanonicalResourceStack()
        const sample = genericSampleGradient(artifact)
        const blockIds = [...new Set([...sample.blocks, ...sample.model.pins.map(pin => pin.block)].filter(Boolean))].sort()
        const textures = new Map()
        const missing = []
        let cursor = 0
        const workers = Array.from({ length: Math.min(6, blockIds.length) }, async () => {
            while(cursor < blockIds.length){
                const blockId = blockIds[cursor++]
                try { textures.set(blockId, await genericResolveBlockTopTexture(stack, blockId)) }
                catch(error) { missing.push({ blockId, error }) }
            }
        })
        await Promise.all(workers)
        if(missing.length > 0){
            const ids = missing.map(value => value.blockId).sort()
            throw new Error(`Unable to resolve Builder Preset textures: ${ids.join(', ')}. Repair the selected profile or install its declared dependencies before publishing.`)
        }
        const rendered = genericRenderTexturedGradientSvg(sample, textures, { width: 768, height: 432 })
        if(rendered.missing.length > 0) throw new Error(`Unable to render Builder Preset textures: ${rendered.missing.join(', ')}.`)
        return { bytes: await genericCommunitySvgToPng(rendered.svg), mimeType: 'image/png', generated: true }
    }
    const workerPath = genericCommunityPath.resolve(__dirname, 'assets', 'js', 'communitypreviewworker.js')
    const svg = await new Promise((resolve, reject) => {
        const worker = new GenericCommunityWorker(workerPath)
        const finish = callback => value => { worker.terminate().catch(() => {}); callback(value) }
        worker.once('message', finish(result => result?.svg ? resolve(result.svg) : reject(new Error(result?.error || 'Unable to generate Automation preview.'))))
        worker.once('error', finish(reject))
        worker.postMessage({ type, artifact: Buffer.from(artifact) })
    })
    return { bytes: await genericCommunitySvgToPng(svg), mimeType: 'image/png', generated: true }
}

function genericCommunityPreviewDataUrl(preview){
    return `data:${preview.mimeType};base64,${Buffer.from(preview.bytes).toString('base64')}`
}

function genericCommunitySelectedPreview(previewPath){
    if(!previewPath) return null
    return {
        bytes: require('fs').readFileSync(previewPath),
        mimeType: previewPath.toLowerCase().endsWith('.webp') ? 'image/webp' : (previewPath.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : 'image/png')
    }
}

async function prepareGenericCommunityPublication(type, artifactPath, previewPath){
    const publishContext = await genericCommunityContext({
        type,
        compatibility: {
            minecraft: '1.21.1', loader: 'neoforge',
            cobblePower: '>=1.0.4-test.1 <1.1.0', cobblemon: '>=1.6.0 <1.7.0'
        }
    })
    const localSource = validatePublishSource(type, artifactPath, {
        instanceDirectory: ConfigManager.getInstanceDirectory(),
        profileId: publishContext.profileId,
        playerUuid: publishContext.account?.uuid
    })
    const artifact = prepareCommunityArtifact(type, localSource)
    const automaticPreview = type === 'builder-presets' || type === 'automation'
    let preview = automaticPreview ? null : genericCommunitySelectedPreview(previewPath)
    if(automaticPreview) preview = await generateCommunityPreview(type, artifact)
    const showcase = type === 'resource-packs'
        ? (genericCommunityShowcase || defaultShowcase(discoverResourcePackShowcase(artifactPath)))
        : null
    return { artifact, preview, showcase }
}

function renderGenericCommunityShowcase(){
    const root = genericCommunityElement('communityResourcePackShowcase')
    const list = genericCommunityElement('communityResourcePackShowcaseSubjects')
    if(!root || !list) return
    root.hidden = genericCommunityPublishType !== 'resource-packs'
    list.replaceChildren()
    if(root.hidden || !genericCommunityShowcase) return
    const selected = genericCommunityShowcase.subjects
    const candidates = genericCommunityShowcase.candidates || selected
    const keyFor = subject => subject.kind === 'block' ? `block:${subject.id}` : `pokemon:${subject.species}`
    const selectedKeys = new Set(selected.map(keyFor))
    const ordered = [...selected, ...candidates.filter(candidate => !selectedKeys.has(keyFor(candidate)))]
    for(const subject of ordered){
        const item = document.createElement('li')
        item.dataset.key = keyFor(subject)
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'; toggle.checked = selectedKeys.has(item.dataset.key)
        const name = document.createElement('span')
        name.textContent = `${subject.kind === 'block' ? 'Block' : 'Pokémon'} · ${(subject.id || subject.species).split(':').at(-1).replaceAll('_', ' ')}`
        const up = document.createElement('button'); up.type = 'button'; up.textContent = '↑'; up.setAttribute('aria-label', `Move ${name.textContent} earlier`)
        const down = document.createElement('button'); down.type = 'button'; down.textContent = '↓'; down.setAttribute('aria-label', `Move ${name.textContent} later`)
        const move = amount => {
            const index = selected.findIndex(value => keyFor(value) === item.dataset.key)
            const target = index + amount
            if(index < 0 || target < 0 || target >= selected.length) return
            ;[selected[index], selected[target]] = [selected[target], selected[index]]
            renderGenericCommunityShowcase()
        }
        up.addEventListener('click', () => move(-1)); down.addEventListener('click', () => move(1))
        toggle.addEventListener('change', () => {
            const current = selected.findIndex(value => keyFor(value) === item.dataset.key)
            if(toggle.checked){
                if(selected.length >= 8 || (subject.kind === 'pokemon' && selected.filter(value => value.kind === 'pokemon').length >= 4)){
                    toggle.checked = false
                    genericCommunityElement('communityContentPublishStatus').textContent = 'The showcase supports eight subjects with at most four Pokémon.'
                    return
                }
                if(current < 0) selected.push({ ...subject })
            } else if(current >= 0) selected.splice(current, 1)
            renderGenericCommunityShowcase()
        })
        up.disabled = !toggle.checked; down.disabled = !toggle.checked
        item.append(toggle, name, up, down); list.append(item)
    }
}

async function refreshGenericCommunityPublicationPreview(){
    const artifactPath = genericCommunitySelectedFile(genericCommunityElement('communityContentArtifactFile'))
    const previewPath = genericCommunitySelectedFile(genericCommunityElement('communityContentPreviewFile'))
    const figure = genericCommunityElement('communityContentPreviewConfirmation')
    const confirmed = genericCommunityElement('communityContentPreviewConfirmed')
    const image = genericCommunityElement('communityContentPreviewImage')
    genericCommunityPreparedPublication = null
    confirmed.checked = false
    figure.hidden = true
    if(!artifactPath || !genericCommunityPublishType) return
    const status = genericCommunityElement('communityContentPublishStatus')
    status.textContent = communityCopy('preparingCreationPreview')
    try {
        if(genericCommunityPublishType === 'resource-packs'){
            const candidates = discoverResourcePackShowcase(artifactPath)
            const initial = defaultShowcase(candidates)
            genericCommunityShowcase = { ...initial, candidates }
            renderGenericCommunityShowcase()
        }
        const prepared = await prepareGenericCommunityPublication(genericCommunityPublishType, artifactPath, previewPath)
        genericCommunityPreparedPublication = { ...prepared, artifactPath, previewPath, type: genericCommunityPublishType }
        image.src = prepared.preview
            ? genericCommunityPreviewDataUrl(prepared.preview)
            : 'assets/brand/allegator-games-app-icon.png'
        figure.hidden = false
        status.textContent = ''
    } catch(error) {
        status.textContent = error?.message || communityCopy('previewRequired')
    }
}

function ensureGenericCommunityInstallManager(){
    if(!genericCommunityInstallManager){
        genericCommunityInstallManager = new CommunityInstallManager({
            instanceDirectory: ConfigManager.getInstanceDirectory(),
            launcherDirectory: ConfigManager.getLauncherDirectory(),
            isGameRunning: () => typeof proc !== 'undefined' && proc != null && proc.exitCode == null
        })
    }
    return genericCommunityInstallManager
}

function genericCommunityFindModuleVersion(modules, prefix){
    for(const module of modules || []){
        const raw = module.rawModule || module
        const id = String(raw?.id || '')
        if(id.startsWith(`${prefix}:`)) return id.slice(prefix.length + 1)
        const nested = genericCommunityFindModuleVersion(module.subModules || raw?.subModules, prefix)
        if(nested) return nested
    }
    return null
}

async function genericCommunityContext(entry){
    const distro = await DistroAPI.getDistribution()
    const profileId = ConfigManager.getSelectedServer()
    const server = distro.getServerById(profileId)
    if(!server || !moduleContainsCobblePower(server.modules || server.rawServer?.modules)) {
        const error = new Error(communityCopy('incompatibleCreation'))
        error.code = 'incompatible_profile'
        throw error
    }
    const account = ConfigManager.getSelectedAccount()
    if(['automation', 'battle-trainers'].includes(entry.type) && !account?.uuid) {
        throw Object.assign(new Error(communityCopy('accountRequired')), { code: 'account_required' })
    }
    const expectedMinecraft = entry.compatibility?.minecraft
    const actualMinecraft = server.rawServer?.minecraftVersion || server.minecraftVersion || server.getMinecraftVersion?.()
    if(expectedMinecraft && actualMinecraft && expectedMinecraft !== actualMinecraft) {
        throw Object.assign(new Error(communityCopy('incompatibleCreation')), { code: 'incompatible_profile' })
    }
    if(entry.compatibility?.loader && String(entry.compatibility.loader).toLowerCase() !== 'neoforge'){
        throw Object.assign(new Error(communityCopy('incompatibleCreation')), { code: 'incompatible_profile' })
    }
    const modules = server.modules || server.rawServer?.modules
    const cobblePowerVersion = genericCommunityFindModuleVersion(modules, 'net.allegator.cobblepower:cobblepower')
    if(entry.compatibility?.cobblePower && (!genericCommunitySemver.valid(cobblePowerVersion)
        || !genericCommunitySemver.satisfies(cobblePowerVersion, entry.compatibility.cobblePower, { includePrerelease: true }))){
        throw Object.assign(new Error(communityCopy('incompatibleCreation')), { code: 'incompatible_profile' })
    }
    const cobblemonVersion = genericCommunityFindModuleVersion(modules, 'com.cobblemon:neoforge')
    const normalizedCobblemonVersion = String(cobblemonVersion || '').split('+')[0]
    if(entry.compatibility?.cobblemon && (!genericCommunitySemver.valid(normalizedCobblemonVersion)
        || !genericCommunitySemver.satisfies(normalizedCobblemonVersion, entry.compatibility.cobblemon, { includePrerelease: true }))){
        throw Object.assign(new Error(communityCopy('incompatibleCreation')), { code: 'incompatible_profile' })
    }
    return { profileId, account }
}

function genericCommunityStatusLabel(state){
    return {
        install: communityCopy('install'),
        installed: communityCopy('installedCreation'),
        update: communityCopy('updateCreation'),
        repair: communityCopy('repairNeeded'),
        modified: communityCopy('modifiedCreation'),
        disabled: communityCopy('disabledCreation'),
        incompatible: communityCopy('incompatibleCreation')
    }[state] || state
}

async function genericCommunityRenderBlockSubject({ host, subject, resourceStack }){
    const canvas = document.createElement('canvas')
    canvas.tabIndex = 0
    canvas.setAttribute('aria-label', `${subject.id} block model. Drag to rotate and use the wheel to zoom.`)
    host.replaceChildren(canvas)
    const palette = [{ block: subject.id, state: subject.state || {} }]
    const schematic = {
        name: subject.id,
        palette,
        blocks: [{ x: 0, y: 0, z: 0, p: 0 }],
        bounds: { min: [0, 0, 0], max: [0, 0, 0], size: [1, 1, 1] },
        meta: { blockCount: 1 }
    }
    await ensureRegistryForSchematic(schematic, resourceStack)
    const atlas = await prepareTextureAtlasForSchematic(schematic, { resourceStack })
    const renderer = new SchematicPreviewRenderer(canvas, host, {
        autoFrameMesh: true,
        defaultYaw: -Math.PI / 4,
        defaultPitch: 0.34,
        minimumRadius: 2.65
    })
    if(atlas?.canvas) renderer.setTextureAtlas(atlas.canvas)
    canvas.dataset.textureSource = atlas?.canvas ? 'resources' : 'fallback'
    canvas.dataset.texturesResolved = String(atlas?.resolvedTextureCount || 0)
    renderer.setSchematic(schematic)
    return renderer
}

function ensureGenericCommunityRichPreview(client){
    if(!genericCommunityRichPreview){
        genericCommunityRichPreview = new CommunityRichPreviewHost({
            container: genericCommunityElement('communityContentRichView'),
            fallbackImage: genericCommunityElement('communityContentDetailImage'),
            detailSidebar: genericCommunityElement('communityContentTypeSidebar'),
            client,
            enabled: communityCapabilities?.features?.richPreviews === true,
            headers: getSchematicsAuthHeaders,
            cacheDirectory: genericCommunityPath.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'artifacts'),
            resourceStack: () => buildSchematicsResourceStack(),
            registry: async (_entry, signal) => {
                if(genericCommunityContractCache) return genericCommunityContractCache
                const distro = await DistroAPI.getDistribution()
                const contracts = distro?.rawDistribution?.communityRenderContracts
                const descriptor = contracts?.registry
                const renderDescriptor = contracts?.renderRegistry
                if(!descriptor?.url || !descriptor?.sha256 || !renderDescriptor?.url || !renderDescriptor?.sha256) return {}
                const cache = ensureGenericCommunityRichPreview(client).cache
                const loadDescriptor = async value => {
                    let bytes = cache.get(value.sha256, value.size)
                    if(bytes) return bytes
                    const response = await client.fetch(value.url, { signal })
                    if(!response.ok) throw new Error(`Community render contract returned HTTP ${response.status}.`)
                    bytes = Buffer.from(await response.arrayBuffer())
                    cache.put(value.sha256, bytes, { sizeBytes: value.size, mimeType: 'application/json', role: 'render-contract' })
                    return bytes
                }
                const [registryBytes, renderRegistryBytes] = await Promise.all([loadDescriptor(descriptor), loadDescriptor(renderDescriptor)])
                genericCommunityContractCache = {
                    ...JSON.parse(registryBytes.toString('utf8')),
                    renderRegistry: JSON.parse(renderRegistryBytes.toString('utf8'))
                }
                return genericCommunityContractCache
            },
            renderBlock: genericCommunityRenderBlockSubject
        })
    }
    return genericCommunityRichPreview
}

async function genericCommunityInstallState(entry){
    try {
        const context = await genericCommunityContext(entry)
        return ensureGenericCommunityInstallManager().status(context.profileId, context.account?.uuid, entry)
    } catch(error) {
        return { state: 'incompatible', error, record: null }
    }
}

async function refreshGenericCommunityDetailState(){
    if(!genericCommunityDetailEntry) return
    const state = await genericCommunityInstallState(genericCommunityDetailEntry)
    const install = genericCommunityElement('communityContentInstall')
    const remove = genericCommunityElement('communityContentRemove')
    const enable = genericCommunityElement('communityContentEnable')
    const disable = genericCommunityElement('communityContentDisable')
    const priorityHigher = genericCommunityElement('communityContentPriorityHigher')
    const priorityLower = genericCommunityElement('communityContentPriorityLower')
    const publishRevision = genericCommunityElement('communityContentPublishRevision')
    const status = genericCommunityElement('communityContentDetailStatus')
    if(status) status.textContent = genericCommunityStatusLabel(state.state)
    if(install){
        install.hidden = state.state === 'installed' || state.state === 'disabled'
        install.disabled = state.state === 'incompatible'
        install.textContent = state.state === 'update' ? communityCopy('updateAvailable') : (state.state === 'repair' ? communityCopy('repairNeeded') : communityCopy('install'))
    }
    if(remove) remove.hidden = !state.record
    if(enable){
        enable.hidden = genericCommunityDetailEntry.type !== 'resource-packs' || state.state !== 'disabled'
        enable.textContent = communityCopy('enable')
    }
    const installedPack = genericCommunityDetailEntry.type === 'resource-packs' && state.record
    if(disable) disable.hidden = !installedPack || state.state === 'disabled'
    if(priorityHigher) priorityHigher.hidden = !installedPack || state.state === 'disabled'
    if(priorityLower) priorityLower.hidden = !installedPack || state.state === 'disabled'
    if(publishRevision){
        const userId = getCurrentUserId()
        publishRevision.hidden = !(userId && genericCommunityDetailEntry.ownerId && Number(userId) === Number(genericCommunityDetailEntry.ownerId))
    }
}

function configureGenericCommunityDetailLayout(type){
    const panel = genericCommunityElement('communityContentDetailPanel')
    const typeSidebar = genericCommunityElement('communityContentTypeSidebar')
    const dependenciesOnly = type === 'automation' || type === 'resource-packs'
    if(panel) panel.dataset.communityType = type || ''
    panel?.querySelectorAll?.('[data-community-metadata]').forEach(row => {
        row.hidden = dependenciesOnly && row.dataset.communityMetadata !== 'dependencies'
    })
    if(typeSidebar){
        typeSidebar.hidden = true
        typeSidebar.replaceChildren()
    }
}

async function openGenericCommunityDetail(entry){
    const client = await getCommunityApiClient()
    if(!client) return
    const root = genericCommunityElement('communityContentDetail')
    const panel = genericCommunityElement('communityContentDetailPanel')
    genericCommunityDetailEntry = entry
    openModal(root, panel, { onRequestClose: closeGenericCommunityDetail, initialFocus: '#communityContentDetailClose' })
    try {
        const detail = await client.detail(entry.type, entry.id, { headers: getSchematicsAuthHeaders() })
        if(detail) genericCommunityDetailEntry = detail
    } catch(error) {
        loggerLanding.warn('Failed to load Community detail.', { code: error?.code, message: error?.message })
    }
    const value = genericCommunityDetailEntry
    configureGenericCommunityDetailLayout(value.type)
    genericCommunityElement('communityContentDetailType').textContent = genericCommunityTypeLabel(value.type)
    genericCommunityElement('communityContentDetailTitle').textContent = value.title || value.name
    const creatorName = typeof value.creator === 'string' ? value.creator : value.creator?.name
    genericCommunityElement('communityContentDetailCreator').textContent = `by ${creatorName || 'Minecraft Player'}`
    genericCommunityElement('communityContentDetailDescription').textContent = value.description || ''
    genericCommunityElement('communityContentDetailLicense').textContent = value.license || '\u2014'
    genericCommunityElement('communityContentDetailRights').textContent = value.rightsAttestedAt ? communityCopy('rightsConfirmed') : '\u2014'
    genericCommunityElement('communityContentDetailRevision').textContent = value.revision ? `#${value.revision.number}` : '\u2014'
    genericCommunityElement('communityContentDetailCompatibility').textContent = `${value.compatibility?.minecraft || '1.21.1'} / NeoForge`
    genericCommunityElement('communityContentDetailDependencies').textContent = String(value.dependencies?.length || 0)
    const image = genericCommunityElement('communityContentDetailImage')
    const apiBase = (schematicsState.apiBase || '').replace(/\/+$/, '')
    image.src = value.thumbnailUrl?.startsWith('http') ? value.thumbnailUrl : `${apiBase}${value.thumbnailUrl || ''}`
    image.alt = `${value.title || value.name} preview`
    const detailDefinition = communityContentRegistry?.get(value.type)
    detailDefinition?.createDetailRenderer?.(value, {
        mountRichCommunityPreview: richEntry => ensureGenericCommunityRichPreview(client).mount(richEntry)
    })?.catch?.(error => loggerLanding.debug('Rich Community preview used the static fallback.', { code: error?.code, message: error?.message }))
    const authHeaders = getSchematicsAuthHeaders()
    if(authHeaders.Authorization){
        client.engagement(value.type, value.id, 'view', { headers: authHeaders }).catch(error => {
            loggerLanding.debug('Community view was not recorded.', { code: error?.code })
        })
    }
    await refreshGenericCommunityDetailState()
}

function closeGenericCommunityDetail(){
    const value = genericCommunityDetailEntry
    try {
        communityContentRegistry?.get(value?.type)?.onDetailClosed?.(value, {
            destroyRichCommunityPreview: () => genericCommunityRichPreview?.destroy()
        })
    } catch(error) {
        loggerLanding.warn('Community preview cleanup failed.', { code: error?.code, message: error?.message })
    } finally {
        closeModal(genericCommunityElement('communityContentDetail'))
        genericCommunityDetailEntry = null
    }
}

async function installGenericCommunityItem(entry, chain = new Set()){
    const key = `${entry.type}:${entry.id}`
    if(chain.has(key)) throw Object.assign(new Error('Community dependency cycle detected.'), { code: 'dependency_cycle' })
    chain.add(key)
    const client = await getCommunityApiClient()
    if(!client) throw new Error(communityCopy('notConfigured'))
    const context = await genericCommunityContext(entry)
    await ensureSchematicsAuthSession(client.baseUrl)
    for(const dependency of entry.dependencies || []) {
        const definition = communityContentRegistry?.get(dependency.type)
        if(!definition) throw Object.assign(new Error(communityCopy('missingDependency')), { code: 'missing_dependency' })
        const detail = await client.detail(dependency.type, dependency.itemId, { headers: getSchematicsAuthHeaders() })
        const state = ensureGenericCommunityInstallManager().status(context.profileId, context.account?.uuid, detail)
        if(state.state !== 'installed') await installGenericCommunityItem(detail, chain)
    }
    const status = genericCommunityElement('communityContentDetailStatus')
    if(status) status.textContent = communityCopy('installing')
    const { artifact } = await client.download(entry.type, entry.id, { headers: getSchematicsAuthHeaders() })
    const record = ensureGenericCommunityInstallManager().install({
        profileId: context.profileId,
        playerUuid: context.account?.uuid,
        entry,
        artifact,
        confirmModified: paths => window.confirm(communityCopy('replaceModifiedCreation', { path: paths.join('\n') }))
    })
    chain.delete(key)
    await refreshGenericCommunityDetailState()
    renderSchematics()
    return record
}

async function removeGenericCommunityItem(entry){
    if(!window.confirm(communityCopy('removeCreation'))) return false
    const context = await genericCommunityContext(entry)
    const removed = ensureGenericCommunityInstallManager().remove({
        profileId: context.profileId,
        playerUuid: context.account?.uuid,
        type: entry.type,
        itemId: entry.id,
        confirmModified: paths => window.confirm(communityCopy('replaceModifiedCreation', { path: paths.join('\n') }))
    })
    await refreshGenericCommunityDetailState()
    renderSchematics()
    return removed
}

async function enableGenericCommunityResourcePack(entry){
    const context = await genericCommunityContext(entry)
    ensureGenericCommunityInstallManager().setResourcePackEnabled({
        profileId: context.profileId,
        itemId: entry.id,
        enabled: true,
        confirmModified: paths => window.confirm(communityCopy('replaceModifiedCreation', { path: paths.join('\n') }))
    })
    await refreshGenericCommunityDetailState()
}

async function setGenericCommunityResourcePackEnabled(entry, enabled){
    const context = await genericCommunityContext(entry)
    ensureGenericCommunityInstallManager().setResourcePackEnabled({
        profileId: context.profileId,
        itemId: entry.id,
        enabled,
        confirmModified: paths => window.confirm(communityCopy('replaceModifiedCreation', { path: paths.join('\n') }))
    })
    await refreshGenericCommunityDetailState()
}

async function reorderGenericCommunityResourcePack(entry, direction){
    const context = await genericCommunityContext(entry)
    ensureGenericCommunityInstallManager().reorderResourcePack({
        profileId: context.profileId,
        itemId: entry.id,
        direction,
        confirmModified: paths => window.confirm(communityCopy('replaceModifiedCreation', { path: paths.join('\n') }))
    })
    await refreshGenericCommunityDetailState()
}

function openGenericCommunityPublisher(type, target = null){
    genericCommunityPublishType = type
    genericCommunityPublishTarget = target
    const root = genericCommunityElement('communityContentPublish')
    const panel = genericCommunityElement('communityContentPublishPanel')
    genericCommunityElement('communityContentPublishType').textContent = genericCommunityTypeLabel(type)
    const artifact = genericCommunityElement('communityContentArtifactFile')
    artifact.accept = type === 'resource-packs' ? '.zip,application/zip' : '.json,application/json'
    artifact.value = ''
    const previewFile = genericCommunityElement('communityContentPreviewFile')
    previewFile.value = ''
    const automaticPreview = type === 'builder-presets' || type === 'automation'
    previewFile.disabled = automaticPreview
    genericCommunityElement('communityContentPreviewFileRow').hidden = automaticPreview
    genericCommunityElement('communityContentArtifactHint').textContent = type === 'automation'
        ? communityCopy('automationBundleHint')
        : type === 'builder-presets'
            ? communityCopy('builderPreviewGenerated')
            : communityCopy('selectLocalCreation')
    genericCommunityElement('communityContentPublishStatus').textContent = ''
    genericCommunityPreparedPublication = null
    genericCommunityShowcase = null
    renderGenericCommunityShowcase()
    genericCommunityElement('communityContentPreviewConfirmation').hidden = true
    genericCommunityElement('communityContentPreviewConfirmed').checked = false
    genericCommunityElement('communityContentPublishName').value = target?.title || ''
    genericCommunityElement('communityContentPublishDescription').value = target?.description || ''
    genericCommunityElement('communityContentPublishTags').value = (target?.tags || []).join(', ')
    if(target?.license) genericCommunityElement('communityContentPublishLicense').value = target.license
    openModal(root, panel, { onRequestClose: closeGenericCommunityPublisher, initialFocus: '#communityContentPublishClose' })
}

function closeGenericCommunityPublisher(){
    closeModal(genericCommunityElement('communityContentPublish'))
    genericCommunityPublishType = null
    genericCommunityPublishTarget = null
    genericCommunityPreparedPublication = null
    genericCommunityShowcase = null
}

async function submitGenericCommunityPublisher(){
    const type = genericCommunityPublishType
    if(!type) return
    const artifactPath = genericCommunitySelectedFile(genericCommunityElement('communityContentArtifactFile'))
    const previewPath = genericCommunitySelectedFile(genericCommunityElement('communityContentPreviewFile'))
    const status = genericCommunityElement('communityContentPublishStatus')
    if(!artifactPath) {
        status.textContent = communityCopy('selectLocalCreation')
        return
    }
    if(!['resource-packs', 'automation', 'builder-presets'].includes(type) && !previewPath) {
        status.textContent = communityCopy('previewRequired')
        return
    }
    if(!genericCommunityElement('communityContentPreviewConfirmed').checked) {
        status.textContent = communityCopy('previewConfirmationRequired')
        return
    }
    const submit = genericCommunityElement('communityContentPublishSubmit')
    submit.disabled = true
    status.textContent = communityCopy('publishingCreation')
    try {
        const client = await getCommunityApiClient()
        await ensureSchematicsAuthSession(client.baseUrl)
        const prepared = genericCommunityPreparedPublication?.type === type
            && genericCommunityPreparedPublication.artifactPath === artifactPath
            && genericCommunityPreparedPublication.previewPath === previewPath
            ? genericCommunityPreparedPublication
            : await prepareGenericCommunityPublication(type, artifactPath, previewPath)
        const { artifact, preview, showcase } = prepared
        await client.publish({
            type,
            ...(genericCommunityPublishTarget?.id ? { targetItemId: genericCommunityPublishTarget.id } : {}),
            title: genericCommunityElement('communityContentPublishName').value,
            description: genericCommunityElement('communityContentPublishDescription').value,
            tags: genericCommunityElement('communityContentPublishTags').value,
            license: genericCommunityElement('communityContentPublishLicense').value,
            rightsAttested: genericCommunityElement('communityContentPublishRights').checked,
            visibility: 'public',
            ...(showcase ? { showcase: { schemaVersion: 1, subjects: showcase.subjects } } : {}),
            compatibility: {
                minecraft: '1.21.1', loader: 'neoforge',
                cobblePower: '>=1.0.4-test.1 <1.1.0', cobblemon: '>=1.6.0 <1.7.0'
            }
        }, artifact, preview, { headers: getSchematicsAuthHeaders() })
        status.textContent = communityCopy('publishedCreation')
        await fetchSchematicsList({ page: 1 })
        setTimeout(closeGenericCommunityPublisher, 700)
    } catch(error) {
        loggerLanding.warn('Community publication failed.', { code: error?.code, message: error?.message })
        status.textContent = error?.message || communityCopy('publishFailed')
    } finally {
        submit.disabled = false
    }
}

async function reportGenericCommunityItem(entry){
    const reason = window.prompt(communityCopy('reportReason'))
    if(!reason) return
    const client = await getCommunityApiClient()
    await ensureSchematicsAuthSession(client.baseUrl)
    await client.engagement(entry.type, entry.id, 'report', {
        headers: getSchematicsAuthHeaders(),
        body: { reason }
    })
}

async function likeGenericCommunityItem(entry){
    const client = await getCommunityApiClient()
    await ensureSchematicsAuthSession(client.baseUrl)
    const result = await client.engagement(entry.type, entry.id, 'like', { headers: getSchematicsAuthHeaders() })
    entry.stats = { ...(entry.stats || {}), likes: Number(result.likes || 0) }
    genericCommunityElement('communityContentLike').textContent = communityCopy('liked')
    renderSchematics()
}

function initGenericCommunityContent(){
    ensureGenericCommunityInstallManager()
    genericCommunityElement('communityContentDetailClose')?.addEventListener('click', closeGenericCommunityDetail)
    genericCommunityElement('communityContentDetailScrim')?.addEventListener('click', closeGenericCommunityDetail)
    genericCommunityElement('communityContentInstall')?.addEventListener('click', async () => {
        if(!genericCommunityDetailEntry) return
        try { await installGenericCommunityItem(genericCommunityDetailEntry) }
        catch(error) {
            loggerLanding.warn('Community installation failed.', { code: error?.code, message: error?.message })
            genericCommunityElement('communityContentDetailStatus').textContent = error?.message || communityCopy('installFailedCreation')
        }
    })
    genericCommunityElement('communityContentRemove')?.addEventListener('click', async () => {
        if(genericCommunityDetailEntry) await removeGenericCommunityItem(genericCommunityDetailEntry).catch(error => {
            genericCommunityElement('communityContentDetailStatus').textContent = error?.message || communityCopy('installFailedCreation')
        })
    })
    genericCommunityElement('communityContentEnable')?.addEventListener('click', () => genericCommunityDetailEntry && setGenericCommunityResourcePackEnabled(genericCommunityDetailEntry, true))
    genericCommunityElement('communityContentDisable')?.addEventListener('click', () => genericCommunityDetailEntry && setGenericCommunityResourcePackEnabled(genericCommunityDetailEntry, false))
    genericCommunityElement('communityContentPriorityHigher')?.addEventListener('click', () => genericCommunityDetailEntry && reorderGenericCommunityResourcePack(genericCommunityDetailEntry, 'higher'))
    genericCommunityElement('communityContentPriorityLower')?.addEventListener('click', () => genericCommunityDetailEntry && reorderGenericCommunityResourcePack(genericCommunityDetailEntry, 'lower'))
    genericCommunityElement('communityContentLike')?.addEventListener('click', () => genericCommunityDetailEntry && likeGenericCommunityItem(genericCommunityDetailEntry).catch(error => {
        genericCommunityElement('communityContentDetailStatus').textContent = error?.message || communityCopy('loginRequired')
    }))
    genericCommunityElement('communityContentPublishRevision')?.addEventListener('click', () => {
        if(genericCommunityDetailEntry) openGenericCommunityPublisher(genericCommunityDetailEntry.type, genericCommunityDetailEntry)
    })
    genericCommunityElement('communityContentReport')?.addEventListener('click', () => genericCommunityDetailEntry && reportGenericCommunityItem(genericCommunityDetailEntry))
    genericCommunityElement('communityContentPublishClose')?.addEventListener('click', closeGenericCommunityPublisher)
    genericCommunityElement('communityContentPublishCancel')?.addEventListener('click', closeGenericCommunityPublisher)
    genericCommunityElement('communityContentPublishScrim')?.addEventListener('click', closeGenericCommunityPublisher)
    genericCommunityElement('communityContentArtifactFile')?.addEventListener('change', refreshGenericCommunityPublicationPreview)
    genericCommunityElement('communityContentPreviewFile')?.addEventListener('change', refreshGenericCommunityPublicationPreview)
    genericCommunityElement('communityContentPublishSubmit')?.addEventListener('click', submitGenericCommunityPublisher)
}

window.openGenericCommunityDetail = openGenericCommunityDetail
window.openGenericCommunityPublisher = openGenericCommunityPublisher
window.installGenericCommunityItem = installGenericCommunityItem
window.removeGenericCommunityItem = removeGenericCommunityItem
