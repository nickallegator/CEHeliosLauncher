'use strict'

/* global document */

const crypto = require('crypto')
const { createResourceStack, ZipBufferResourceProvider } = require('../../../../libraries/minecraft-resources')
const { parseBedrockGeometry, selectResolverVariation } = require('../../../../libraries/community-rendering')
const { CommunityModelViewer } = require('./model-viewer')

function splitId(value, fallback = 'minecraft') { const parts = String(value || '').split(':'); return parts.length === 2 ? { namespace: parts[0], path: parts[1] } : { namespace: fallback, path: parts[0] } }
function label(value) { return String(value || '').split(':').at(-1).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }

function resourcePath(value, kind, resolverPath = '') {
    const id = splitId(value, 'cobblemon')
    let raw = id.path
    if(kind === 'texture') return `assets/${id.namespace}/${raw.replace(/^assets\/[a-z0-9_.-]+\//, '').replace(/\.png$/i, '')}.png`
    const folder = resolverPath.match(/resolvers\/([^/]+)\//)?.[1]
    raw = raw.replace(/\.geo$/i, '').replace(/\.json$/i, '')
    return `assets/${id.namespace}/bedrock/pokemon/models/${folder ? `${folder}/` : ''}${raw}.geo.json`
}

async function pokemonResources(subject, resolverProvider, stack) {
    const resolverPaths = resolverProvider.list('assets/cobblemon/bedrock/pokemon/resolvers/')
    const documents = []
    let sourcePath = ''
    for(const candidate of resolverPaths) {
        if(!candidate.endsWith('.json')) continue
        const document = resolverProvider.getJson(candidate)
        const species = String(document?.species || '').includes(':') ? document.species : `cobblemon:${document?.species || ''}`
        if(species === subject.species) { documents.push(document); sourcePath ||= candidate }
    }
    const aspects = [subject.form, subject.gender?.toLowerCase()].filter(Boolean)
    const variation = selectResolverVariation(documents, aspects) || selectResolverVariation(documents, [])
    if(!variation?.model || !variation?.texture) throw new Error(`No supported static resolver variation was found for ${subject.species}.`)
    const geometry = await stack.getJson(resourcePath(variation.model, 'model', sourcePath))
    const texture = await stack.getBuffer(resourcePath(variation.texture, 'texture'))
    if(!geometry || !texture) throw new Error(`The static model or texture for ${subject.species} is unavailable.`)
    return { geometry, texture, variation }
}

class ResourcePackCommunityPreview {
    constructor(options) {
        this.host = options.host; this.baseStack = options.resourceStack; this.overlayBytes = options.overlayBytes
        this.showcase = options.showcase || { schemaVersion: 1, subjects: [] }; this.renderBlock = options.renderBlock
        this.mode = 'pack'; this.subjectIndex = 0; this.activeRenderer = null; this.destroyed = false
        this.overlayProvider = this.overlayBytes ? new ZipBufferResourceProvider(this.overlayBytes) : null
        this.packStack = this.overlayProvider ? createResourceStack([this.overlayProvider, this.baseStack]) : this.baseStack
        if(this.overlayBytes) this.packStack.cacheKey = `community-overlay:${crypto.createHash('sha256').update(this.overlayBytes).digest('hex')}`
    }

    mount() {
        this.host.replaceChildren(); this.host.className = 'communityRichView communityResourcePackView'
        const toolbar = document.createElement('div'); toolbar.className = 'communityRichToolbar'
        this.rail = document.createElement('div'); this.rail.className = 'communitySubjectRail'; this.rail.setAttribute('role', 'tablist')
        this.toggle = document.createElement('div'); this.toggle.className = 'communitySegmentedControl'
        for(const mode of ['base', 'pack']) { const button = document.createElement('button'); button.type = 'button'; button.textContent = mode === 'base' ? 'Base' : 'Pack'; button.dataset.mode = mode; button.addEventListener('click', () => { this.mode = mode; this.updateToggle(); this.renderSubject() }); this.toggle.append(button) }
        const fit = document.createElement('button'); fit.type = 'button'; fit.textContent = 'Fit'; fit.addEventListener('click', () => { this.activeRenderer?.fit?.(); this.activeRenderer?.render?.() })
        toolbar.append(this.rail, this.toggle, fit)
        this.stage = document.createElement('div'); this.stage.className = 'communityModelStage communityPackStage'
        this.status = document.createElement('p'); this.status.className = 'communityRichNote'; this.status.setAttribute('role', 'status')
        this.summary = document.createElement('div'); this.summary.className = 'communityPackSummary'
        this.host.append(toolbar, this.stage, this.status, this.summary)
        this.renderRail(); this.updateToggle(); this.renderSummary(); this.renderSubject()
        return this
    }

    renderRail() {
        this.rail.replaceChildren()
        for(const [index, subject] of this.showcase.subjects.entries()) {
            const button = document.createElement('button'); button.type = 'button'; button.role = 'tab'; button.textContent = subject.kind === 'block' ? label(subject.id) : label(subject.species)
            button.setAttribute('aria-selected', String(index === this.subjectIndex)); button.addEventListener('click', () => { this.subjectIndex = index; this.renderRail(); this.renderSubject() })
            this.rail.append(button)
        }
    }

    updateToggle() { for(const button of this.toggle.children) button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode)) }
    renderSummary() {
        const subjects = this.showcase.subjects || []
        this.summary.textContent = subjects.length
            ? `${subjects.filter(value => value.kind === 'block').length} blocks and ${subjects.filter(value => value.kind === 'pokemon').length} Pokémon selected by the publisher.`
            : 'This pack has no renderable showcase subjects. Its static pack image and namespace summary remain available.'
    }

    async renderSubject() {
        this.activeRenderer?.destroy?.(); this.activeRenderer = null; this.stage.replaceChildren(); this.status.textContent = ''
        const subject = this.showcase.subjects[this.subjectIndex]
        if(!subject) { this.status.textContent = 'No interactive subjects were selected for this revision.'; return }
        const stack = this.mode === 'pack' ? this.packStack : this.baseStack
        try {
            if(subject.kind === 'block') {
                if(typeof this.renderBlock !== 'function') throw new Error('Minecraft block rendering is unavailable.')
                this.activeRenderer = await this.renderBlock({ host: this.stage, subject, resourceStack: stack })
            } else {
                if(!this.overlayProvider) throw new Error('The validated Resource Pack preview overlay is unavailable.')
                const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', `Rotatable ${label(subject.species)} Resource Pack preview`); this.stage.append(canvas)
                const resources = await pokemonResources(subject, this.overlayProvider, stack)
                if(this.destroyed) return
                const viewer = new CommunityModelViewer(canvas); await viewer.setModel(parseBedrockGeometry(resources.geometry), resources.texture); this.activeRenderer = viewer
            }
            this.status.textContent = `${this.mode === 'pack' ? 'Pack overlay' : 'Locked base resources'} · drag to rotate and use the wheel to zoom.`
            this.activeRenderer?.resize?.(this.lastSize)
        } catch(error) {
            this.status.textContent = `Interactive preview unavailable: ${error.message}`
            this.status.dataset.state = 'fallback'
        }
    }

    update(options = {}) { if(options.showcase) this.showcase = options.showcase; this.renderRail(); return this.renderSubject() }
    resize(size) { this.lastSize = size; this.activeRenderer?.resize?.(size); this.activeRenderer?.render?.() }
    cancel() { this.activeRenderer?.destroy?.(); this.activeRenderer = null }
    destroy() { this.destroyed = true; this.cancel(); this.host.replaceChildren() }
}

module.exports = { ResourcePackCommunityPreview, pokemonResources, resourcePath }
