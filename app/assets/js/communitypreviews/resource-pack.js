'use strict'

/* global document */

const crypto = require('crypto')
const { createResourceStack, ZipBufferResourceProvider } = require('../../../../libraries/minecraft-resources')
const { compileBedrockAnimations, selectableBedrockAnimations, selectResolverVariation } = require('../../../../libraries/community-rendering')
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

async function staticRenderPose(stack, resolverPath, species = '') {
    const namespace = resolverPath.match(/^assets\/([^/]+)\//)?.[1] || 'cobblemon'
    const folder = resolverPath.match(/resolvers\/([^/]+)\//)?.[1] || splitId(species, 'cobblemon').path.split('/').at(-1)
    if(!folder || typeof stack?.list !== 'function') return null
    const prefix = `assets/${namespace}/bedrock/pokemon/animations/${folder}/`
    for(const candidate of await stack.list(prefix)) {
        if(!candidate.endsWith('.json')) continue
        const document = await stack.getJson(candidate)
        const entries = Object.entries(document?.animations || {})
            .filter(([id, animation]) => (id.endsWith('.render') || id.endsWith('.pose')) && animation?.bones && typeof animation.bones === 'object')
            .sort(([left], [right]) => Number(right.endsWith('.render')) - Number(left.endsWith('.render')) || left.localeCompare(right))
        if(entries.length) return entries[0][1]
    }
    return null
}

async function pokemonAnimationResources(stack, variation, resolverPath, species = '') {
    const sourceNamespace = resolverPath.match(/^assets\/([^/]+)\//)?.[1] || 'cobblemon'
    const poserId = splitId(variation?.poser || splitId(species, 'cobblemon').path, sourceNamespace)
    const folder = poserId.path || resolverPath.match(/resolvers\/([^/]+)\//)?.[1] || splitId(species, 'cobblemon').path.split('/').at(-1)
    const poserPath = `assets/${poserId.namespace}/bedrock/pokemon/posers/${folder}.json`
    const poser = await stack.getJson(poserPath)
    const namespaces = [...new Set([poserId.namespace, sourceNamespace, splitId(variation?.model, sourceNamespace).namespace])]
    const documents = []
    for(const namespace of namespaces) {
        const prefix = `assets/${namespace}/bedrock/pokemon/animations/${folder}/`
        for(const candidate of await stack.list(prefix)) {
            if(!candidate.endsWith('.json')) continue
            const document = await stack.getJson(candidate)
            if(document?.animations) documents.push(document)
        }
    }
    return { poser, documents, animations: selectableBedrockAnimations(compileBedrockAnimations(documents), poser) }
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
    const namespaces = [...new Set(['cobblemon', subject.resourceNamespace].filter(Boolean).map(value => String(value).toLowerCase()))]
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
    const aspects = [subject.form, subject.gender?.toLowerCase()].filter(Boolean)
    const variation = selectResolverVariation(documents, aspects) || selectResolverVariation(documents, [])
    if(!variation?.model || !variation?.texture) throw new Error(`No supported static resolver variation was found for ${subject.species}.`)
    sourcePath = variation.sourcePath || sourcePath
    const geometry = await stack.getJson(resourcePath(variation.model, 'model', sourcePath, subject.species))
    const texture = await stack.getBuffer(resourcePath(variation.texture, 'texture'))
    if(!geometry || !texture) throw new Error(`The static model or texture for ${subject.species} is unavailable.`)
    const animationResources = await pokemonAnimationResources(stack, variation, sourcePath, subject.species)
    return {
        geometry,
        texture,
        variation,
        poser: animationResources.poser,
        animations: animationResources.animations,
        pose: await staticRenderPose(stack, sourcePath, subject.species),
        hiddenBones: staticHiddenBones(geometry)
    }
}

function subjectKey(subject) {
    return subject?.kind === 'block' ? `block:${subject.id}` : `pokemon:${subject?.species}:${subject?.form || ''}:${subject?.gender || ''}`
}

function normalizeSubjects(resources, showcase) {
    const values = [...(resources || []), ...(showcase?.subjects || [])]
    const unique = new Map()
    for(const subject of values) {
        if(!subject || !['block', 'pokemon'].includes(subject.kind)) continue
        const key = subjectKey(subject)
        if(!unique.has(key)) unique.set(key, { ...subject })
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
        destroy() { for(const renderer of values.splice(0)) renderer.destroy?.() }
    }
}

class ResourcePackCommunityPreview {
    constructor(options) {
        this.host = options.host; this.baseStack = options.resourceStack; this.overlayBytes = options.overlayBytes
        this.showcase = options.showcase || { schemaVersion: 1, subjects: [] }; this.renderBlock = options.renderBlock
        this.sidebarHost = options.sidebarHost || null; this.subjects = normalizeSubjects(options.resources, this.showcase)
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
    }

    listen(target, event, handler, options) {
        target.addEventListener(event, handler, options)
        this.listeners.push(() => target.removeEventListener(event, handler, options))
    }

    mount() {
        this.host.replaceChildren(); this.host.className = 'communityRichView communityResourcePackView'
        const toolbar = document.createElement('div'); toolbar.className = 'communityRichToolbar communityPackToolbar'
        this.toggle = document.createElement('div'); this.toggle.className = 'communitySegmentedControl communityPackModeControl'; this.toggle.setAttribute('aria-label', 'Resource comparison mode')
        for(const mode of ['compare', 'base', 'pack']) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label(mode); button.dataset.mode = mode
            this.listen(button, 'click', () => { this.mode = mode; this.updateToggle(); this.renderSubject() })
            this.toggle.append(button)
        }
        this.animationTools = document.createElement('div'); this.animationTools.className = 'communityPackAnimationTools'; this.animationTools.hidden = true
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
        toolbar.append(this.toggle, this.animationTools, fit)
        this.stage = document.createElement('div'); this.stage.className = 'communityModelStage communityPackStage'
        this.status = document.createElement('p'); this.status.className = 'communityRichNote'; this.status.setAttribute('role', 'status')
        this.host.append(toolbar, this.stage, this.status)
        this.mountResourceBrowser(); this.updateToggle(); this.renderResourceList(); this.renderSubject()
        return this
    }

    mountResourceBrowser() {
        this.browser = document.createElement('section'); this.browser.className = 'communityPackResourceBrowser'
        const heading = document.createElement('h3'); heading.textContent = 'Pack resources'
        this.search = document.createElement('input'); this.search.type = 'search'; this.search.className = 'communityPackResourceSearch'; this.search.placeholder = 'Search blocks and Pokémon'; this.search.setAttribute('aria-label', 'Search Resource Pack preview resources')
        this.count = document.createElement('p'); this.count.className = 'communityPackResourceCount'
        this.resourceList = document.createElement('div'); this.resourceList.className = 'communityPackResourceList'; this.resourceList.setAttribute('role', 'listbox'); this.resourceList.setAttribute('aria-label', 'Renderable resources in this pack')
        this.listen(this.search, 'input', () => { this.query = this.search.value.trim().toLowerCase(); this.renderResourceList() })
        this.listen(this.resourceList, 'click', event => {
            const button = event.target.closest?.('.communityPackResourceItem')
            if(!button || !this.resourceList.contains(button)) return
            const index = this.subjects.findIndex(subject => subjectKey(subject) === button.dataset.subjectKey)
            if(index < 0 || index === this.subjectIndex) return
            this.subjectIndex = index; this.renderResourceList(); this.renderSubject()
        })
        this.browser.append(heading, this.search, this.count, this.resourceList)
        if(this.sidebarHost) {
            this.sidebarHost.replaceChildren(this.browser); this.sidebarHost.hidden = false
        } else {
            this.host.append(this.browser)
        }
    }

    renderResourceList() {
        if(!this.resourceList) return
        const selected = this.subjects[this.subjectIndex]
        const filtered = this.subjects.filter(subject => {
            const haystack = `${subject.kind} ${subject.id || subject.species || ''} ${label(subject.id || subject.species)}`.toLowerCase()
            return !this.query || haystack.includes(this.query)
        })
        this.resourceList.replaceChildren()
        for(const subject of filtered) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'communityPackResourceItem'; button.setAttribute('role', 'option')
            button.dataset.subjectKey = subjectKey(subject); button.setAttribute('aria-selected', String(subjectKey(subject) === subjectKey(selected)))
            const kind = document.createElement('span'); kind.className = 'communityPackResourceKind'; kind.textContent = subject.kind === 'block' ? 'Block' : 'Pokémon'
            const name = document.createElement('strong'); name.textContent = label(subject.id || subject.species)
            const id = document.createElement('code'); id.textContent = subject.id || subject.species
            button.append(kind, name, id)
            this.resourceList.append(button)
        }
        if(filtered.length === 0) {
            const empty = document.createElement('p'); empty.className = 'communityPackResourceEmpty'; empty.textContent = 'No resources match this search.'; this.resourceList.append(empty)
        }
        this.count.textContent = this.query ? `${filtered.length} of ${this.subjects.length} resources` : `${this.subjects.length} resources`
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
        try {
            await viewer.initialize()
        } catch(error) {
            viewer.destroy()
            throw error
        }
        if(this.destroyed || generation !== this.renderGeneration) { viewer.destroy(); return null }
        return viewer
    }

    async renderSubject() {
        const generation = ++this.renderGeneration
        this.animationTools.hidden = true
        this.activeRenderer?.destroy?.(); this.activeRenderer = null; this.stage.replaceChildren(); this.status.textContent = 'Loading preview…'; delete this.status.dataset.state
        const subject = this.subjects[this.subjectIndex]
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
            this.updateAnimationControls()
            this.activeRenderer.resize?.(this.lastSize)
        } catch(error) {
            if(this.destroyed || generation !== this.renderGeneration) return
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
