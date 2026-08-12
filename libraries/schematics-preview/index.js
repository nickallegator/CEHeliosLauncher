'use strict'

const DEFAULT_WIDTH = 768
const DEFAULT_HEIGHT = 432
const DEFAULT_MAX_FACES = 6000

const BLOCK_COLORS = Object.freeze([
    ['oxidized', '#4f9d82'],
    ['weathered', '#6f9b79'],
    ['exposed', '#b87956'],
    ['copper', '#c56f48'],
    ['deepslate', '#394047'],
    ['tuff', '#68716a'],
    ['spruce', '#6f4c31'],
    ['glass', '#8fc7c8'],
    ['lantern', '#e6ad55'],
    ['stone', '#777d80'],
    ['wood', '#78563a'],
    ['planks', '#8b6541']
])

function escapeXml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;'
    })[character])
}

function hashColor(value) {
    let hash = 2166136261
    const text = String(value || '')
    for(let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    const hue = hash % 360
    const saturation = 36 + ((hash >>> 7) % 24)
    const lightness = 46 + ((hash >>> 13) % 14)
    return hslToHex(hue, saturation, lightness)
}

function hslToHex(hue, saturation, lightness) {
    const s = saturation / 100
    const l = lightness / 100
    const chroma = (1 - Math.abs(2 * l - 1)) * s
    const part = ((hue % 360) + 360) % 360 / 60
    const x = chroma * (1 - Math.abs(part % 2 - 1))
    let rgb
    if(part < 1) rgb = [chroma, x, 0]
    else if(part < 2) rgb = [x, chroma, 0]
    else if(part < 3) rgb = [0, chroma, x]
    else if(part < 4) rgb = [0, x, chroma]
    else if(part < 5) rgb = [x, 0, chroma]
    else rgb = [chroma, 0, x]
    const offset = l - chroma / 2
    return `#${rgb.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`
}

function colorForState(state) {
    const normalized = String(state || '').toLowerCase()
    const match = BLOCK_COLORS.find(([token]) => normalized.includes(token))
    return match ? match[1] : hashColor(normalized)
}

function shade(hex, amount) {
    const value = Number.parseInt(hex.slice(1), 16)
    const channels = [value >> 16, (value >> 8) & 255, value & 255]
    return `#${channels.map(channel => Math.max(0, Math.min(255, Math.round(channel * amount))).toString(16).padStart(2, '0')).join('')}`
}

function project(x, y, z) {
    return [(x - z) * 1.0, (x + z) * 0.5 - y]
}

function polygon(points, fill, opacity = 1) {
    const value = points.map(point => `${point[0].toFixed(3)},${point[1].toFixed(3)}`).join(' ')
    return `<polygon points="${value}" fill="${fill}" fill-opacity="${opacity}" stroke="#07100f" stroke-opacity=".32" stroke-width=".035"/>`
}

function exposedFaces(parsed, maxFaces) {
    const canonical = parsed?.canonical || parsed
    const palette = Array.isArray(canonical?.palette) ? canonical.palette : []
    const blocks = Array.isArray(canonical?.blocks) ? canonical.blocks : []
    const occupied = new Set(blocks.map(block => block.pos.join(',')))
    const sorted = blocks.slice().sort((left, right) => {
        const leftDepth = left.pos[0] + left.pos[2]
        const rightDepth = right.pos[0] + right.pos[2]
        return leftDepth - rightDepth || left.pos[1] - right.pos[1] || left.pos[0] - right.pos[0]
    })
    const faceLimit = Math.max(1, Number(maxFaces) || DEFAULT_MAX_FACES)
    const visibleFacesForBlock = block => {
        const [x, y, z] = block.pos
        return [
            !occupied.has(`${x},${y + 1},${z}`) ? 'top' : null,
            !occupied.has(`${x + 1},${y},${z}`) ? 'east' : null,
            !occupied.has(`${x},${y},${z + 1}`) ? 'south' : null
        ].filter(Boolean)
    }
    const exposedFaceCount = sorted.reduce((count, block) => count + visibleFacesForBlock(block).length, 0)
    const stride = Math.max(1, Math.ceil(exposedFaceCount / faceLimit))
    const faces = []
    let faceIndex = 0
    for(const block of sorted) {
        const [x, y, z] = block.pos
        const color = colorForState(palette[block.state])
        const translucent = String(palette[block.state] || '').includes('glass')
        const opacity = translucent ? 0.58 : 1
        for(const side of visibleFacesForBlock(block)) {
            const shouldInclude = faceIndex % stride === 0 && faces.length < faceLimit
            faceIndex += 1
            if(!shouldInclude) continue
            if(side === 'top') faces.push({
                points: [project(x, y + 1, z), project(x + 1, y + 1, z), project(x + 1, y + 1, z + 1), project(x, y + 1, z + 1)],
                fill: shade(color, 1.18), opacity
            })
            else if(side === 'east') faces.push({
                points: [project(x + 1, y, z), project(x + 1, y, z + 1), project(x + 1, y + 1, z + 1), project(x + 1, y + 1, z)],
                fill: shade(color, 0.76), opacity
            })
            else faces.push({
                points: [project(x, y, z + 1), project(x + 1, y, z + 1), project(x + 1, y + 1, z + 1), project(x, y + 1, z + 1)],
                fill: shade(color, 0.92), opacity
            })
        }
    }
    return faces
}

function renderSchematicPreviewSvg(parsed, options = {}) {
    const width = Math.max(160, Number(options.width) || DEFAULT_WIDTH)
    const height = Math.max(90, Number(options.height) || DEFAULT_HEIGHT)
    const maxFaces = Math.max(100, Number(options.maxFaces) || DEFAULT_MAX_FACES)
    const faces = exposedFaces(parsed, maxFaces)
    const canonical = parsed?.canonical || parsed || {}
    const title = escapeXml(options.title || canonical.name || 'Schematic')
    if(faces.length === 0) throw new Error('Cannot render an empty schematic preview.')

    const points = faces.flatMap(face => face.points)
    const minX = Math.min(...points.map(point => point[0]))
    const maxX = Math.max(...points.map(point => point[0]))
    const minY = Math.min(...points.map(point => point[1]))
    const maxY = Math.max(...points.map(point => point[1]))
    const paddingX = width * 0.08
    const paddingTop = height * 0.08
    const paddingBottom = height * 0.16
    const scale = Math.min(
        (width - paddingX * 2) / Math.max(1, maxX - minX),
        (height - paddingTop - paddingBottom) / Math.max(1, maxY - minY)
    )
    const offsetX = (width - (maxX - minX) * scale) / 2 - minX * scale
    const offsetY = paddingTop - minY * scale
    const transform = face => face.points.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY])
    const faceMarkup = faces.map(face => polygon(transform(face), face.fill, face.opacity)).join('')

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} 3D preview">`,
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#142a29"/><stop offset="1" stop-color="#091211"/></linearGradient>',
        '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#6ac9b5" stroke-opacity=".08"/></pattern></defs>',
        `<rect width="${width}" height="${height}" fill="url(#bg)"/><rect width="${width}" height="${height}" fill="url(#grid)"/>`,
        `<ellipse cx="${width / 2}" cy="${height * 0.82}" rx="${width * 0.34}" ry="${height * 0.09}" fill="#000" opacity=".32"/>`,
        `<g>${faceMarkup}</g>`,
        `<path d="M${width * 0.06} ${height * 0.88}H${width * 0.94}" stroke="#d9773f" stroke-width="3" opacity=".7"/>`,
        '</svg>'
    ].join('')
}

module.exports = {
    colorForState,
    exposedFaces,
    renderSchematicPreviewSvg
}
