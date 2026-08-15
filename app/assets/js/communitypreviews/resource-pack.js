'use strict'

/* global document */

const crypto = require('crypto')
const { loadWorkspaceLibrary } = require('../workspacelibrary')
const { captureScrollPosition } = require('../communityscroll')
const { createResourceStack, ZipBufferResourceProvider } = loadWorkspaceLibrary('minecraft-resources')
const {
    compileBedrockAnimations,
    selectableBedrockAnimations,
    selectResolverVariation,
    selectStaticBedrockAnimation
} = loadWorkspaceLibrary('community-rendering')
const { AnimatedPokemonPreview } = require('./animated-pokemon')
const INTERACTION_GUIDANCE = 'Drag to rotate · wheel to zoom'

function splitId(value, fallback = 'minecraft') { const parts = String(value || '').split(':'); return parts.length === 2 ? { namespace: parts[0], path: parts[1] } : { namespace: fallback, path: parts[0] } }
function label(value) { return String(value || '').split(':').at(-1).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }

function resourcePath(value, kind, resolverPath = '', species = '') {
    const id = splitId(value, 'cobblemon')
    let raw = id.path
    if(kind === 'texture') return `assets/${id.namespace}/${raw.replace(/^assets\/[a-z0-9_.-]+\//, '').replace(/\.png$/i, '')}.png`
    const folder = resolverPath.match(/resolvers\/([^/]+)\//)?.[1] || splitId(species, 'cobblemon').path.split('/').at(-1)
    raw = raw.replace(/\.geo$/i, '').replace(/\.json$/i, '')
    return `assets/${id.namespace}/bedrock/pokemon/models/${folder ? `${folder}/` : ''}${raw}.geo.json`
}

async function staticRenderPose(stack, resolverPath, species = '', poser = null) {
    const namespace = resolverPath.match(/^assets\/([^/]+)\//)?.[1] || 'cobblemon'
    const folder = resolverPath.match(/resolvers\/([^/]+)\//)?.[1] || splitId(species, 'cobblemon').path.split('/').at(-1)
    if(!folder || typeof stack?.list !== 'function') return null
    const prefix = `assets/${namespace}/bedrock/pokemon/animations/${folder}/`
    const documents = []
    for(const candidate of await stack.list(prefix)) {
        if(!candidate.endsWith('.json')) continue
        const document = await stack.getJson(candidate)
        if(document?.animations) documents.push(document)
    }
    return selectStaticBedrockAnimation(compileBedrockAnimations(documents), poser)?.sample(0) || null
}

async function pokemonAnimationResources(stack, variation, resolverPath, species = '') {
    const sourceNamespace = resolverPath.match(/^assets\/([^/]+)\//)?.[1] || 'cobblemon'
    const poserId = splitId(variation?.poser || splitId(species, 'cobblemon').path, sourceNamespace)
    const folder = poserId.path || resolverPath.match(/resolvers\/([^/]+)\//)?.[1] || splitId(species, 'cobblemon').path.split('/').at(-1)
    const poserPath = `assets/${poserId.namespace}/bedrock/pokemon/posers/${folder}.json`
    const poser = await stack.getJson(poserPath)
    const provenancePaths = [resolverPath, variation?.modelSourcePath, variation?.textureSourcePath, variation?.poserSourcePath].filter(Boolean)
    const namespaces = [...new Set([
        poserId.namespace,
        sourceNamespace,
        splitId(variation?.model, sourceNamespace).namespace,
        ...provenancePaths.map(value => String(value).match(/^assets\/([^/]+)\//)?.[1]).filter(Boolean)
    ])]
    const folders = [...new Set([
        splitId(species, 'cobblemon').path.split('/').at(-1),
        folder,
        ...provenancePaths.map(value => String(value).match(/resolvers\/([^/]+)\//)?.[1]).filter(Boolean)
    ].filter(Boolean))]
    const documents = []
    for(const namespace of namespaces) {
        for(const animationFolder of folders) {
            const prefix = `assets/${namespace}/bedrock/pokemon/animations/${animationFolder}/`
            for(const candidate of await stack.list(prefix)) {
                if(!candidate.endsWith('.json')) continue
                const document = await stack.getJson(candidate)
                if(document?.animations) documents.push(document)
            }
        }
    }
    const compiled = compileBedrockAnimations(documents)
    return {
        poser,
        documents,
        animations: selectableBedrockAnimations(compiled, poser),
        staticPose: selectStaticBedrockAnimation(compiled, poser)?.sample(0) || null
    }
}

function staticHiddenBones(geometry) {
    const geometries = Array.isArray(geometry?.['minecraft:geometry']) ? geometry['minecraft:geometry'] : []
    const names = new Set(geometries.flatMap(value => (value?.bones || []).map(bone => String(bone?.name || ''))))
    const hidden = []
    if(names.has('mouth_closed') && names.has('mouth_open')) hidden.push('mouth_open')
    for(const side of ['left', 'right']) {
        if(names.has(`eye_${side}`) && names.has(`eyelid_${side}`)) hidden.push(`eyelid_${side}`)
    }
    return hidden
}

async function pokemonResources(subject, stack) {
    if(!stack || typeof stack.list !== 'function') throw new Error('The active resource stack cannot discover Cobblemon resolvers.')
    const namespaces = [...new Set([
        'cobblemon',
        subject.resourceNamespace,
        ...(subject.resourceNamespaces || [])
    ].filter(Boolean).map(value => String(value).toLowerCase()))]
    const resolverPaths = []
    for(const namespace of namespaces) resolverPaths.push(...await stack.list(`assets/${namespace}/bedrock/pokemon/resolvers/`))
    const documents = []
    let sourcePath = ''
    for(const candidate of resolverPaths) {
        if(!candidate.endsWith('.json')) continue
        const document = await stack.getJson(candidate)
        const species = String(document?.species || '').includes(':') ? document.species : `cobblemon:${document?.species || ''}`
        if(species === subject.species) { documents.push({ ...document, __sourcePath: candidate }); sourcePath ||= candidate }
    }
    const aspects = [...new Set([
        ...(Array.isArray(subject.aspects) ? subject.aspects : []),
        subject.form,
        subject.gender?.toLowerCase()
    ].filter(Boolean).map(value => String(value).toLowerCase()))]
    if(aspects.includes('shiny')) {
        const required = new Set(aspects)
        const hasShinyVariation = documents.some(document => (document.variations || []).some(variation => {
            const values = (variation?.aspects || []).map(value => String(value).toLowerCase())
            return values.includes('shiny') && values.every(value => required.has(value))
        }))
        if(!hasShinyVariation) throw Object.assign(new Error(`No shiny variation is available for ${subject.species} in this form.`), { code: 'shiny_unavailable' })
    }
    let variation = selectResolverVariation(documents, aspects) || selectResolverVariation(documents, [])
    if(!variation?.model || !variation?.texture) {
        const fallbackAspectSets = [...new Map(documents.flatMap(document => (document.variations || []).map(candidate => {
            const values = [...new Set((candidate.aspects || []).map(value => String(value).toLowerCase()))].sort()
            return [values.join('+'), values]
        }))).values()].sort((left, right) => {
            const leftShiny = left.includes('shiny') ? 1 : 0
            const rightShiny = right.includes('shiny') ? 1 : 0
            return leftShiny - rightShiny || left.length - right.length || left.join('+').localeCompare(right.join('+'))
        })
        for(const fallbackAspects of fallbackAspectSets) {
            const candidate = selectResolverVariation(documents, fallbackAspects)
            if(candidate?.model && candidate?.texture) { variation = candidate; break }
        }
    }
    if(!variation?.model || !variation?.texture) throw new Error(`No supported static resolver variation was found for ${subject.species}.`)
    sourcePath = variation.sourcePath || sourcePath
    const modelSourcePath = variation.modelSourcePath || sourcePath
    const geometry = await stack.getJson(resourcePath(variation.model, 'model', modelSourcePath, subject.species))
    const texture = await stack.getBuffer(resourcePath(variation.texture, 'texture'))
    if(!geometry || !texture) throw new Error(`The static model or texture for ${subject.species} is unavailable.`)
    const animationResources = await pokemonAnimationResources(stack, variation, sourcePath, subject.species)
    return {
        geometry,
        texture,
        variation,
        poser: animationResources.poser,
        animations: animationResources.animations,
        pose: animationResources.staticPose,
        hiddenBones: staticHiddenBones(geometry),
        shinyAvailable: documents.some(document => (document.variations || []).some(variation => {
            const values = (variation?.aspects || []).map(value => String(value).toLowerCase())
            const required = new Set(aspects.filter(value => value !== 'shiny'))
            return values.includes('shiny') && values.filter(value => value !== 'shiny').every(value => required.has(value))
        }))
    }
}

function subjectKey(subject) {
    const aspects = [...new Set((subject?.aspects || []).map(value => String(value).toLowerCase()).filter(value => value !== 'shiny'))].sort().join('+')
    return subject?.kind === 'block' ? `block:${subject.id}` : `pokemon:${subject?.species}:${aspects || subject?.form || ''}:${subject?.gender || ''}`
}

function normalizeSubjects(resources, showcase) {
    const values = [...(resources || []), ...(showcase?.subjects || [])]
    const unique = new Map()
    for(const subject of values) {
        if(!subject || !['block', 'pokemon'].includes(subject.kind)) continue
        const normalized = subject.kind === 'pokemon'
            ? { ...subject, aspects: [...new Set((subject.aspects || []).map(value => String(value).toLowerCase()).filter(value => value !== 'shiny'))].sort() }
            : { ...subject }
        if(subject.kind === 'pokemon' && (subject.shiny === true || (subject.aspects || []).includes('shiny'))) normalized.shiny = true
        const key = subjectKey(normalized)
        unique.set(key, { ...(unique.get(key) || {}), ...normalized })
    }
    return [...unique.values()].sort((left, right) => {
        const kind = left.kind.localeCompare(right.kind)
        return kind || label(left.id || left.species).localeCompare(label(right.id || right.species))
    })
}

function rendererGroup(renderers) {
    const values = renderers.filter(Boolean)
    const animationSource = () => [...values].reverse().find(renderer => renderer.getAnimationOptions?.().length)
    return {
        fit() { for(const renderer of values) renderer.fit?.() },
        render() { for(const renderer of values) renderer.render?.() },
        resize(size) { for(const renderer of values) renderer.resize?.(size) },
        getAnimationOptions() { return animationSource()?.getAnimationOptions?.() || [] },
        getAnimationId() { return animationSource()?.getAnimationId?.() || '' },
        isPlaying() { return animationSource()?.isPlaying?.() ?? false },
        setAnimation(id) { for(const renderer of values) renderer.setAnimation?.(id) },
        setPlaying(value) { for(const renderer of values) renderer.setPlaying?.(value) },
        supportsShiny() { return values.length > 0 && values.every(renderer => renderer.supportsShiny?.()) },
        getState() { return values.map(renderer => renderer.getState?.() || null) },
        setState(state) { values.forEach((renderer, index) => renderer.setState?.(state?.[index])) },
        members() { return [...values] },
        destroy() { for(const renderer of values.splice(0)) renderer.destroy?.() }
    }
}

class ResourcePackCommunityPreview {
    constructor(options) {
        this.host = options.host; this.baseStack = options.resourceStack; this.overlayBytes = options.overlayBytes
        this.showcase = options.showcase || { schemaVersion: 1, subjects: [] }; this.renderBlock = options.renderBlock
        this.sidebarHost = options.sidebarHost || null; this.subjects = normalizeSubjects(options.resources, this.showcase)
        this.showResourceBrowser = options.showResourceBrowser !== false
        this.compact = options.compact === true
        const featuredKey = subjectKey(this.showcase.subjects?.[0])
        this.mode = 'pack'; this.subjectIndex = Math.max(0, this.subjects.findIndex(subject => subjectKey(subject) === featuredKey)); this.query = ''; this.activeRenderer = null; this.destroyed = false
        this.renderGeneration = 0; this.listeners = []
        this.overlayProvider = this.overlayBytes ? new ZipBufferResourceProvider(this.overlayBytes) : null
        this.packProvider = options.artifact ? new ZipBufferResourceProvider(options.artifact, {
            maxBytes: 100 * 1024 * 1024,
            maxEntries: 10_000,
            maxExpandedBytes: 512 * 1024 * 1024
        }) : this.overlayProvider
        this.packStack = this.packProvider ? createResourceStack([this.packProvider, this.baseStack]) : this.baseStack
        if(options.artifact || this.overlayBytes) {
            const bytes = options.artifact || this.overlayBytes
            this.packStack.cacheKey = `community-pack:${crypto.createHash('sha256').update(bytes).digest('hex')}`
        }
        const featured = this.subjects[this.subjectIndex]
        this.shinyEnabled = featured?.shiny === true || featured?.defaultShiny === true
        this.shinySupported = false
    }

    listen(target, event, handler, options) {
        target.addEventListener(event, handler, options)
        this.listeners.push(() => target.removeEventListener(event, handler, options))
    }

    mount() {
        this.host.replaceChildren(); this.host.className = `communityRichView communityResourcePackView${this.compact ? ' isCompact' : ''}`
        const toolbar = document.createElement('div'); toolbar.className = 'communityRichToolbar communityPackToolbar'
        this.toggle = document.createElement('div'); this.toggle.className = 'communitySegmentedControl communityPackModeControl'; this.toggle.setAttribute('aria-label', 'Resource comparison mode')
        for(const mode of ['compare', 'base', 'pack']) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label(mode); button.dataset.mode = mode
            this.listen(button, 'click', () => { this.mode = mode; this.updateToggle(); this.renderSubject() })
            this.toggle.append(button)
        }
        this.animationTools = document.createElement('div'); this.animationTools.className = 'communityPackAnimationTools'; this.animationTools.hidden = true
        this.shinyToggle = document.createElement('button'); this.shinyToggle.type = 'button'; this.shinyToggle.className = 'communityPackShinyToggle'; this.shinyToggle.textContent = 'Shiny'; this.shinyToggle.hidden = true
        this.shinyToggle.setAttribute('aria-label', 'Toggle shiny PokÃ©mon appearance')
        this.listen(this.shinyToggle, 'click', () => {
            if(this.shinyToggle.disabled) return
            this.shinyEnabled = !this.shinyEnabled
            this.updateShinyControl()
            this.applyShinyAppearance()
        })
        const animationLabel = document.createElement('label'); animationLabel.textContent = 'Animation'
        this.animationSelect = document.createElement('select'); this.animationSelect.setAttribute('aria-label', 'Pokémon preview animation')
        this.playPause = document.createElement('button'); this.playPause.type = 'button'; this.playPause.dataset.action = 'animation-playback'
        animationLabel.append(this.animationSelect); this.animationTools.append(animationLabel, this.playPause)
        this.listen(this.animationSelect, 'change', () => {
            this.activeRenderer?.setAnimation?.(this.animationSelect.value)
            this.updateAnimationControls()
        })
        this.listen(this.playPause, 'click', () => {
            this.activeRenderer?.setPlaying?.(!this.activeRenderer?.isPlaying?.())
            this.updateAnimationControls()
        })
        const fit = document.createElement('button'); fit.type = 'button'; fit.textContent = 'Fit'; fit.dataset.action = 'fit'
        this.listen(fit, 'click', () => { this.activeRenderer?.fit?.(); this.activeRenderer?.render?.() })
        toolbar.append(this.toggle, this.shinyToggle, this.animationTools, fit)
        this.stage = document.createElement('div'); this.stage.className = 'communityModelStage communityPackStage'
        this.status = document.createElement('p'); this.status.className = 'communityRichNote'; this.status.setAttribute('role', 'status')
        this.host.append(toolbar, this.stage, this.status)
        if(this.showResourceBrowser) this.mountResourceBrowser()
        this.updateToggle(); this.renderResourceList(); this.renderSubject()
        return this
    }

    mountResourceBrowser() {
        this.browser = document.createElement('section'); this.browser.className = 'communityPackResourceBrowser'
        const heading = document.createElement('h3'); heading.textContent = 'Pack resources'
        this.search = document.createElement('input'); this.search.type = 'search'; this.search.className = 'communityPackResourceSearch'; this.search.placeholder = 'Search blocks and Pokémon'; this.search.setAttribute('aria-label', 'Search Resource Pack preview resources')
        this.count = document.createElement('p'); this.count.className = 'communityPackResourceCount'
        this.resourceList = document.createElement('div'); this.resourceList.className = 'communityPackResourceList'; this.resourceList.setAttribute('role', 'listbox'); this.resourceList.setAttribute('aria-label', 'Renderable resources in this pack')
        this.listen(this.search, 'input', () => { this.query = this.search.value.trim().toLowerCase(); this.renderResourceList({ resetScroll: true }) })
        this.listen(this.resourceList, 'click', event => {
            const button = event.target.closest?.('.communityPackResourceItem')
            if(!button || !this.resourceList.contains(button)) return
            const index = this.subjects.findIndex(subject => subjectKey(subject) === button.dataset.subjectKey)
            if(index < 0 || index === this.subjectIndex) return
            const previous = this.subjects[this.subjectIndex]
            const next = this.subjects[index]
            this.subjectIndex = index
            if(next?.defaultShiny === true) this.shinyEnabled = true
            this.updateResourceSelection(); this.renderSubject({ preserveState: previous?.species === next?.species })
        })
        this.browser.append(heading, this.search, this.count, this.resourceList)
        if(this.sidebarHost) {
            this.sidebarHost.replaceChildren(this.browser); this.sidebarHost.hidden = false
        } else {
            this.host.append(this.browser)
        }
    }

    updateResourceSelection() {
        if(!this.resourceList) return
        const selectedKey = subjectKey(this.subjects[this.subjectIndex])
        for(const button of this.resourceList.querySelectorAll('.communityPackResourceItem')) {
            button.setAttribute('aria-selected', String(button.dataset.subjectKey === selectedKey))
        }
    }

    renderResourceList(options = {}) {
        if(!this.resourceList) return
        const restoreScroll = captureScrollPosition(this.resourceList, { reset: options.resetScroll })
        const selected = this.subjects[this.subjectIndex]
        const filtered = this.subjects.filter(subject => {
            const haystack = `${subject.kind} ${subject.id || subject.species || ''} ${label(subject.id || subject.species)} ${(subject.aspects || []).join(' ')} ${subject.variantLabel || ''}`.toLowerCase()
            return !this.query || haystack.includes(this.query)
        })
        this.resourceList.replaceChildren()
        for(const subject of filtered) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'communityPackResourceItem'; button.setAttribute('role', 'option')
            button.dataset.subjectKey = subjectKey(subject); button.setAttribute('aria-selected', String(subjectKey(subject) === subjectKey(selected)))
            const kind = document.createElement('span'); kind.className = 'communityPackResourceKind'; kind.textContent = subject.kind === 'block' ? 'Block' : 'Pokémon'
            if(subject.kind === 'pokemon' && subject.pokemonOverride?.scope) {
                const scope = document.createElement('span'); scope.className = 'communityPackResourceScope'
                scope.dataset.scope = subject.pokemonOverride.scope
                scope.textContent = subject.pokemonOverride.scope === 'full' ? 'Full' : 'Partial'
                kind.append(scope)
            }
            const variant = subject.variantLabel || (subject.aspects?.length ? subject.aspects.filter(value => value !== 'shiny').map(label).join(' + ') : '')
            const name = document.createElement('strong'); name.textContent = `${label(subject.id || subject.species)}${variant && variant !== 'Default' ? ` · ${variant}` : ''}`
            const id = document.createElement('code'); id.textContent = subject.id || subject.species
            button.append(kind, name, id)
            this.resourceList.append(button)
        }
        if(filtered.length === 0) {
            const empty = document.createElement('p'); empty.className = 'communityPackResourceEmpty'; empty.textContent = 'No resources match this search.'; this.resourceList.append(empty)
        }
        this.count.textContent = this.query ? `${filtered.length} of ${this.subjects.length} resources` : `${this.subjects.length} resources`
        restoreScroll()
    }

    updateToggle() { for(const button of this.toggle.children) button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode)) }

    updateAnimationControls() {
        if(!this.animationTools) return
        const subject = this.subjects[this.subjectIndex]
        const animations = subject?.kind === 'pokemon' ? this.activeRenderer?.getAnimationOptions?.() || [] : []
        this.animationTools.hidden = animations.length === 0
        this.animationSelect.replaceChildren(...animations.map(animation => {
            const option = document.createElement('option'); option.value = animation.id; option.textContent = animation.label; return option
        }))
        const selected = this.activeRenderer?.getAnimationId?.()
        if(selected && animations.some(animation => animation.id === selected)) this.animationSelect.value = selected
        const playing = this.activeRenderer?.isPlaying?.() ?? false
        this.playPause.textContent = playing ? 'Pause' : 'Play'
        this.playPause.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} Pokémon animation`)
    }

    updateShinyControl() {
        if(!this.shinyToggle) return
        const subject = this.subjects[this.subjectIndex]
        this.shinyToggle.hidden = subject?.kind !== 'pokemon'
        this.shinyToggle.disabled = subject?.kind !== 'pokemon' || !this.shinySupported
        this.shinyToggle.setAttribute('aria-pressed', String(this.shinyEnabled && this.shinySupported))
        this.shinyToggle.title = this.shinySupported ? 'Show the shiny appearance' : 'This form has no resolvable shiny variation.'
    }

    activeSubject() {
        const subject = this.subjects[this.subjectIndex]
        if(subject?.kind !== 'pokemon' || !this.shinyEnabled) return subject
        return { ...subject, shiny: true, aspects: [...new Set([...(subject.aspects || []), 'shiny'])].sort() }
    }

    async applyShinyAppearance() {
        const generation = ++this.renderGeneration
        const subject = this.activeSubject()
        const members = this.activeRenderer?.members?.() || (this.activeRenderer ? [this.activeRenderer] : [])
        if(subject?.kind !== 'pokemon' || members.length === 0) return this.renderSubject({ preserveState: true })
        try {
            const replacements = await Promise.all(members.map(renderer => pokemonResources(subject, renderer.previewMode === 'base' ? this.baseStack : this.packStack)))
            if(this.destroyed || generation !== this.renderGeneration) return
            if(!members.every((renderer, index) => renderer.canUpdateAppearance?.(replacements[index]))) return this.renderSubject({ preserveState: true })
            await Promise.all(members.map((renderer, index) => renderer.updateAppearance(replacements[index])))
            if(this.destroyed || generation !== this.renderGeneration) return
            this.shinySupported = members.every(renderer => renderer.supportsShiny?.())
            this.updateShinyControl(); this.updateAnimationControls()
        } catch(error) {
            if(this.destroyed || generation !== this.renderGeneration) return
            if(error?.code === 'shiny_unavailable' && this.shinyEnabled) this.shinyEnabled = false
            return this.renderSubject({ preserveState: true })
        }
    }

    comparisonPane(mode) {
        const pane = document.createElement('section'); pane.className = 'communityPackComparisonPane'; pane.dataset.mode = mode
        const heading = document.createElement('h3'); heading.textContent = mode === 'base' ? 'Base' : 'Pack'
        const view = document.createElement('div'); view.className = 'communityPackComparisonView'
        const note = document.createElement('p'); note.className = 'communityPackPaneStatus'; note.setAttribute('role', 'status'); note.hidden = true
        pane.append(heading, view, note)
        return { pane, view, note }
    }

    async renderSingle(subject, mode, target, generation, allowConcurrent = false) {
        const stack = mode === 'pack' ? this.packStack : this.baseStack
        if(subject.kind === 'block') {
            if(typeof this.renderBlock !== 'function') throw new Error('Minecraft block rendering is unavailable.')
            const renderer = await this.renderBlock({ host: target, subject, resourceStack: stack })
            if(this.destroyed || generation !== this.renderGeneration) { renderer?.destroy?.(); return null }
            return renderer
        }
        if(mode === 'pack' && !this.packProvider) throw new Error('The validated Resource Pack is unavailable.')
        const resources = await pokemonResources(subject, stack)
        if(this.destroyed || generation !== this.renderGeneration) return null
        const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', `Rotatable ${label(subject.species)} ${label(mode)} preview`); target.append(canvas)
        const viewer = new AnimatedPokemonPreview(canvas, resources, { defaultYaw: -1.15, fitPadding: 1.9, allowConcurrent, maxConcurrent: 2 })
        viewer.previewMode = mode
        try {
            await viewer.initialize()
        } catch(error) {
            viewer.destroy()
            throw error
        }
        if(this.destroyed || generation !== this.renderGeneration) { viewer.destroy(); return null }
        return viewer
    }

    async renderSubject(options = {}) {
        const generation = ++this.renderGeneration
        const retainedState = options.preserveState ? this.activeRenderer?.getState?.() : null
        this.animationTools.hidden = true
        this.activeRenderer?.destroy?.(); this.activeRenderer = null; this.stage.replaceChildren(); this.status.textContent = 'Loading preview…'; delete this.status.dataset.state
        const subject = this.activeSubject()
        if(!subject) { this.status.textContent = 'This pack has no renderable resources.'; return }
        try {
            if(this.mode === 'compare') {
                this.stage.classList.add('isCompare')
                const base = this.comparisonPane('base'); const pack = this.comparisonPane('pack')
                this.stage.append(base.pane, pack.pane)
                const renderers = []
                for(const value of [base, pack]) {
                    try {
                        const renderer = await this.renderSingle(subject, value.pane.dataset.mode, value.view, generation, true)
                        if(renderer) renderers.push(renderer)
                    } catch(error) {
                        value.note.textContent = error.message; value.note.dataset.state = 'fallback'; value.note.hidden = false
                    }
                }
                if(this.destroyed || generation !== this.renderGeneration) { rendererGroup(renderers).destroy(); return }
                if(renderers.length === 0) throw new Error('Neither comparison view could render this resource.')
                this.activeRenderer = rendererGroup(renderers)
            } else {
                this.stage.classList.remove('isCompare')
                this.activeRenderer = await this.renderSingle(subject, this.mode, this.stage, generation)
                if(!this.activeRenderer) return
            }
            this.status.textContent = INTERACTION_GUIDANCE
            const activeMembers = this.activeRenderer?.members?.() || (this.activeRenderer ? [this.activeRenderer] : [])
            this.shinySupported = subject.kind === 'pokemon'
                && this.activeRenderer?.supportsShiny?.() === true
                && (this.mode !== 'compare' || activeMembers.length === 2)
            if(this.shinyEnabled && !this.shinySupported) {
                this.shinyEnabled = false
                this.updateShinyControl()
                return this.renderSubject({ preserveState: true })
            }
            this.activeRenderer?.setState?.(retainedState)
            this.updateAnimationControls()
            this.updateShinyControl()
            this.activeRenderer.resize?.(this.lastSize)
        } catch(error) {
            if(this.destroyed || generation !== this.renderGeneration) return
            if(error?.code === 'shiny_unavailable' && this.shinyEnabled) {
                this.shinyEnabled = false; this.updateShinyControl(); return this.renderSubject({ preserveState: true })
            }
            this.status.textContent = `Interactive preview unavailable: ${error.message}`; this.status.dataset.state = 'fallback'
        }
    }

    update(options = {}) {
        if(options.showcase) this.showcase = options.showcase
        if(options.resources || options.showcase) this.subjects = normalizeSubjects(options.resources || this.subjects, this.showcase)
        this.subjectIndex = Math.min(this.subjectIndex, Math.max(0, this.subjects.length - 1)); this.renderResourceList()
        return this.renderSubject()
    }
    resize(size) { this.lastSize = size; this.activeRenderer?.resize?.(size); this.activeRenderer?.render?.() }
    cancel() { this.renderGeneration += 1; this.activeRenderer?.destroy?.(); this.activeRenderer = null }
    destroy() {
        this.destroyed = true; this.cancel(); this.listeners.splice(0).forEach(remove => remove())
        if(this.sidebarHost) { this.sidebarHost.replaceChildren(); this.sidebarHost.hidden = true }
        this.host.replaceChildren()
    }
}

module.exports = {
    ResourcePackCommunityPreview,
    INTERACTION_GUIDANCE,
    normalizeSubjects,
    pokemonAnimationResources,
    pokemonResources,
    rendererGroup,
    resourcePath,
    staticHiddenBones,
    staticRenderPose,
    subjectKey
}
