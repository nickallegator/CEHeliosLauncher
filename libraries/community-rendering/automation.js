'use strict'

const NODE_WIDTH = 180
const NODE_MIN_HEIGHT = 68
const NODE_HEADER_HEIGHT = 32
const NODE_RADIUS = 10
const SPATIAL_CELL_SIZE = 256
const CATEGORY_COLORS = Object.freeze({
    events: '#e0b35f', control: '#a39af6', data: '#63c4c7', actions: '#77d68e', functions: '#ff8aa0', unknown: '#9ec8e6'
})
const PIN_COLORS = Object.freeze({
    exec: '#f2f5f8', boolean: '#e57c7c', number: '#7ed68f', string: '#79c4f2', item_id: '#d9b06b',
    fluid_id: '#63b8f0', entity: '#93a9e9', player_ref: '#7fb5ff', pokemon_ref: '#e29be0',
    hostile_ref: '#d96565', energy_ref: '#f4d35e', any: '#b7c0c9'
})

function humanize(value) {
    return String(value || '').split(':').at(-1).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function normalizeRegistry(registry = {}) {
    const source = Array.isArray(registry.automationNodes) ? registry.automationNodes : []
    return new Map(source.map(value => [String(value.id), {
        id: String(value.id),
        name: String(value.name || humanize(value.id)),
        category: String(value.category || 'unknown'),
        complexity: Number(value.complexity || 1),
        inputs: Array.isArray(value.inputs) ? value.inputs : [],
        outputs: Array.isArray(value.outputs) ? value.outputs : []
    }]))
}

function normalizeAutomationBundle(input, registry = {}) {
    const root = Buffer.isBuffer(input) || ArrayBuffer.isView(input)
        ? JSON.parse(Buffer.from(input.buffer || input, input.byteOffset || 0, input.byteLength).toString('utf8'))
        : input
    const descriptorMap = registry instanceof Map ? registry : normalizeRegistry(registry)
    const sourceAssets = Array.isArray(root?.assets) ? root.assets : []
    const assets = sourceAssets.map((entry, assetIndex) => {
        const document = entry?.document || entry || {}
        const graph = document.graph || {}
        const id = String(entry.id || entry.sourceAssetId || document.metadata?.asset_id || document.operationId || `asset-${assetIndex + 1}`)
        const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).map((source, nodeIndex) => {
            const type = String(source.type || source.blockTypeId || 'unknown:node')
            const descriptor = descriptorMap.get(type)
            const inputs = descriptor?.inputs || []
            const outputs = descriptor?.outputs || []
            const height = Math.max(NODE_MIN_HEIGHT, 48 + Math.max(inputs.length, outputs.length) * 18)
            return {
                id: String(source.id || source.nodeId || `node-${nodeIndex + 1}`),
                type,
                title: descriptor?.name || humanize(type),
                category: descriptor?.category || inferCategory(type),
                inputs,
                outputs,
                parameters: source.parameters && typeof source.parameters === 'object' ? { ...source.parameters } : {},
                x: Number(source.x) || 0,
                y: Number(source.y) || 0,
                width: NODE_WIDTH,
                height
            }
        })
        const nodesById = new Map(nodes.map(node => [node.id, node]))
        const edges = (Array.isArray(graph.edges) ? graph.edges : []).map((source, edgeIndex) => ({
            id: String(source.id || source.edgeId || `edge-${edgeIndex + 1}`),
            fromNode: String(source.fromNode || source.fromNodeId || ''),
            fromPin: String(source.fromPin || ''),
            toNode: String(source.toNode || source.toNodeId || ''),
            toPin: String(source.toPin || ''),
            route: (Array.isArray(source.route) ? source.route : (Array.isArray(source.routePoints) ? source.routePoints : []))
                .map(point => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 }))
        })).filter(edge => nodesById.has(edge.fromNode) && nodesById.has(edge.toNode))
        return {
            id,
            kind: String(entry.kind || document.metadata?.asset_kind || 'operation'),
            name: String(entry.name || document.name || humanize(id)),
            dependencies: Array.isArray(entry.dependencies) ? entry.dependencies.map(String) : [],
            nodes,
            nodesById,
            edges,
            bounds: graphBounds(nodes)
        }
    })
    const requestedRoot = String(root?.rootAsset || root?.rootAssetId || '')
    const rootAsset = assets.find(asset => asset.id === requestedRoot) || assets.find(asset => asset.kind === 'operation') || assets[0] || null
    return {
        rootAssetId: rootAsset?.id || null,
        assets: rootAsset ? [rootAsset, ...assets.filter(asset => asset !== rootAsset)] : [],
        totalNodes: assets.reduce((sum, asset) => sum + asset.nodes.length, 0),
        totalEdges: assets.reduce((sum, asset) => sum + asset.edges.length, 0)
    }
}

function inferCategory(type) {
    const name = String(type).split(':').at(-1)
    if(name.startsWith('event_')) return 'events'
    if(name.startsWith('control_') || name === 'if') return 'control'
    if(name.startsWith('data_') || name.includes('variable')) return 'data'
    if(name.includes('function')) return 'functions'
    if(name.startsWith('action_')) return 'actions'
    return 'unknown'
}

function graphBounds(nodes) {
    if(!nodes.length) return { minX: 0, minY: 0, maxX: NODE_WIDTH, maxY: NODE_MIN_HEIGHT, width: NODE_WIDTH, height: NODE_MIN_HEIGHT }
    const minX = Math.min(...nodes.map(node => node.x))
    const minY = Math.min(...nodes.map(node => node.y))
    const maxX = Math.max(...nodes.map(node => node.x + node.width))
    const maxY = Math.max(...nodes.map(node => node.y + node.height))
    return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

function fitGraph(bounds, viewportWidth, viewportHeight, padding = 48, limits = {}) {
    const availableWidth = Math.max(1, viewportWidth - padding * 2)
    const availableHeight = Math.max(1, viewportHeight - padding * 2)
    const minimumZoom = Number.isFinite(limits.minimumZoom) ? limits.minimumZoom : 0.2
    const maximumZoom = Number.isFinite(limits.maximumZoom) ? limits.maximumZoom : 2
    const zoom = Math.max(minimumZoom, Math.min(maximumZoom, Math.min(availableWidth / bounds.width, availableHeight / bounds.height)))
    return {
        zoom,
        panX: bounds.minX - (viewportWidth / zoom - bounds.width) / 2,
        panY: bounds.minY - (viewportHeight / zoom - bounds.height) / 2
    }
}

function zoomAt(camera, factor, screenX, screenY) {
    const oldZoom = camera.zoom
    const zoom = Math.max(0.15, Math.min(3, oldZoom * factor))
    const worldX = screenX / oldZoom + camera.panX
    const worldY = screenY / oldZoom + camera.panY
    return { zoom, panX: worldX - screenX / zoom, panY: worldY - screenY / zoom }
}

function worldToScreen(camera, x, y) {
    return { x: (x - camera.panX) * camera.zoom, y: (y - camera.panY) * camera.zoom }
}

function screenToWorld(camera, x, y) {
    return { x: x / camera.zoom + camera.panX, y: y / camera.zoom + camera.panY }
}

class GraphSpatialIndex {
    constructor(nodes = [], cellSize = SPATIAL_CELL_SIZE) {
        this.cellSize = cellSize
        this.cells = new Map()
        for(const node of nodes) this.add(node)
    }

    key(x, y) { return `${x}:${y}` }

    add(node) {
        const minX = Math.floor(node.x / this.cellSize)
        const maxX = Math.floor((node.x + node.width) / this.cellSize)
        const minY = Math.floor(node.y / this.cellSize)
        const maxY = Math.floor((node.y + node.height) / this.cellSize)
        for(let y = minY; y <= maxY; y += 1) {
            for(let x = minX; x <= maxX; x += 1) {
                const key = this.key(x, y)
                if(!this.cells.has(key)) this.cells.set(key, new Set())
                this.cells.get(key).add(node)
            }
        }
    }

    query(rect) {
        const result = new Set()
        const minX = Math.floor(rect.minX / this.cellSize)
        const maxX = Math.floor(rect.maxX / this.cellSize)
        const minY = Math.floor(rect.minY / this.cellSize)
        const maxY = Math.floor(rect.maxY / this.cellSize)
        for(let y = minY; y <= maxY; y += 1) {
            for(let x = minX; x <= maxX; x += 1) {
                for(const node of this.cells.get(this.key(x, y)) || []) {
                    if(node.x <= rect.maxX && node.x + node.width >= rect.minX && node.y <= rect.maxY && node.y + node.height >= rect.minY) result.add(node)
                }
            }
        }
        return [...result]
    }
}

function edgeRoute(edge, asset) {
    const from = asset.nodesById.get(edge.fromNode)
    const to = asset.nodesById.get(edge.toNode)
    if(!from || !to) return []
    const start = { x: from.x + from.width, y: from.y + from.height / 2 }
    const end = { x: to.x, y: to.y + to.height / 2 }
    if(edge.route.length) return [start, ...edge.route, end]
    const midpoint = start.x + (end.x - start.x) / 2
    return [start, { x: midpoint, y: start.y }, { x: midpoint, y: end.y }, end]
}

function renderGraphCanvas(context, asset, camera, options = {}) {
    const width = context.canvas.width
    const height = context.canvas.height
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#14201e'
    context.fillRect(0, 0, width, height)
    drawGrid(context, camera, width, height)
    const worldMin = screenToWorld(camera, -100, -100)
    const worldMax = screenToWorld(camera, width + 100, height + 100)
    const visible = options.spatialIndex?.query({ minX: worldMin.x, minY: worldMin.y, maxX: worldMax.x, maxY: worldMax.y }) || asset.nodes
    const visibleIds = new Set(visible.map(node => node.id))

    context.save()
    context.translate(-camera.panX * camera.zoom, -camera.panY * camera.zoom)
    context.scale(camera.zoom, camera.zoom)
    context.lineJoin = 'round'
    context.lineCap = 'round'
    for(const edge of asset.edges) {
        if(!visibleIds.has(edge.fromNode) && !visibleIds.has(edge.toNode)) continue
        const route = edgeRoute(edge, asset)
        if(route.length < 2) continue
        drawEdge(context, route, options.selectedNodeId && [edge.fromNode, edge.toNode].includes(options.selectedNodeId), camera.zoom)
    }
    for(const node of visible) drawNode(context, node, options.selectedNodeId === node.id, camera.zoom)
    context.restore()
}

function drawEdge(context, route, selected, zoom) {
    context.beginPath()
    context.moveTo(route[0].x, route[0].y)
    for(const point of route.slice(1)) context.lineTo(point.x, point.y)
    context.strokeStyle = 'rgba(4, 10, 9, .88)'
    context.lineWidth = (selected ? 7 : 6) / zoom
    context.stroke()
    context.strokeStyle = selected ? '#f2b36d' : '#61c8b0'
    context.lineWidth = (selected ? 3.5 : 2.5) / zoom
    context.stroke()
}

function drawGrid(context, camera, width, height) {
    const spacing = 48 * camera.zoom
    if(spacing < 8) return
    const offsetX = ((-camera.panX * camera.zoom) % spacing + spacing) % spacing
    const offsetY = ((-camera.panY * camera.zoom) % spacing + spacing) % spacing
    context.strokeStyle = 'rgba(82, 119, 109, .32)'
    context.lineWidth = 1
    context.beginPath()
    for(let x = offsetX; x < width; x += spacing) { context.moveTo(x, 0); context.lineTo(x, height) }
    for(let y = offsetY; y < height; y += spacing) { context.moveTo(0, y); context.lineTo(width, y) }
    context.stroke()
}

function drawNode(context, node, selected, zoom) {
    const category = CATEGORY_COLORS[node.category] || CATEGORY_COLORS.unknown
    const outline = selected ? '#f2b36d' : 'rgba(210, 235, 227, .48)'

    // At overview zoom the category itself is the useful information. Solid
    // tiles avoid illegible labels and make graph complexity easy to scan.
    if(zoom < 0.42) {
        context.fillStyle = category
        roundedRect(context, node.x, node.y, node.width, node.height, NODE_RADIUS)
        context.fill()
        context.strokeStyle = selected ? '#fff0cf' : 'rgba(5, 12, 11, .82)'
        context.lineWidth = (selected ? 5 : 2) / zoom
        context.stroke()
        return
    }

    if(selected) {
        context.strokeStyle = 'rgba(242, 179, 109, .34)'
        context.lineWidth = 8 / zoom
        roundedRect(context, node.x, node.y, node.width, node.height, NODE_RADIUS + 1)
        context.stroke()
    }

    roundedRect(context, node.x, node.y, node.width, node.height, NODE_RADIUS)
    context.fillStyle = '#223531'
    context.fill()
    context.save()
    context.clip()
    context.fillStyle = category
    context.fillRect(node.x, node.y, node.width, NODE_HEADER_HEIGHT)
    context.fillStyle = 'rgba(5, 12, 11, .16)'
    context.fillRect(node.x, node.y + NODE_HEADER_HEIGHT - 2, node.width, 2)
    context.restore()
    roundedRect(context, node.x, node.y, node.width, node.height, NODE_RADIUS)
    context.strokeStyle = outline
    context.lineWidth = (selected ? 3 : 1.5) / zoom
    context.stroke()

    context.fillStyle = '#eef8f3'
    context.font = '700 13px sans-serif'
    context.fillText(node.title.slice(0, 25), node.x + 12, node.y + 21, node.width - 24)
    context.font = '11px sans-serif'
    const inputs = node.inputs.slice(0, 5)
    const outputs = node.outputs.slice(0, 5)
    if(zoom < 0.62) return
    for(let index = 0; index < Math.max(inputs.length, outputs.length); index += 1) {
        const y = node.y + 45 + index * 17
        if(inputs[index]) {
            context.fillStyle = PIN_COLORS[inputs[index].type] || PIN_COLORS.any
            drawPin(context, node.x, y)
            context.fillStyle = '#b9cdc7'; context.textAlign = 'left'; context.fillText(inputs[index].id, node.x + 9, y + 4, 72)
        }
        if(outputs[index]) {
            context.fillStyle = PIN_COLORS[outputs[index].type] || PIN_COLORS.any
            drawPin(context, node.x + node.width, y)
            context.fillStyle = '#b9cdc7'; context.textAlign = 'right'; context.fillText(outputs[index].id, node.x + node.width - 9, y + 4, 72)
        }
    }
    context.textAlign = 'left'
}

function drawPin(context, x, y) {
    context.beginPath()
    context.arc(x, y, 4.5, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = '#10201d'
    context.lineWidth = 1.25
    context.stroke()
}

function roundedRect(context, x, y, width, height, radius) {
    context.beginPath()
    context.roundRect(x, y, width, height, radius)
}

function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[character])
}

function renderAutomationSvg(input, options = {}) {
    const bundle = normalizeAutomationBundle(input, options.registry)
    const asset = bundle.assets[0]
    const width = Number(options.width || 768)
    const height = Number(options.height || 432)
    if(!asset) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#14201e"/></svg>`
    const camera = fitGraph(asset.bounds, width, height, 30, { minimumZoom: 0.025, maximumZoom: 1.2 })
    const point = (x, y) => worldToScreen(camera, x, y)
    const edges = asset.edges.map(edge => {
        const route = edgeRoute(edge, asset).map(value => point(value.x, value.y))
        if(route.length < 2) return ''
        const points = route.map(value => `${value.x.toFixed(2)},${value.y.toFixed(2)}`).join(' ')
        return `<polyline points="${points}" fill="none" stroke="#06100e" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${points}" fill="none" stroke="#61c8b0" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`
    }).join('')
    const nodes = asset.nodes.map(node => {
        const p = point(node.x, node.y)
        const color = CATEGORY_COLORS[node.category] || CATEGORY_COLORS.unknown
        const nodeWidth = Math.max(5, node.width * camera.zoom)
        const nodeHeight = Math.max(4, node.height * camera.zoom)
        const radius = Math.max(1.5, Math.min(7, nodeHeight * .18))
        return `<rect x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" width="${nodeWidth.toFixed(2)}" height="${nodeHeight.toFixed(2)}" rx="${radius.toFixed(2)}" fill="${color}" stroke="#07110f" stroke-width="1.5"/>`
    }).join('')
    const horizontalGrid = Array.from({ length: Math.ceil(height / 48) }, (_, index) => `M0 ${(index + 1) * 48}H${width}`).join('')
    const verticalGrid = Array.from({ length: Math.ceil(width / 48) }, (_, index) => `M${(index + 1) * 48} 0V${height}`).join('')
    const description = `${asset.nodes.length} nodes, ${asset.edges.length} connections, ${bundle.assets.length} bundled assets`
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Automation graph preview: ${escapeXml(description)}"><title>Automation graph preview: ${escapeXml(description)}</title><rect width="100%" height="100%" fill="#101c1a"/><path d="${horizontalGrid}${verticalGrid}" stroke="#345049" stroke-width="1" opacity=".32"/>${edges}${nodes}<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#52766c" stroke-width="2" opacity=".6"/></svg>`
}

module.exports = {
    CATEGORY_COLORS,
    GraphSpatialIndex,
    NODE_HEADER_HEIGHT,
    NODE_MIN_HEIGHT,
    NODE_RADIUS,
    NODE_WIDTH,
    PIN_COLORS,
    edgeRoute,
    fitGraph,
    graphBounds,
    normalizeAutomationBundle,
    normalizeRegistry,
    renderAutomationSvg,
    renderGraphCanvas,
    screenToWorld,
    worldToScreen,
    zoomAt
}
