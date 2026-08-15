'use strict'

/* global document, requestAnimationFrame, cancelAnimationFrame, window */

const { loadWorkspaceLibrary } = require('../workspacelibrary')
const {
    composeBedrockPoses,
    parseBedrockGeometry,
    poserAnimationIds,
    selectDefaultBedrockAnimation
} = loadWorkspaceLibrary('community-rendering')
const { CommunityModelViewer } = require('./model-viewer')

const FRAME_INTERVAL_MS = 1000 / 15

class AnimatedPokemonPreview {
    constructor(canvas, resources, options = {}) {
        this.canvas = canvas
        this.resources = resources
        this.animations = resources.animations || []
        this.baseAnimation = selectDefaultBedrockAnimation(this.animations, resources.poser)
        this.animation = this.baseAnimation
        this.primaryAnimationIds = new Set(poserAnimationIds(resources.poser).map(value => value.toLowerCase()))
        this.playing = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        this.destroyed = false
        this.frameHandle = null
        this.lastFrameAt = 0
        this.startedAt = performance.now()
        this.elapsedSeconds = 0
        this.frameCount = 0
        this.viewer = new CommunityModelViewer(canvas, options)
        this.visibilityHandler = () => {
            if(document.hidden) this.stopFrameLoop()
            else if(this.playing) { this.startedAt = performance.now() - this.elapsedSeconds * 1000; this.startFrameLoop() }
        }
        document.addEventListener('visibilitychange', this.visibilityHandler)
    }

    async initialize() {
        const pose = this.samplePose(0)
        const mesh = parseBedrockGeometry(this.resources.geometry, { pose, hiddenBones: this.resources.hiddenBones })
        this.normalization = mesh.normalization
        await this.viewer.setModel(mesh, this.resources.texture)
        this.updateDataset()
        if(this.playing && this.animation) this.startFrameLoop()
        return this
    }

    getAnimationOptions() {
        return this.animations.map(animation => ({ id: animation.id, label: animation.label }))
    }

    getAnimationId() { return this.animation?.id || '' }
    isPlaying() { return this.playing }
    isLayeredAnimation() {
        return Boolean(this.animation && this.animation !== this.baseAnimation && !this.primaryAnimationIds.has(this.animation.id.toLowerCase()))
    }

    setAnimation(id) {
        const next = this.animations.find(animation => animation.id === id)
        if(!next) return false
        this.animation = next
        this.elapsedSeconds = 0; this.startedAt = performance.now(); this.lastFrameAt = 0
        this.updateFrame(0); this.updateDataset()
        if(this.playing) this.startFrameLoop()
        return true
    }

    setPlaying(value) {
        this.playing = Boolean(value)
        if(this.playing) {
            this.startedAt = performance.now() - this.elapsedSeconds * 1000; this.lastFrameAt = 0; this.startFrameLoop()
        } else {
            this.stopFrameLoop()
        }
        this.updateDataset()
    }

    supportsShiny() { return this.resources.shinyAvailable === true }
    appearanceStructureKey(resources = this.resources) {
        const variation = resources?.variation || {}
        const animations = (resources?.animations || []).map(value => `${value.group || ''}:${value.id || ''}`).sort()
        return JSON.stringify([variation.model || '', variation.poser || '', variation.layers || null, animations])
    }
    canUpdateAppearance(resources) { return this.appearanceStructureKey(resources) === this.appearanceStructureKey() }
    async updateAppearance(resources) {
        if(!this.canUpdateAppearance(resources)) return false
        const updated = await this.viewer.setTexture(resources.texture)
        if(updated === false) return false
        if(this.destroyed) return false
        this.resources = { ...this.resources, ...resources }
        this.updateDataset()
        return true
    }
    getState() {
        return {
            animationId: this.getAnimationId(),
            playing: this.playing,
            camera: this.viewer.getCamera?.() || null
        }
    }
    setState(state) {
        if(!state) return
        if(state.animationId) this.setAnimation(state.animationId)
        this.setPlaying(state.playing)
        this.viewer.setCamera?.(state.camera)
    }

    updateDataset() {
        this.canvas.dataset.animationId = this.getAnimationId()
        this.canvas.dataset.animationPlaying = String(this.playing)
        this.canvas.dataset.animationLayered = String(this.isLayeredAnimation())
        this.canvas.dataset.animationFrame = String(this.frameCount)
    }

    samplePose(timeSeconds) {
        const selected = this.animation?.sample(timeSeconds) || null
        if(!selected) return this.resources.pose || null
        if(!this.isLayeredAnimation()) return selected
        const base = this.baseAnimation?.sample(timeSeconds) || this.resources.pose || null
        return composeBedrockPoses(base, selected)
    }

    updateFrame(timeSeconds) {
        if(this.destroyed || !this.animation) return
        const pose = this.samplePose(timeSeconds)
        const mesh = parseBedrockGeometry(this.resources.geometry, {
            pose,
            hiddenBones: this.resources.hiddenBones,
            normalization: this.normalization
        })
        this.viewer.updateMesh(mesh)
        this.frameCount += 1
        this.updateDataset()
    }

    startFrameLoop() {
        if(this.destroyed || this.frameHandle != null || document.hidden || !this.canvas.isConnected || !this.animation) return
        const tick = now => {
            this.frameHandle = null
            if(this.destroyed || !this.playing || document.hidden || !this.canvas.isConnected) return
            if(now - this.lastFrameAt >= FRAME_INTERVAL_MS) {
                this.lastFrameAt = now
                this.elapsedSeconds = (now - this.startedAt) / 1000
                this.updateFrame(this.elapsedSeconds)
                if(!this.animation.loop && this.elapsedSeconds >= this.animation.length) {
                    this.playing = false; this.updateDataset(); return
                }
            }
            this.frameHandle = requestAnimationFrame(tick)
        }
        this.frameHandle = requestAnimationFrame(tick)
    }

    stopFrameLoop() {
        if(this.frameHandle != null) cancelAnimationFrame(this.frameHandle)
        this.frameHandle = null
    }

    fit() { this.viewer.fit() }
    render() { this.viewer.render() }
    resize(size) { this.viewer.resize(size) }

    destroy() {
        if(this.destroyed) return
        this.destroyed = true
        this.stopFrameLoop()
        document.removeEventListener('visibilitychange', this.visibilityHandler)
        this.viewer.destroy()
    }
}

module.exports = { AnimatedPokemonPreview, FRAME_INTERVAL_MS }
