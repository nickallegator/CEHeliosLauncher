'use strict'

let { Worker: PackStudioWorker } = require('worker_threads')
let { fork: packStudioFork } = require('child_process')
let PackStudioRemote = require('@electron/remote')
let { CommunityArtifactCache: PackStudioArtifactCache } = require('./assets/js/communityartifactcache')
let { PackStudioProjectStore, projectRecipeHash } = require('./assets/js/packstudioprojects')
let { PackStudioInstallManager } = require('./assets/js/packstudioinstallmanager')
let { hashFile: packStudioHashFile, writeFilesTransaction: packStudioWriteFilesTransaction } = require('./assets/js/communityinstallmanager')
let { ResourcePackCommunityPreview: PackStudioResourcePackPreview } = require('./assets/js/communitypreviews/resource-pack')
let { PackStudioComponentPreview, componentSubjects: packStudioComponentSubjects } = require('./assets/js/packstudiocomponentpreview')
let { captureScrollPosition: capturePackStudioScrollPosition } = require('./assets/js/communityscroll')

const PACK_STUDIO_ROUTE = 'community/pack-studio'
const PACK_STUDIO_KINDS = ['block','pokemon','item','sound','font','language','ui','texture','generic']
let packStudioInitialized = false
let packStudioEnabled = false
let packStudioStore = null
let packStudioCache = null
let packStudioInstaller = null
let packStudioProject = null
let packStudioResults = []
let packStudioNextCursor = null
let packStudioResolution = null
let packStudioResolveTimer = null
let packStudioSearchTimer = null
let packStudioSearchController = null
let packStudioSelectionDetails = new Map()
let packStudioLoading = false
let packStudioPreviewRenderer = null
let packStudioActivePreviewRef = null
const packStudioComponentPreviewBuilds = new Map()

function packStudioElement(id){ return document.getElementById(id) }
function packStudioRef(component){ return `${component.source.revisionId}:${component.key}` }
function packStudioSelectionRef(selection){ return `${selection.sourceRevisionId}:${selection.componentKey}` }
function packStudioSetStatus(message, error = false){
    const element = packStudioElement('communityPackStudioStatus')
    if(element){ element.textContent = message || ''; element.dataset.error = String(error) }
}

function packStudioConfirmModified(paths){
    return window.confirm(`Replace locally modified files?\n\n${paths.join('\n')}`)
}

function refreshPackStudioInstallActions(){
    if(!packStudioProject || !packStudioInstaller) return
    const profileId = ConfigManager.getSelectedServer()
    const status = packStudioInstaller.status(profileId, packStudioProject.id)
    const installed = Boolean(status.record)
    packStudioElement('communityPackStudioEnable').hidden = status.state !== 'disabled'
    packStudioElement('communityPackStudioDisable').hidden = !installed || status.state === 'disabled'
    packStudioElement('communityPackStudioHigher').hidden = !installed || status.state === 'disabled'
    packStudioElement('communityPackStudioLower').hidden = !installed || status.state === 'disabled'
    packStudioElement('communityPackStudioRemoveInstalled').hidden = !installed
    const install = packStudioElement('communityPackStudioInstall')
    install.textContent = ['modified','repair'].includes(status.state) ? 'Repair & Install' : 'Build & Install'
}

function packStudioSetVisible(visible){
    const catalogIds = ['schematicsHeader','schematicsActionGroup','schematicsBrowseSchematicsView','schematicsBrowseCollectionsView','schematicsCreatorsBrowseView','schematicsBrowseCreatorView']
    for(const id of catalogIds){
        const element = packStudioElement(id)
        if(!element) continue
        if(visible) element.hidden = true
        else if(['schematicsHeader','schematicsActionGroup','schematicsBrowseSchematicsView'].includes(id)) element.hidden = false
    }
    packStudioElement('communityPackStudio').hidden = !visible
}

function packStudioProjectDirectory(){ return pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'projects') }
function ensurePackStudioServices(){
    if(!packStudioStore) packStudioStore = new PackStudioProjectStore(packStudioProjectDirectory())
    if(!packStudioCache) packStudioCache = new PackStudioArtifactCache({
        directory: pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'artifacts'),
        maxBytes: 1024 * 1024 * 1024
    })
    if(!packStudioInstaller) packStudioInstaller = new PackStudioInstallManager({
        instanceDirectory: ConfigManager.getInstanceDirectory(),
        indexPath: pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'install-index-v1.json'),
        isGameRunning: () => typeof proc !== 'undefined' && proc != null && proc.exitCode == null
    })
}

function packStudioProjects(){ ensurePackStudioServices(); return packStudioStore.list() }
function packStudioRefreshProjectPicker(){
    const select = packStudioElement('communityPackStudioProjects')
    const projects = packStudioProjects()
    select.replaceChildren(...projects.map(project => {
        const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; return option
    }))
    if(packStudioProject) select.value = packStudioProject.id
}

function packStudioLoadProject(id){
    ensurePackStudioServices()
    packStudioProject = packStudioStore.get(id) || packStudioStore.create()
    packStudioResolution = null
    packStudioPreviewRenderer?.destroy?.(); packStudioPreviewRenderer = null; packStudioActivePreviewRef = null
    const previewHost = packStudioElement('communityPackStudioPreviewHost')
    if(previewHost){const fallback=document.createElement('div');fallback.className='communityPackStudioPreviewFallback';fallback.textContent='Select a component to inspect its resources and dependencies.';previewHost.replaceChildren(fallback);previewHost.removeAttribute('data-state')}
    packStudioSelectionDetails.clear()
    packStudioElement('communityPackStudioName').value = packStudioProject.name
    packStudioRefreshProjectPicker()
    renderPackStudioSelections()
    schedulePackStudioResolve()
    refreshPackStudioInstallActions()
}

function packStudioSave(){
    if(!packStudioProject) return
    packStudioProject.name = packStudioElement('communityPackStudioName').value
    packStudioProject = packStudioStore.save(packStudioProject)
    packStudioRefreshProjectPicker()
    packStudioSetStatus('Project saved locally.')
}

function openPackStudio(){
    if(!packStudioEnabled){ packStudioSetStatus('Pack Studio is not enabled by this Community service.', true); return }
    ensurePackStudioServices()
    const projects = packStudioProjects()
    if(!packStudioProject) packStudioLoadProject(projects[0]?.id || packStudioStore.create().id)
    packStudioSetVisible(true)
    window.AppShell?.navigate?.(PACK_STUDIO_ROUTE)
    setTimeout(() => packStudioSetVisible(true), 0)
    fetchPackStudioComponents()
}

function closePackStudio(){
    packStudioPreviewRenderer?.destroy?.(); packStudioPreviewRenderer = null
    packStudioActivePreviewRef = null
    packStudioSetVisible(false)
    window.AppShell?.navigate?.('community')
}

function packStudioSearchParams(cursor = null){
    return {
        query: packStudioElement('communityPackStudioSearch').value,
        kind: packStudioElement('communityPackStudioKind').value,
        creator: packStudioElement('communityPackStudioCreator').value,
        source: packStudioElement('communityPackStudioSource').value,
        namespace: packStudioElement('communityPackStudioNamespace').value,
        license: packStudioElement('communityPackStudioLicense').value,
        tags: packStudioElement('communityPackStudioTags').value,
        limit: 40,
        cursor
    }
}

async function fetchPackStudioComponents({ append = false } = {}){
    if(packStudioLoading && append) return
    packStudioLoading = true
    packStudioSearchController?.abort()
    packStudioSearchController = new AbortController()
    const generation = packStudioSearchController
    try {
        packStudioSetStatus('Searching opted-in Community resources…')
        const client = await getCommunityApiClient()
        if(!client) throw new Error('Community service is not configured.')
        const result = await client.composerComponents(packStudioSearchParams(append ? packStudioNextCursor : null), { signal: generation.signal })
        if(packStudioSearchController !== generation) return
        packStudioResults = append ? [...packStudioResults, ...result.items] : result.items
        packStudioNextCursor = result.nextCursor || null
        renderPackStudioResults({ resetScroll: !append })
        packStudioElement('communityPackStudioLoadMore').hidden = !packStudioNextCursor
        packStudioSetStatus(`${packStudioResults.length} composable resources found.`)
    } catch(error) {
        if(error?.name === 'AbortError') return
        packStudioSetStatus(error?.message || 'Unable to search Pack Studio.', true)
    } finally { if(packStudioSearchController === generation) packStudioLoading = false }
}

function schedulePackStudioSearch(){
    clearTimeout(packStudioSearchTimer)
    packStudioSearchTimer = setTimeout(() => fetchPackStudioComponents(), 250)
}

function packStudioIsSelected(component){
    const ref = packStudioRef(component)
    return packStudioProject?.selections?.some(selection => packStudioSelectionRef(selection) === ref)
}

function packStudioPokemonCoverage(component){
    if(component?.kind !== 'pokemon') return null
    const metadata = component.metadata?.pokemonOverride
    const scope = metadata?.scope === 'full' ? 'full' : metadata?.scope === 'partial' ? 'partial' : 'unknown'
    return {
        scope,
        label: scope === 'full' ? 'Full Pokémon' : scope === 'partial' ? 'Partial override' : 'Unclassified',
        provides: metadata?.provides || []
    }
}

function syncPackStudioResultState(){
    const host = packStudioElement('communityPackStudioResults')
    if(!host) return
    for(const button of host.querySelectorAll('.communityPackStudioComponent')) {
        const component = packStudioResults.find(value => packStudioRef(value) === button.dataset.ref)
        if(!component) continue
        button.dataset.selected = String(packStudioIsSelected(component))
        button.dataset.previewing = String(button.dataset.ref === packStudioActivePreviewRef)
    }
}

function renderPackStudioResults(options = {}){
    const host = packStudioElement('communityPackStudioResults')
    const restoreScroll = capturePackStudioScrollPosition(host, { reset: options.resetScroll })
    host.replaceChildren()
    for(const component of packStudioResults){
        const button = document.createElement('button'); button.type = 'button'; button.className = 'communityPackStudioComponent'
        button.dataset.ref = packStudioRef(component); button.dataset.selected = String(packStudioIsSelected(component)); button.setAttribute('role', 'listitem')
        button.dataset.kind = component.kind
        button.dataset.previewing = String(button.dataset.ref === packStudioActivePreviewRef)
        const copy = document.createElement('span')
        const title = document.createElement('strong'); title.textContent = component.title
        const meta = document.createElement('small'); meta.textContent = `${component.source.creator} · ${component.source.title} · ${component.fileCount} files`
        copy.append(title, meta)
        const badges = document.createElement('span'); badges.className = 'communityPackStudioBadges'
        const badge = document.createElement('span'); badge.className = 'communityPackStudioKindBadge'; badge.textContent = component.kind; badges.append(badge)
        const coverage = packStudioPokemonCoverage(component)
        if(coverage) {
            const scope = document.createElement('span'); scope.className = 'communityPackStudioScopeBadge'; scope.dataset.scope = coverage.scope; scope.textContent = coverage.label; badges.append(scope)
            const variants = component.metadata?.pokemonForms || component.metadata?.pokemonVariants || []
            if(variants.some(variant => variant.aspects?.length)) {
                const variant = document.createElement('span'); variant.className = 'communityPackStudioKindBadge'
                variant.textContent = `${variants.length} ${variants.length === 1 ? 'form' : 'forms'}`; badges.append(variant)
            }
            if(component.metadata?.pokemonOverride?.shinyOnly) {
                const shiny = document.createElement('span'); shiny.className = 'communityPackStudioKindBadge'; shiny.textContent = 'Shiny texture'; badges.append(shiny)
            }
        }
        button.append(copy, badges); host.append(button)
    }
    if(!packStudioResults.length){
        const empty = document.createElement('p'); empty.className = 'communityPackStudioPreviewFallback'; empty.textContent = 'No opted-in components match these filters.'; host.append(empty)
    }
    restoreScroll()
}

async function showPackStudioPreview(component){
    packStudioPreviewRenderer?.destroy?.(); packStudioPreviewRenderer = null
    packStudioActivePreviewRef = packStudioRef(component)
    syncPackStudioResultState()
    const host = packStudioElement('communityPackStudioPreviewHost')
    const values = [
        ['Type', component.kind], ['Identifier', component.identifier], ['Creator', component.source.creator],
        ['Source pack', component.source.title], ['License', component.source.license], ['Files', String(component.fileCount)],
        ['Estimated size', `${Math.ceil(component.sizeBytes / 1024)} KiB`], ['Revision', `#${component.source.revisionNumber}`]
    ]
    const coverage = packStudioPokemonCoverage(component)
    if(coverage) {
        const variants = component.metadata?.pokemonForms || component.metadata?.pokemonVariants || []
        values.splice(2, 0,
            ['Coverage', coverage.label],
            ['Provides', coverage.provides.join(', ') || 'Resolver metadata'],
            ['Forms', variants.map(variant => variant.label).join(', ') || 'Default'])
    }
    const meta = packStudioElement('communityPackStudioPreviewMeta'); meta.replaceChildren()
    for(const [key, value] of values){ const dt=document.createElement('dt');dt.textContent=key;const dd=document.createElement('dd');dd.textContent=value;meta.append(dt,dd) }
    try {
        const client = await getCommunityApiClient()
        if(!client) throw new Error('Community service is not configured.')
        const renderer = new PackStudioComponentPreview({
            host,
            component,
            client,
            cache: packStudioCache,
            baseResourceStack: await buildSchematicsResourceStack(),
            renderBlock: genericCommunityRenderBlockSubject,
            prepareArchive: buildPackStudioComponentPreview,
            onStatus: packStudioSetStatus
        })
        if(packStudioActivePreviewRef !== packStudioRef(component)) { renderer.destroy(); return }
        packStudioPreviewRenderer = renderer
        await renderer.mount()
    } catch(error) {
        if(packStudioActivePreviewRef !== packStudioRef(component)) return
        const fallback=document.createElement('div');fallback.className='communityPackStudioPreviewFallback';fallback.textContent=`Unable to preview this ${component.kind}: ${error.message}`
        host.replaceChildren(fallback);host.dataset.state='fallback';packStudioSetStatus(error.message,true)
    }
}

function packStudioRenderableSubjects(){
    return (packStudioProject?.selections || []).flatMap(selection => {
        const [kind, ...identifierParts] = selection.componentKey.split(':')
        const identifier = identifierParts.join(':')
        if(kind === 'block') return [{ kind, id: identifier, state: {} }]
        if(kind === 'pokemon') {
            const component = packStudioSelectionDetails.get(packStudioSelectionRef(selection))
            if(component) return packStudioComponentSubjects(component)
            return [{ kind, species: identifier, form: '', gender: 'MALE', aspects: [] }]
        }
        return []
    })
}

async function previewCombinedPackStudio(){
    try {
        const subjects = packStudioRenderableSubjects()
        if(!subjects.length) throw new Error('Add at least one block or Pokémon component for an interactive 3D comparison. Other selected resources remain listed with verified metadata.')
        const outputDirectory = pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'builds', packStudioProject.id)
        fs.ensureDirSync(outputDirectory)
        const outputPath = pathUtil.join(outputDirectory, 'preview.zip')
        const build = await buildPackStudio(outputPath)
        packStudioPreviewRenderer?.destroy?.()
        const host = packStudioElement('communityPackStudioPreviewHost'); host.replaceChildren()
        packStudioPreviewRenderer = new PackStudioResourcePackPreview({
            host,
            artifact: fs.readFileSync(build.outputPath),
            resourceStack: await buildSchematicsResourceStack(),
            resources: subjects,
            showcase: { schemaVersion: 1, subjects: subjects.slice(0, 8) },
            renderBlock: genericCommunityRenderBlockSubject
        })
        await packStudioPreviewRenderer.mount()
        packStudioSetStatus('Combined Base, Pack, and Compare preview ready.')
    } catch(error) { packStudioSetStatus(error?.message || 'Unable to preview the combined pack.', true) }
}

function togglePackStudioComponent(component){
    const ref = packStudioRef(component)
    const index = packStudioProject.selections.findIndex(selection => packStudioSelectionRef(selection) === ref)
    if(index >= 0) packStudioProject.selections.splice(index, 1)
    else {
        packStudioProject.selections.push({ sourceItemId: component.source.itemId, sourceRevisionId: component.source.revisionId, componentKey: component.key })
        packStudioSelectionDetails.set(ref, component)
    }
    packStudioProject.conflictResolutions = {}
    packStudioProject = packStudioStore.save(packStudioProject)
    syncPackStudioResultState(); renderPackStudioSelections(); schedulePackStudioResolve()
}

function renderPackStudioSelections(){
    const host = packStudioElement('communityPackStudioSelected'); host.replaceChildren()
    const selections = packStudioProject?.selections || []
    packStudioElement('communityPackStudioSelectionCount').textContent = String(selections.length)
    for(const selection of selections){
        const ref = packStudioSelectionRef(selection); const detail = packStudioSelectionDetails.get(ref)
        const row = document.createElement('div'); row.className = 'communityPackStudioSelectedItem'; row.dataset.ref = ref
        const copy=document.createElement('span');const title=document.createElement('strong');title.textContent=detail?.title || selection.componentKey
        const meta=document.createElement('small');meta.textContent=detail ? `${detail.source.creator} · ${detail.source.title}` : `Pinned revision ${selection.sourceRevisionId.slice(0,8)}`
        copy.append(title,meta)
        const sourceUpdate = packStudioResolution?.sources?.find(source => source.revisionId === selection.sourceRevisionId)?.update
        const componentUpdate = sourceUpdate?.components?.find(value => value.componentKey === selection.componentKey)
        if(sourceUpdate && componentUpdate){
            const changes = componentUpdate.added.length + componentUpdate.removed.length + componentUpdate.changed.length
            const updateNote=document.createElement('small');updateNote.className='communityPackStudioUpdate';updateNote.textContent=componentUpdate.available
                ? `Revision #${sourceUpdate.revisionNumber} available · ${changes} file changes`
                : `Revision #${sourceUpdate.revisionNumber} no longer contains this component`
            copy.append(updateNote)
        }
        const actions=document.createElement('span');actions.className='communityPackStudioSelectedActions'
        if(sourceUpdate && componentUpdate?.available){const update=document.createElement('button');update.type='button';update.className='schematicsMiniButton';update.dataset.updateRef=ref;update.textContent=`Use #${sourceUpdate.revisionNumber}`;actions.append(update)}
        const remove=document.createElement('button');remove.type='button';remove.className='schematicsMiniButton';remove.dataset.removeRef=ref;remove.textContent='Remove';actions.append(remove)
        row.append(copy,actions);host.append(row)
    }
    if(!selections.length){ const empty=document.createElement('p');empty.textContent='Search Community components and add them to this project.';host.append(empty) }
}

async function resolvePackStudioProject(){
    clearTimeout(packStudioResolveTimer)
    if(!packStudioProject?.selections?.length){ packStudioResolution=null; renderPackStudioConflicts([]); return null }
    try {
        const client = await getCommunityApiClient()
        packStudioResolution = await client.resolveComposition(packStudioProject)
        renderPackStudioConflicts(packStudioResolution.plan.conflicts || [])
        renderPackStudioSelections()
        const updates = packStudioResolution.sources.filter(source => source.updateAvailable).length
        packStudioSetStatus(`${packStudioProject.selections.length} components resolved${updates ? ` · ${updates} source updates available for manual review` : ''}.`)
        return packStudioResolution
    } catch(error) {
        packStudioResolution = null; renderPackStudioConflicts([])
        packStudioSetStatus(error?.message || 'Unable to resolve this project.', true)
        throw error
    }
}

function schedulePackStudioResolve(){
    clearTimeout(packStudioResolveTimer)
    packStudioResolveTimer = setTimeout(() => resolvePackStudioProject().catch(() => {}), 300)
}

function renderPackStudioConflicts(conflicts){
    const host = packStudioElement('communityPackStudioConflicts'); host.replaceChildren()
    if(!conflicts.length){ host.textContent = 'No unresolved conflicts.'; return }
    for(const conflict of conflicts){
        const panel=document.createElement('div');panel.className='communityPackStudioConflict'
        const title=document.createElement('strong');title.textContent=conflict.jsonKey ? `${conflict.targetPath}: ${conflict.jsonKey}` : conflict.targetPath
        const select=document.createElement('select');select.dataset.conflictKey=conflict.key
        const prompt=document.createElement('option');prompt.value='';prompt.textContent='Choose which creator wins…';select.append(prompt)
        for(const candidate of conflict.candidates){const option=document.createElement('option');option.value=candidate.ref;option.textContent=`${candidate.title} — ${candidate.creator}`;select.append(option)}
        panel.append(title,select);host.append(panel)
    }
}

async function cachePackStudioSources(resolution){
    const client = await getCommunityApiClient()
    const sourceFiles = {}
    let completed = 0
    for(const source of resolution.sources){
        packStudioSetStatus(`Downloading verified source ${completed + 1} of ${resolution.sources.length}…`)
        const cached = await packStudioCache.resolveToFile({ ...source, mimeType: 'application/zip' }, client.fetch.bind(client))
        sourceFiles[source.revisionId] = cached.filePath; completed += 1
    }
    return sourceFiles
}

function buildPackStudioInWorker(payload, options = {}){
    const workerPath = pathUtil.join(PackStudioRemote.app.getAppPath(), 'app', 'assets', 'js', 'packstudioworker.js')
    return new Promise((resolve, reject) => {
        let worker
        let terminate
        try {
            worker = new PackStudioWorker(workerPath)
            terminate = () => worker.terminate().catch(() => {})
        } catch(_error) {
            worker = packStudioFork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
            terminate = () => { if(worker.connected) worker.disconnect(); worker.kill() }
        }
        let settled = false
        const finish = callback => value => {
            if(settled) return
            settled = true
            options.signal?.removeEventListener('abort', abort)
            terminate()
            callback(value)
        }
        const abort = () => finish(reject)(Object.assign(new Error('Pack Studio preview build was cancelled.'), { name: 'AbortError', code: 'aborted' }))
        if(options.signal?.aborted) { abort(); return }
        options.signal?.addEventListener('abort', abort, { once: true })
        worker.on('message', message => {
            if(message.type === 'progress') packStudioSetStatus(`${message.progress.stage} ${message.progress.completed}/${message.progress.total}`)
            else if(message.type === 'complete') finish(resolve)(message.result)
            else if(message.type === 'error') finish(reject)(Object.assign(new Error(message.error.message), { code: message.error.code }))
        })
        worker.once('error', finish(reject))
        worker.once('exit', code => {
            if(!settled) finish(reject)(new Error(`Pack Studio build process exited before completion${code == null ? '.' : ` (code ${code}).`}`))
        })
        if(typeof worker.postMessage === 'function') worker.postMessage({ type: 'build', payload })
        else worker.send({ type: 'build', payload })
    })
}

async function buildPackStudioComponentPreview({ component, resolution, source, sourceFile, signal }){
    const cached = packStudioComponentPreviewBuilds.get(component.contentSha256)
    if(cached && fs.existsSync(cached.outputPath) && packStudioHashFile(cached.outputPath) === cached.sha256) return cached.outputPath
    const directory = pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'component-previews')
    fs.ensureDirSync(directory)
    const outputPath = pathUtil.join(directory, `${component.contentSha256}.zip`)
    const selection = {
        sourceItemId: component.source.itemId,
        sourceRevisionId: component.source.revisionId,
        componentKey: component.key
    }
    const project = {
        schemaVersion: 1,
        id: source.revisionId,
        name: `${component.title} Preview`,
        selections: [selection],
        conflictResolutions: {}
    }
    const build = await buildPackStudioInWorker({
        project,
        resolution,
        sourceFiles: { [source.revisionId]: sourceFile },
        outputPath
    }, { signal })
    packStudioComponentPreviewBuilds.set(component.contentSha256, build)
    return build.outputPath
}

async function buildPackStudio(outputPath){
    packStudioSave()
    const recipeHash = projectRecipeHash(packStudioProject)
    let resolution
    try { resolution = await resolvePackStudioProject() }
    catch(error) {
        const cached = packStudioProject.lastBuild
        if(cached?.recipeHash !== recipeHash || !cached.cachePath || !fs.existsSync(cached.cachePath)
            || packStudioHashFile(cached.cachePath) !== cached.sha256) throw error
        if(pathUtil.resolve(cached.cachePath) !== pathUtil.resolve(outputPath)) {
            packStudioWriteFilesTransaction([{ path: pathUtil.resolve(outputPath), sourcePath: cached.cachePath }])
        }
        packStudioSetStatus('Reused the identical validated Pack Studio output from local cache.')
        return { ...cached, outputPath: pathUtil.resolve(outputPath), cached: true }
    }
    if(!resolution) throw new Error('Add at least one component before building.')
    if(resolution.plan.conflicts?.length) throw new Error('Resolve every conflict before building.')
    for(const source of resolution.sources) {
        await genericCommunityContext({ type: 'resource-packs', compatibility: source.compatibility || {} })
    }
    const sourceFiles = await cachePackStudioSources(resolution)
    const build = await buildPackStudioInWorker({ project: packStudioProject, resolution, sourceFiles, outputPath })
    const cachePath = packStudioCache.putFile(build.sha256, build.outputPath, { sizeBytes: build.sizeBytes, role: 'pack-studio-output', mimeType: 'application/zip' })
    return { ...build, recipeHash, cachePath }
}

async function exportPackStudio(){
    try {
        const defaultPath = `${packStudioProject.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'ag-pack'}.zip`
        const result = await PackStudioRemote.dialog.showSaveDialog(PackStudioRemote.getCurrentWindow(), { title: 'Export Pack Studio Resource Pack', defaultPath, filters: [{ name: 'Minecraft Resource Pack', extensions: ['zip'] }] })
        if(result.canceled || !result.filePath) return
        const build = await buildPackStudio(result.filePath)
        packStudioProject.lastBuild = { ...build, builtAt: new Date().toISOString() }; packStudioProject = packStudioStore.save(packStudioProject)
        packStudioSetStatus(`Exported ${Math.ceil(build.sizeBytes / 1024)} KiB Resource Pack.`)
    } catch(error) { packStudioSetStatus(error?.message || 'Pack Studio export failed.', true) }
}

async function installPackStudio(){
    try {
        const profileId = ConfigManager.getSelectedServer()
        const distro = await DistroAPI.getDistribution(); const server = distro.getServerById(profileId)
        if(!server || !moduleContainsCobblePower(server.modules || server.rawServer?.modules)) throw new Error('Select a compatible Cobble Power profile before installing.')
        const outputDirectory = pathUtil.join(ConfigManager.getLauncherDirectory(), 'community-cache', 'pack-studio', 'builds', packStudioProject.id)
        fs.ensureDirSync(outputDirectory)
        const outputPath = pathUtil.join(outputDirectory, 'current.zip')
        const build = await buildPackStudio(outputPath)
        packStudioInstaller.install({ profileId, project: packStudioProject, build, confirmModified: packStudioConfirmModified })
        packStudioProject.lastBuild = { ...build, profileId, builtAt: new Date().toISOString() }; packStudioProject = packStudioStore.save(packStudioProject)
        packStudioSetStatus('Pack built, installed, and enabled at highest priority.')
        refreshPackStudioInstallActions()
    } catch(error) { packStudioSetStatus(error?.message || 'Pack Studio installation failed.', true) }
}

function updateInstalledPackStudio(action){
    if(!packStudioProject) return
    try {
        const profileId = ConfigManager.getSelectedServer()
        if(action === 'enable') packStudioInstaller.setEnabled({ profileId, projectId: packStudioProject.id, enabled: true, confirmModified: packStudioConfirmModified })
        else if(action === 'disable') packStudioInstaller.setEnabled({ profileId, projectId: packStudioProject.id, enabled: false, confirmModified: packStudioConfirmModified })
        else if(action === 'higher' || action === 'lower') packStudioInstaller.reorder({ profileId, projectId: packStudioProject.id, direction: action, confirmModified: packStudioConfirmModified })
        else if(action === 'remove') {
            if(!window.confirm('Remove this launcher-managed Pack Studio Resource Pack from the selected profile?')) return
            packStudioInstaller.remove({ profileId, projectId: packStudioProject.id, confirmModified: packStudioConfirmModified })
        }
        packStudioSetStatus(action === 'remove' ? 'Installed Pack Studio pack removed.' : 'Installed Resource Pack settings updated.')
        refreshPackStudioInstallActions()
    } catch(error) { packStudioSetStatus(error?.message || 'Unable to update the installed Resource Pack.', true) }
}

async function initPackStudio(){
    if(packStudioInitialized) return
    packStudioInitialized = true
    try {
        const capabilities = await resolveCommunityCapabilities()
        packStudioEnabled = capabilities?.features?.packStudio === true && Number(capabilities?.composer?.schemaVersion) === 1
    } catch(_error) { packStudioEnabled = false }
    const open = packStudioElement('communityPackStudioOpen'); open.hidden = !packStudioEnabled; open.addEventListener('click', openPackStudio)
    packStudioElement('communityPackStudioBack').addEventListener('click', closePackStudio)
    packStudioElement('communityPackStudioProjects').addEventListener('change', event => packStudioLoadProject(event.target.value))
    packStudioElement('communityPackStudioNew').addEventListener('click', () => packStudioLoadProject(packStudioStore.create().id))
    packStudioElement('communityPackStudioDuplicate').addEventListener('click', () => packStudioProject && packStudioLoadProject(packStudioStore.duplicate(packStudioProject.id).id))
    packStudioElement('communityPackStudioDelete').addEventListener('click', () => {
        if(packStudioProject && packStudioInstaller.records.some(record => record.projectId === packStudioProject.id)) {
            packStudioSetStatus('Remove this project from every installed profile before deleting its local recipe.', true)
            return
        }
        if(!packStudioProject || !window.confirm(`Delete local Pack Studio project “${packStudioProject.name}”?`)) return
        packStudioStore.remove(packStudioProject.id); packStudioProject=null; const next=packStudioProjects()[0] || packStudioStore.create(); packStudioLoadProject(next.id)
    })
    for(const id of ['communityPackStudioSearch','communityPackStudioKind','communityPackStudioCreator','communityPackStudioSource','communityPackStudioNamespace','communityPackStudioLicense','communityPackStudioTags']){
        packStudioElement(id).addEventListener(id.endsWith('Kind') ? 'change' : 'input', schedulePackStudioSearch)
    }
    packStudioElement('communityPackStudioLoadMore').addEventListener('click', () => fetchPackStudioComponents({ append: true }))
    packStudioElement('communityPackStudioPreviewCombined').addEventListener('click', previewCombinedPackStudio)
    const progressiveLoader = new IntersectionObserver(entries => {
        if(entries.some(entry => entry.isIntersecting) && packStudioNextCursor) fetchPackStudioComponents({ append: true })
    }, { root: packStudioElement('communityPackStudioBrowser'), rootMargin: '160px' })
    progressiveLoader.observe(packStudioElement('communityPackStudioLoadMore'))
    packStudioElement('communityPackStudioResults').addEventListener('click', event => {
        const row=event.target.closest('[data-ref]');if(!row)return;const component=packStudioResults.find(value=>packStudioRef(value)===row.dataset.ref);if(!component)return
        showPackStudioPreview(component).catch(error => packStudioSetStatus(error?.message || 'Unable to preview this component.', true));togglePackStudioComponent(component)
    })
    packStudioElement('communityPackStudioSelected').addEventListener('click', event => {
        const updateButton=event.target.closest('[data-update-ref]')
        if(updateButton){
            const selection=packStudioProject.selections.find(value=>packStudioSelectionRef(value)===updateButton.dataset.updateRef)
            const source=packStudioResolution?.sources?.find(value=>value.revisionId===selection?.sourceRevisionId)
            const component=source?.update?.components?.find(value=>value.componentKey===selection?.componentKey)
            if(selection && source?.update?.revisionId && component?.available){
                const previousRef=packStudioSelectionRef(selection);const detail=packStudioSelectionDetails.get(previousRef)
                selection.sourceRevisionId=source.update.revisionId
                packStudioSelectionDetails.delete(previousRef)
                if(detail)packStudioSelectionDetails.set(packStudioSelectionRef(selection),{...detail,source:{...detail.source,revisionId:source.update.revisionId,revisionNumber:source.update.revisionNumber}})
                packStudioProject.conflictResolutions={};packStudioProject=packStudioStore.save(packStudioProject);packStudioResolution=null;renderPackStudioSelections();schedulePackStudioResolve()
            }
            return
        }
        const button=event.target.closest('[data-remove-ref]');if(!button)return
        const selection=packStudioProject.selections.find(value=>packStudioSelectionRef(value)===button.dataset.removeRef)
        if(selection){const detail=packStudioSelectionDetails.get(button.dataset.removeRef) || { key: selection.componentKey, source: { revisionId: selection.sourceRevisionId, itemId: selection.sourceItemId } };togglePackStudioComponent(detail)}
    })
    packStudioElement('communityPackStudioConflicts').addEventListener('change', event => {
        const select=event.target.closest('[data-conflict-key]');if(!select?.value)return
        packStudioProject.conflictResolutions[select.dataset.conflictKey]=select.value;packStudioProject=packStudioStore.save(packStudioProject);resolvePackStudioProject().catch(()=>{})
    })
    packStudioElement('communityPackStudioSave').addEventListener('click', () => {
        try { packStudioSave() } catch(error) { packStudioSetStatus(error?.message || 'Unable to save this project.', true) }
    })
    packStudioElement('communityPackStudioExport').addEventListener('click', exportPackStudio)
    packStudioElement('communityPackStudioInstall').addEventListener('click', installPackStudio)
    for(const action of ['enable','disable','higher','lower']) {
        packStudioElement(`communityPackStudio${action[0].toUpperCase()}${action.slice(1)}`).addEventListener('click', () => updateInstalledPackStudio(action))
    }
    packStudioElement('communityPackStudioRemoveInstalled').addEventListener('click', () => updateInstalledPackStudio('remove'))
    window.addEventListener('helios:shell-route-change', event => {
        const studio = event.detail?.route === PACK_STUDIO_ROUTE
        if(studio && packStudioEnabled) { ensurePackStudioServices(); if(!packStudioProject){const projects=packStudioProjects();packStudioLoadProject(projects[0]?.id || packStudioStore.create().id)}; packStudioSetVisible(true); fetchPackStudioComponents() }
        else if(!String(event.detail?.route || '').startsWith(PACK_STUDIO_ROUTE)) {
            packStudioPreviewRenderer?.destroy?.(); packStudioPreviewRenderer=null; packStudioSetVisible(false)
        }
    })
}

window.openPackStudio = openPackStudio
