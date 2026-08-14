'use strict'

/* global document */

const {
    GraphSpatialIndex,
    fitGraph,
    normalizeAutomationBundle,
    renderGraphCanvas,
    screenToWorld,
    zoomAt
} = require('../../../../libraries/community-rendering')

class AutomationCommunityPreview {
    constructor(options) {
        this.host = options.host
        this.inspectorHost = options.inspectorHost || null
        this.bundle = normalizeAutomationBundle(options.artifact, options.registry || {})
        this.assetIndex = 0
        this.selectedNode = null
        this.camera = { panX: 0, panY: 0, zoom: 1 }
        this.drag = null
        this.destroyed = false
        this.hasMeasuredSize = false
        this.handlers = []
    }

    listen(target, event, listener, options) {
        target.addEventListener(event, listener, options)
        this.handlers.push(() => target.removeEventListener(event, listener, options))
    }

    mount() {
        this.host.replaceChildren()
        this.host.className = 'communityRichView communityAutomationView'
        const header = document.createElement('div')
        header.className = 'communityRichToolbar communityAutomationToolbar'
        this.tabs = document.createElement('div')
        this.tabs.className = 'communityGraphTabs'
        this.tabs.setAttribute('role', 'tablist')
        this.controls = document.createElement('div')
        this.controls.className = 'communityGraphControls'
        const actions = [
            ['fit', 'Fit', () => this.fit()], ['reset', 'Reset', () => this.reset()],
            ['out', '−', () => this.zoom(0.8)], ['in', '+', () => this.zoom(1.25)]
        ]
        for(const [id, label, action] of actions) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.action = id; button.textContent = label
            this.listen(button, 'click', action); this.controls.append(button)
        }
        header.append(this.tabs, this.controls)
        const body = document.createElement('div')
        body.className = 'communityAutomationBody'
        const stage = document.createElement('div')
        stage.className = 'communityGraphStage'
        this.canvas = document.createElement('canvas')
        this.canvas.width = 820; this.canvas.height = 480; this.canvas.tabIndex = 0
        this.canvas.setAttribute('role', 'application')
        this.canvas.setAttribute('aria-label', 'Read-only Automation graph. Drag to pan, use the wheel to zoom, and press F to fit.')
        stage.append(this.canvas)
        this.inspector = document.createElement('aside')
        this.inspector.className = 'communityGraphInspector'
        this.inspector.setAttribute('aria-live', 'polite')
        if(this.inspectorHost){
            this.host.classList.add('hasExternalInspector')
            this.inspectorHost.replaceChildren(this.inspector)
            this.inspectorHost.hidden = false
            body.append(stage)
        } else {
            body.append(stage, this.inspector)
        }
        this.summary = document.createElement('p')
        this.summary.className = 'communityAccessibleSummary'
        this.host.append(header, body, this.summary)
        this.renderTabs()
        this.bindCanvas()
        this.activate(0)
        return this
    }

    renderTabs() {
        this.tabs.replaceChildren()
        this.bundle.assets.forEach((asset, index) => {
            const button = document.createElement('button')
            button.type = 'button'; button.role = 'tab'; button.textContent = asset.name
            button.setAttribute('aria-selected', String(index === this.assetIndex))
            this.listen(button, 'click', () => this.activate(index))
            this.tabs.append(button)
        })
    }

    bindCanvas() {
        this.listen(this.canvas, 'pointerdown', event => {
            const point = this.eventPoint(event)
            this.drag = { x: point.x, y: point.y, cameraX: this.camera.panX, cameraY: this.camera.panY }
            this.canvas.setPointerCapture?.(event.pointerId)
        })
        this.listen(this.canvas, 'pointermove', event => {
            if(!this.drag) return
            const point = this.eventPoint(event)
            this.camera.panX = this.drag.cameraX - (point.x - this.drag.x) / this.camera.zoom
            this.camera.panY = this.drag.cameraY - (point.y - this.drag.y) / this.camera.zoom
            this.render()
        })
        this.listen(this.canvas, 'pointerup', event => {
            const point = this.eventPoint(event)
            if(this.drag && Math.hypot(point.x - this.drag.x, point.y - this.drag.y) < 5 * point.scale) this.selectAt(point.x, point.y)
            this.drag = null
        })
        this.listen(this.canvas, 'pointercancel', () => { this.drag = null })
        this.listen(this.canvas, 'wheel', event => {
            event.preventDefault()
            const rect = this.canvas.getBoundingClientRect()
            const scaleX = this.canvas.width / Math.max(1, rect.width); const scaleY = this.canvas.height / Math.max(1, rect.height)
            this.camera = zoomAt(this.camera, event.deltaY < 0 ? 1.12 : 0.89, (event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY)
            this.render()
        }, { passive: false })
        this.listen(this.canvas, 'keydown', event => {
            const amount = 48 / this.camera.zoom
            if(event.key === 'ArrowLeft') this.camera.panX -= amount
            else if(event.key === 'ArrowRight') this.camera.panX += amount
            else if(event.key === 'ArrowUp') this.camera.panY -= amount
            else if(event.key === 'ArrowDown') this.camera.panY += amount
            else if(event.key === '+' || event.key === '=') this.zoom(1.25)
            else if(event.key === '-') this.zoom(0.8)
            else if(event.key.toLowerCase() === 'f') this.fit()
            else if(event.key === '0') this.reset()
            else return
            event.preventDefault(); this.render()
        })
    }

    eventPoint(event) {
        const rect = this.canvas.getBoundingClientRect()
        const scaleX = this.canvas.width / Math.max(1, rect.width)
        const scaleY = this.canvas.height / Math.max(1, rect.height)
        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY,
            scale: Math.max(scaleX, scaleY)
        }
    }

    activate(index) {
        this.assetIndex = Math.max(0, Math.min(this.bundle.assets.length - 1, index))
        this.asset = this.bundle.assets[this.assetIndex]
        this.spatialIndex = new GraphSpatialIndex(this.asset.nodes)
        this.selectedNode = null
        ;[...this.tabs.children].forEach((button, position) => button.setAttribute('aria-selected', String(position === this.assetIndex)))
        this.fit(); this.renderInspector()
        this.summary.textContent = `${this.asset.name}: ${this.asset.nodes.length} nodes and ${this.asset.edges.length} connections. Authored positions are preserved.`
    }

    fit() { this.camera = fitGraph(this.asset?.bounds, this.canvas?.width || 820, this.canvas?.height || 480, 48); this.render() }
    reset() { this.camera = { panX: 0, panY: 0, zoom: 1 }; this.render() }
    zoom(factor) { this.camera = zoomAt(this.camera, factor, this.canvas.width / 2, this.canvas.height / 2); this.render() }

    selectAt(x, y) {
        const point = screenToWorld(this.camera, x, y)
        const matches = this.spatialIndex.query({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y })
            .filter(node => point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height)
        this.selectedNode = matches.at(-1) || null
        this.renderInspector(); this.render()
    }

    renderInspector() {
        this.inspector.replaceChildren()
        const heading = document.createElement('h3')
        heading.textContent = this.selectedNode?.title || 'Select a node'
        this.inspector.append(heading)
        if(!this.selectedNode) { const hint = document.createElement('p'); hint.textContent = 'Choose a node to inspect its read-only parameters and connected pins.'; this.inspector.append(hint); return }
        const type = document.createElement('code'); type.textContent = this.selectedNode.type; this.inspector.append(type)
        const parameters = document.createElement('dl')
        for(const [key, value] of Object.entries(this.selectedNode.parameters || {})) {
            const term = document.createElement('dt'); term.textContent = key
            const description = document.createElement('dd'); description.textContent = String(value)
            parameters.append(term, description)
        }
        const incoming = this.asset.edges.filter(edge => edge.toNode === this.selectedNode.id)
        const outgoing = this.asset.edges.filter(edge => edge.fromNode === this.selectedNode.id)
        const connections = document.createElement('p'); connections.textContent = `${incoming.length} incoming · ${outgoing.length} outgoing connections`
        this.inspector.append(parameters, connections)
    }

    render() {
        if(this.destroyed || !this.asset) return
        renderGraphCanvas(this.canvas.getContext('2d'), this.asset, this.camera, {
            spatialIndex: this.spatialIndex,
            selectedNodeId: this.selectedNode?.id,
            width: this.canvas.width,
            height: this.canvas.height
        })
    }

    resize(size) {
        if(this.destroyed || !this.canvas) return
        const rect = this.canvas.getBoundingClientRect()
        const scale = Math.max(1, Math.min(2, Number(size?.devicePixelRatio) || 1))
        const width = Math.max(1, Math.round(rect.width * scale))
        const height = Math.max(1, Math.round(rect.height * scale))
        if(width === this.canvas.width && height === this.canvas.height) return
        if(!this.hasMeasuredSize) {
            this.canvas.width = width
            this.canvas.height = height
            this.hasMeasuredSize = true
            this.camera = fitGraph(this.asset?.bounds, width, height, 48)
            this.render()
            return
        }
        const centre = screenToWorld(this.camera, this.canvas.width / 2, this.canvas.height / 2)
        this.canvas.width = width
        this.canvas.height = height
        this.camera.panX = centre.x - width / (2 * this.camera.zoom)
        this.camera.panY = centre.y - height / (2 * this.camera.zoom)
        this.render()
    }

    update(artifact, options = {}) { this.bundle = normalizeAutomationBundle(artifact, options.registry || {}); this.assetIndex = 0; this.renderTabs(); this.activate(0) }
    cancel() { this.drag = null }
    destroy() {
        this.destroyed = true
        this.cancel()
        this.handlers.splice(0).forEach(remove => remove())
        if(this.inspectorHost){
            this.inspectorHost.replaceChildren()
            this.inspectorHost.hidden = true
        }
        this.host.replaceChildren()
    }
}

module.exports = { AutomationCommunityPreview }
