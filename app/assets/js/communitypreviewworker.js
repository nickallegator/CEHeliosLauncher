'use strict'

const crypto = require('crypto')
const { isMainThread, parentPort } = require('worker_threads')

function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;'
    }[character]))
}

function renderAutomationSvg(input) {
    const root = Buffer.isBuffer(input) || ArrayBuffer.isView(input)
        ? JSON.parse(Buffer.from(input.buffer || input, input.byteOffset || 0, input.byteLength).toString('utf8'))
        : input
    const assets = Array.isArray(root?.assets) ? root.assets : []
    const nodes = assets.flatMap(asset => Array.isArray(asset.document?.graph?.nodes)
        ? asset.document.graph.nodes.map(node => ({ ...node, assetName: asset.document.name || asset.kind || 'Asset' }))
        : [])
    const edges = assets.flatMap(asset => Array.isArray(asset.document?.graph?.edges) ? asset.document.graph.edges : [])
    const width = 768
    const height = 432
    const sourceXs = nodes.map(node => Number(node.x) || 0)
    const sourceYs = nodes.map(node => Number(node.y) || 0)
    const minX = Math.min(0, ...sourceXs)
    const maxX = Math.max(1, ...sourceXs)
    const minY = Math.min(0, ...sourceYs)
    const maxY = Math.max(1, ...sourceYs)
    const positions = new Map(nodes.map((node, index) => {
        const x = nodes.length === 1 ? width / 2 : 72 + (((Number(node.x) || 0) - minX) / Math.max(1, maxX - minX)) * (width - 144)
        const y = nodes.length === 1 ? height / 2 : 72 + (((Number(node.y) || 0) - minY) / Math.max(1, maxY - minY)) * (height - 144)
        return [String(node.nodeId), { x, y, node, index }]
    }))
    const edgeMarkup = edges.map(edge => {
        const from = positions.get(String(edge.fromNodeId))
        const to = positions.get(String(edge.toNodeId))
        return from && to ? `<path d="M${from.x} ${from.y} L${to.x} ${to.y}" stroke="#61c8b0" stroke-width="4" opacity=".75"/>` : ''
    }).join('')
    const nodeMarkup = [...positions.values()].map(({ x, y, node, index }) => {
        const label = String(node.blockTypeId || 'node').split(':').at(-1).replaceAll('_', ' ').slice(0, 24)
        return `<g transform="translate(${x - 62} ${y - 26})"><rect width="124" height="52" rx="8" fill="#263b37" stroke="${index === 0 ? '#db8044' : '#8cb5a9'}" stroke-width="3"/><text x="62" y="31" text-anchor="middle" fill="#eef8f3" font-family="sans-serif" font-size="12" font-weight="700">${escapeXml(label)}</text></g>`
    }).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#14201e"/><path d="M0 48H768M0 96H768M0 144H768M0 192H768M0 240H768M0 288H768M0 336H768M0 384H768M48 0V432M96 0V432M144 0V432M192 0V432M240 0V432M288 0V432M336 0V432M384 0V432M432 0V432M480 0V432M528 0V432M576 0V432M624 0V432M672 0V432M720 0V432" stroke="#345049" stroke-width="1" opacity=".45"/>${edgeMarkup}${nodeMarkup}<text x="24" y="408" fill="#a7c9bf" font-family="sans-serif" font-size="14">${nodes.length} nodes · ${assets.length} bundled assets</text></svg>`
}

function parseArtifact(input) {
    return Buffer.isBuffer(input) || ArrayBuffer.isView(input)
        ? JSON.parse(Buffer.from(input.buffer || input, input.byteOffset || 0, input.byteLength).toString('utf8'))
        : input
}

function blockColor(blockId) {
    const bytes = crypto.createHash('sha256').update(String(blockId || 'minecraft:stone')).digest()
    const channel = index => 72 + (bytes[index] % 136)
    return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`
}

function renderGradientSvg(input) {
    const root = parseArtifact(input)
    const pins = (Array.isArray(root?.pins) ? root.pins : []).slice().sort((a, b) => Number(a.value) - Number(b.value))
    const stops = pins.length > 0
        ? pins.map(pin => `<stop offset="${Math.max(0, Math.min(1, Number(pin.value) || 0)) * 100}%" stop-color="${blockColor(pin.block)}"/>`).join('')
        : '<stop offset="0%" stop-color="#38504b"/><stop offset="100%" stop-color="#ff6600"/>'
    const swatches = pins.slice(0, 10).map((pin, index) => {
        const x = 34 + (index * 70)
        const label = String(pin.block || '').split(':').at(-1).replaceAll('_', ' ').slice(0, 10)
        return `<g transform="translate(${x} 322)"><rect width="56" height="44" rx="4" fill="${blockColor(pin.block)}" stroke="#d5e5e0" stroke-width="2"/><text x="28" y="61" text-anchor="middle" fill="#d5e5e0" font-family="sans-serif" font-size="9">${escapeXml(label)}</text></g>`
    }).join('')
    const gradientType = escapeXml(String(root?.settings?.type || 'SMOOTH').toUpperCase())
    const state = `${root?.settings?.noise ? 'Noise' : 'Clean'} · ${root?.blend?.enabled ? 'Blended' : 'Unblended'}`
    return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432" viewBox="0 0 768 432"><defs><linearGradient id="preview" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs><rect width="768" height="432" fill="#14201e"/><rect x="30" y="44" width="708" height="230" rx="12" fill="url(#preview)" stroke="#87decd" stroke-width="4"/><path d="M30 286H738" stroke="#38504b" stroke-width="2"/><text x="34" y="30" fill="#f4f8f7" font-family="sans-serif" font-size="18" font-weight="700">${gradientType} BUILDER PRESET</text><text x="734" y="30" text-anchor="end" fill="#abc0bc" font-family="sans-serif" font-size="14">${escapeXml(state)}</text>${swatches}<text x="34" y="414" fill="#abc0bc" font-family="sans-serif" font-size="13">${pins.length} pinned materials · ${Array.isArray(root?.nodes) ? root.nodes.length : 0} gradient nodes</text></svg>`
}

function renderPreviewSvg(value) {
    if(value?.type === 'builder-presets') return renderGradientSvg(value.artifact)
    if(value?.type === 'automation') return renderAutomationSvg(value.artifact)
    return renderAutomationSvg(value)
}

if(!isMainThread && parentPort) {
    parentPort.on('message', value => {
        try { parentPort.postMessage({ svg: renderPreviewSvg(value) }) }
        catch(error) { parentPort.postMessage({ error: error.message }) }
    })
}

module.exports = { blockColor, escapeXml, renderAutomationSvg, renderGradientSvg, renderPreviewSvg }
