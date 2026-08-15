'use strict'

/* global document, Image */

const { Worker } = require('worker_threads')
const path = require('path')
const { loadWorkspaceLibrary } = require('../workspacelibrary')
const { normalizeGradientDocument, sampleGradient } = loadWorkspaceLibrary('community-rendering')
const { resolveBlockTopTexture } = loadWorkspaceLibrary('minecraft-resources')
const { calculatePreviewSize } = require('./resize-observer')

function loadImage(texture) {
    return new Promise((resolve, reject) => {
        if(!texture?.bytes) { resolve(null); return }
        const image = new Image()
        image.onload = () => resolve({ ...texture, image })
        image.onerror = reject
        image.src = `data:image/png;base64,${Buffer.from(texture.bytes).toString('base64')}`
    })
}

function drawCheckerboard(context, x, y, width, height) {
    const size = Math.max(2, Math.min(10, Math.ceil(Math.min(width, height) / 3)))
    for(let row = 0; row < Math.ceil(height / size); row += 1){
        for(let column = 0; column < Math.ceil(width / size); column += 1){
            context.fillStyle = (row + column) % 2 === 0 ? '#6b2f36' : '#d3a15d'
            context.fillRect(x + column * size, y + row * size, size, size)
        }
    }
}

function drawTexture(context, texture, x, y, width, height) {
    if(!texture?.image || !texture?.frame) return false
    const frame = texture.frame
    context.drawImage(texture.image, frame.x, frame.y, frame.width, frame.height, x, y, width, height)
    return true
}

function heatColor(value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0))
    const stops = [[20, 39, 48], [45, 112, 111], [112, 190, 150], [222, 169, 84], [211, 91, 50]]
    const scaled = v * (stops.length - 1)
    const index = Math.min(stops.length - 2, Math.floor(scaled))
    const amount = scaled - index
    const color = stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * amount))
    return `rgb(${color.join(' ')})`
}

class GradientCommunityPreview {
    constructor(options) {
        this.host = options.host
        this.artifact = Buffer.from(options.artifact)
        this.stack = options.resourceStack || null
        this.workerPath = options.workerPath || path.resolve(__dirname, '..', 'communitypreviewworker.js')
        this.model = normalizeGradientDocument(JSON.parse(this.artifact.toString('utf8')))
        this.cells = this.model.previewCells
        this.mode = 'blocks'
        this.requestId = 0
        this.images = new Map()
        this.imagePromises = new Map()
        this.missingTextures = new Map()
        this.textureQueue = []
        this.activeTextureLoads = 0
        this.maxTextureLoads = 6
        this.destroyed = false
    }

    mount() {
        this.host.replaceChildren()
        this.host.className = 'communityRichView communityGradientView'
        const toolbar = document.createElement('div')
        toolbar.className = 'communityRichToolbar'
        const scaleLabel = document.createElement('label')
        scaleLabel.className = 'communityGradientScale'
        this.scaleText = document.createElement('span')
        this.slider = document.createElement('input')
        this.slider.type = 'range'; this.slider.min = '4'; this.slider.max = '64'; this.slider.step = '1'; this.slider.value = String(this.cells)
        scaleLabel.append(this.scaleText, this.slider)
        this.modeGroup = document.createElement('div')
        this.modeGroup.className = 'communitySegmentedControl'
        for(const mode of ['blocks', 'values']) {
            const button = document.createElement('button')
            button.type = 'button'; button.dataset.mode = mode; button.textContent = mode === 'blocks' ? 'Blocks' : 'Values'
            button.addEventListener('click', () => { this.mode = mode; this.updateMode(); this.renderPreparedSample(this.lastSample, this.requestId) })
            this.modeGroup.append(button)
        }
        toolbar.append(scaleLabel, this.modeGroup)
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'communityGradientCanvas'
        this.canvas.width = 640; this.canvas.height = 420
        this.canvas.tabIndex = 0
        this.canvas.setAttribute('role', 'img')
        this.canvas.setAttribute('aria-label', 'Interactive block gradient preview')
        this.swatches = document.createElement('div')
        this.swatches.className = 'communityMaterialSwatches'
        this.status = document.createElement('p')
        this.status.className = 'communityRichNote communityGradientTextureStatus'
        this.status.hidden = true
        this.note = document.createElement('p')
        this.note.className = 'communityRichNote'
        this.note.hidden = !this.model.type.legacyFallback
        this.note.textContent = this.model.type.legacyFallback
            ? `${this.model.type.requested} is a historical type and is rendered as SMOOTH, matching Cobble Power.` : ''
        this.host.append(toolbar, this.canvas, this.status, this.swatches, this.note)
        this.slider.addEventListener('input', () => {
            this.cells = Number(this.slider.value)
            this.updateScaleLabel()
            this.sample()
        })
        this.updateScaleLabel()
        this.updateMode()
        this.renderSwatches()
        this.sample()
        return this
    }

    updateScaleLabel() { this.scaleText.textContent = `${this.cells} × ${this.cells} block area` }
    updateMode() { for(const button of this.modeGroup.children) button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode)) }

    async renderSwatches() {
        this.swatches.replaceChildren()
        for(const pin of this.model.pins) {
            const figure = document.createElement('figure')
            const preview = document.createElement('canvas')
            preview.className = 'communityMaterialSwatch'
            preview.width = 36
            preview.height = 36
            drawCheckerboard(preview.getContext('2d'), 0, 0, 36, 36)
            const label = document.createElement('figcaption')
            label.textContent = `${pin.block.split(':').at(-1).replaceAll('_', ' ')} · ${Math.round(pin.value * 100)}%`
            figure.append(preview, label)
            this.swatches.append(figure)
            try {
                const texture = await this.ensureTexture(pin.block)
                if(texture && !this.destroyed) {
                    const context = preview.getContext('2d')
                    context.clearRect(0, 0, 36, 36)
                    drawTexture(context, texture, 0, 0, 36, 36)
                }
            } catch(_error) { /* checkerboard remains as the explicit missing-texture state */ }
        }
    }

    ensureTexture(blockId) {
        if(this.images.has(blockId)) return Promise.resolve(this.images.get(blockId))
        if(this.missingTextures.has(blockId)) return Promise.reject(this.missingTextures.get(blockId))
        if(this.imagePromises.has(blockId)) return this.imagePromises.get(blockId)
        const promise = new Promise((resolve, reject) => {
            this.textureQueue.push({ blockId, resolve, reject })
            this.drainTextureQueue()
        })
        this.imagePromises.set(blockId, promise)
        return promise
    }

    drainTextureQueue() {
        while(!this.destroyed && this.activeTextureLoads < this.maxTextureLoads && this.textureQueue.length > 0){
            const job = this.textureQueue.shift()
            this.activeTextureLoads += 1
            resolveBlockTopTexture(this.stack, job.blockId)
                .then(loadImage)
                .then(texture => {
                    if(!texture) throw new Error(`Texture unavailable for ${job.blockId}.`)
                    if(this.destroyed) {
                        texture.image.src = ''
                        throw new Error('Gradient preview was closed.')
                    }
                    this.images.set(job.blockId, texture)
                    job.resolve(texture)
                })
                .catch(error => {
                    this.missingTextures.set(job.blockId, error)
                    job.reject(error)
                })
                .finally(() => {
                    this.imagePromises.delete(job.blockId)
                    this.activeTextureLoads -= 1
                    this.drainTextureQueue()
                })
        }
    }

    sample() {
        const requestId = ++this.requestId
        this.worker?.terminate().catch(() => {})
        if(this.fallbackTimer) clearTimeout(this.fallbackTimer)
        let worker
        try { worker = new Worker(this.workerPath) }
        catch(_error) {
            // Some Electron test/single-process configurations intentionally disable
            // worker threads. The maximum grid is only 4,096 samples, so retain a
            // cancellable next-turn fallback rather than making the preview unusable.
            this.worker = null
            this.fallbackTimer = setTimeout(() => {
                this.fallbackTimer = null
                if(this.destroyed || requestId !== this.requestId) return
                try {
                    this.lastSample = sampleGradient(this.artifact, this.cells)
                    this.renderPreparedSample(this.lastSample, requestId)
                } catch(error) { this.renderError(error.message) }
            }, 0)
            return
        }
        this.worker = worker
        worker.once('message', result => {
            worker.terminate().catch(() => {})
            if(this.destroyed || requestId !== this.requestId || result?.requestId !== requestId) return
            if(result.error) { this.renderError(result.error); return }
            this.lastSample = result.sample
            this.renderPreparedSample(result.sample, requestId)
        })
        worker.once('error', error => requestId === this.requestId && this.renderError(error.message))
        worker.postMessage({ action: 'sample-gradient', requestId, cells: this.cells, artifact: this.artifact })
    }

    async renderPreparedSample(sample, requestId) {
        if(!sample || this.destroyed || requestId !== this.requestId) return
        if(this.mode === 'values') {
            this.status.hidden = true
            this.canvas.dataset.textureSource = 'values'
            this.renderSample(sample)
            return
        }
        const required = [...new Set(sample.blocks.filter(Boolean))]
        const unresolved = required.filter(blockId => !this.images.has(blockId) && !this.missingTextures.has(blockId))
        if(unresolved.length > 0){
            this.status.hidden = false
            this.status.textContent = `Loading ${unresolved.length} block texture${unresolved.length === 1 ? '' : 's'}...`
        }
        await Promise.allSettled(required.map(blockId => this.ensureTexture(blockId)))
        if(this.destroyed || requestId !== this.requestId || this.mode !== 'blocks') return
        const missing = required.filter(blockId => this.missingTextures.has(blockId))
        this.status.hidden = missing.length === 0
        this.status.textContent = missing.length > 0
            ? `Missing textures: ${missing.join(', ')}. Repair the selected profile or install its declared dependencies.`
            : ''
        this.canvas.dataset.textureSource = missing.length > 0 ? 'partial' : 'resources'
        this.renderSample(sample)
    }

    renderSample(sample) {
        if(!sample || this.destroyed) return
        const context = this.canvas.getContext('2d')
        context.clearRect(0, 0, this.canvas.width, this.canvas.height)
        context.imageSmoothingEnabled = false
        const size = Math.min(this.canvas.width, this.canvas.height)
        const cell = size / sample.cells
        const offsetX = (this.canvas.width - size) / 2
        for(let y = 0; y < sample.cells; y += 1) for(let x = 0; x < sample.cells; x += 1) {
            const index = y * sample.cells + x
            const px = offsetX + x * cell; const py = y * cell
            if(this.mode === 'blocks') {
                const texture = this.images.get(sample.blocks[index])
                if(!drawTexture(context, texture, px, py, Math.ceil(cell), Math.ceil(cell))) drawCheckerboard(context, px, py, Math.ceil(cell), Math.ceil(cell))
            } else {
                context.fillStyle = heatColor(sample.values[index])
                context.fillRect(px, py, Math.ceil(cell), Math.ceil(cell))
            }
        }
        this.canvas.setAttribute('aria-label', `${sample.model.type.type} gradient at ${sample.cells} by ${sample.cells} blocks in ${this.mode} mode`)
    }

    resize(size) {
        if(this.destroyed || !this.canvas) return
        const rect = this.canvas.getBoundingClientRect()
        const canvasSize = calculatePreviewSize(rect.width, rect.height, size?.devicePixelRatio)
        if(this.canvas.width === canvasSize.pixelWidth && this.canvas.height === canvasSize.pixelHeight) return
        this.canvas.width = canvasSize.pixelWidth
        this.canvas.height = canvasSize.pixelHeight
        if(this.lastSample) this.renderSample(this.lastSample)
    }

    renderError(message) {
        const context = this.canvas.getContext('2d')
        context.fillStyle = '#14201e'; context.fillRect(0, 0, this.canvas.width, this.canvas.height)
        context.fillStyle = '#f2c5b0'; context.font = '16px sans-serif'; context.fillText(message || 'Unable to render gradient.', 24, 42)
    }

    update(artifact) {
        this.artifact = Buffer.from(artifact)
        this.model = normalizeGradientDocument(JSON.parse(this.artifact.toString('utf8')))
        this.renderSwatches()
        this.sample()
    }
    cancel() {
        this.requestId += 1
        if(this.fallbackTimer) clearTimeout(this.fallbackTimer)
        this.fallbackTimer = null
        this.worker?.terminate().catch(() => {})
        this.worker = null
    }
    destroy() {
        this.destroyed = true
        this.cancel()
        for(const texture of this.images.values()) texture.image.src = ''
        this.images.clear()
        this.imagePromises.clear()
        this.textureQueue.splice(0).forEach(job => job.reject(new Error('Gradient preview was closed.')))
        this.host.replaceChildren()
    }
}

module.exports = { GradientCommunityPreview, drawCheckerboard, drawTexture, loadImage }
