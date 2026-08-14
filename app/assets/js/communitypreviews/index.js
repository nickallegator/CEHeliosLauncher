'use strict'

/* global document */

const path = require('path')

const { CommunityArtifactCache } = require('../communityartifactcache')
const { AutomationCommunityPreview } = require('./automation')
const { GradientCommunityPreview } = require('./gradient')
const { ResourcePackCommunityPreview } = require('./resource-pack')
const { TrainerCommunityPreview } = require('./trainer')

class CommunityRichPreviewHost {
    constructor(options = {}) {
        this.container = options.container
        this.fallbackImage = options.fallbackImage || null
        this.client = options.client
        this.headers = options.headers || (() => ({}))
        this.resourceStack = options.resourceStack || (async () => null)
        this.renderBlock = options.renderBlock || null
        this.enabled = options.enabled !== false
        this.registry = options.registry || {}
        this.cache = options.cache || new CommunityArtifactCache({
            directory: options.cacheDirectory || path.resolve(process.cwd(), '.community-preview-cache')
        })
        this.generation = 0
        this.renderer = null
        this.abortController = null
    }

    async artifact(entry, signal) {
        const revision = entry.revision || {}
        const cached = this.cache.get(revision.sha256, revision.sizeBytes)
        if(cached) return cached
        const result = await this.client.download(entry.type, entry.id, { headers: this.headers(), signal })
        this.cache.put(revision.sha256, result.artifact, { sizeBytes: revision.sizeBytes, mimeType: revision.mimeType, role: 'artifact' })
        return result.artifact
    }

    async renderOverlay(entry, signal) {
        if(entry.type !== 'resource-packs') return null
        try {
            const descriptor = await this.client.previewAssets(entry.type, entry.id, { headers: this.headers(), signal })
            const overlay = descriptor.assets.find(asset => asset.role === 'render-overlay')
            if(!overlay) return null
            return (await this.cache.resolve(overlay, this.client.fetch, { signal })).bytes
        } catch(error) {
            if(signal.aborted) throw error
            return null
        }
    }

    async mount(entry) {
        this.destroyRenderer()
        if(!this.enabled || !this.container || !entry?.revision?.sha256 || !['builder-presets', 'automation', 'battle-trainers', 'resource-packs'].includes(entry.type)) return null
        const generation = ++this.generation
        this.abortController = new AbortController()
        this.container.hidden = false
        this.container.replaceChildren()
        this.container.dataset.state = 'loading'
        const status = document.createElement('p'); status.className = 'communityRichLoading'; status.textContent = 'Preparing verified interactive preview…'; this.container.append(status)
        try {
            const [artifact, stack, overlayBytes, registry] = await Promise.all([
                this.artifact(entry, this.abortController.signal),
                this.resourceStack(entry),
                this.renderOverlay(entry, this.abortController.signal),
                typeof this.registry === 'function' ? this.registry(entry, this.abortController.signal) : this.registry
            ])
            if(generation !== this.generation) return null
            const common = { host: this.container, artifact, resourceStack: stack }
            if(entry.type === 'builder-presets') this.renderer = new GradientCommunityPreview({ ...common, workerPath: path.resolve(__dirname, '..', 'communitypreviewworker.js') })
            else if(entry.type === 'automation') this.renderer = new AutomationCommunityPreview({ ...common, registry })
            else if(entry.type === 'battle-trainers') this.renderer = new TrainerCommunityPreview(common)
            else this.renderer = new ResourcePackCommunityPreview({
                ...common,
                overlayBytes,
                showcase: entry.typeData?.showcase || { schemaVersion: 1, subjects: [] },
                renderBlock: this.renderBlock
            })
            this.container.dataset.state = 'ready'
            if(this.fallbackImage) this.fallbackImage.hidden = true
            await this.renderer.mount()
            return this.renderer
        } catch(error) {
            if(generation !== this.generation || this.abortController?.signal.aborted) return null
            this.container.dataset.state = 'fallback'
            this.container.replaceChildren()
            const notice = document.createElement('p'); notice.className = 'communityRichNote'; notice.textContent = `Interactive preview unavailable: ${error.message}`; this.container.append(notice)
            if(this.fallbackImage) this.fallbackImage.hidden = false
            return null
        }
    }

    cancel() { this.generation += 1; this.abortController?.abort(); this.abortController = null; this.renderer?.cancel?.() }
    destroyRenderer() { this.cancel(); this.renderer?.destroy?.(); this.renderer = null; if(this.fallbackImage) this.fallbackImage.hidden = false }
    destroy() { this.destroyRenderer(); this.container?.replaceChildren(); if(this.container) this.container.hidden = true }
}

module.exports = {
    AutomationCommunityPreview,
    CommunityRichPreviewHost,
    GradientCommunityPreview,
    ResourcePackCommunityPreview,
    TrainerCommunityPreview
}
