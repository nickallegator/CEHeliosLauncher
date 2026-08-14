'use strict'

function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, value))
}

function computeTexturedGradientLayout(width, height, pinCount, options = {}){
    const padding = Number(options.padding) || 20
    const gap = Number(options.gap) || 18
    const desiredPaletteWidth = clamp(width * .18, 96, 160)
    const gridSize = Math.max(64, Math.min(
        height - padding * 2,
        width - padding * 2 - gap - desiredPaletteWidth
    ))
    const gridX = padding
    const gridY = (height - gridSize) / 2
    const paletteX = gridX + gridSize + gap
    const paletteWidth = Math.max(48, width - padding - paletteX)
    const count = Math.max(0, Math.min(8, Number(pinCount) || 0))
    const swatchGap = clamp(gridSize * .02, 4, 8)
    const swatchSize = count > 0
        ? Math.max(12, Math.min(64, paletteWidth - 24, (gridSize - swatchGap * (count - 1)) / count))
        : 0
    const paletteContentHeight = count > 0 ? swatchSize * count + swatchGap * (count - 1) : 0
    return {
        padding,
        gap,
        gridX,
        gridY,
        gridSize,
        paletteX,
        paletteY: gridY,
        paletteWidth,
        paletteHeight: gridSize,
        swatchX: paletteX + (paletteWidth - swatchSize) / 2,
        swatchY: gridY + (gridSize - paletteContentHeight) / 2,
        swatchSize,
        swatchGap
    }
}

function textureFor(textures, blockId){
    return textures instanceof Map ? textures.get(blockId) : textures?.[blockId]
}

function embeddedTexture(texture, x, y, width, height, clipId, imageId){
    if(!texture?.bytes || !texture?.frame || !imageId) return null
    const frame = texture.frame
    return `<g clip-path="url(#${clipId})"><svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${frame.x} ${frame.y} ${frame.width} ${frame.height}" preserveAspectRatio="none"><use href="#${imageId}"/></svg></g>`
}

function renderTexturedGradientSvg(sample, textures, options = {}){
    const width = Number(options.width) || 768
    const height = Number(options.height) || 432
    const pins = sample.model.pins.slice(0, 8)
    const layout = computeTexturedGradientLayout(width, height, pins.length, options)
    const { gridX, gridY, gridSize } = layout
    const cell = gridSize / sample.cells
    const missing = new Set()
    const clips = []
    const cells = []
    const textureIds = new Map()
    const textureDefinitions = []
    const resolveEmbedded = (blockId, x, y, tileWidth, tileHeight, clipId) => {
        const texture = textureFor(textures, blockId)
        if(!texture?.bytes || !texture?.frame) return null
        if(!textureIds.has(blockId)){
            const imageId = `texture${textureIds.size}`
            textureIds.set(blockId, imageId)
            const data = Buffer.from(texture.bytes).toString('base64')
            textureDefinitions.push(`<image id="${imageId}" width="${texture.width}" height="${texture.height}" href="data:image/png;base64,${data}" style="image-rendering:pixelated"/>`)
        }
        return embeddedTexture(texture, x, y, tileWidth, tileHeight, clipId, textureIds.get(blockId))
    }
    for(let index = 0; index < sample.blocks.length; index += 1){
        const blockId = sample.blocks[index]
        const column = index % sample.cells
        const row = Math.floor(index / sample.cells)
        const x = gridX + column * cell
        const y = gridY + row * cell
        const clipId = `g${index}`
        clips.push(`<clipPath id="${clipId}"><rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${(cell + .1).toFixed(3)}" height="${(cell + .1).toFixed(3)}"/></clipPath>`)
        const image = resolveEmbedded(blockId, x.toFixed(3), y.toFixed(3), (cell + .1).toFixed(3), (cell + .1).toFixed(3), clipId)
        if(image) cells.push(image)
        else {
            missing.add(blockId || '<unassigned gradient cell>')
            cells.push(`<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${(cell + .1).toFixed(3)}" height="${(cell + .1).toFixed(3)}" fill="url(#missing)"/>`)
        }
    }
    const swatches = pins.map((pin, index) => {
        const x = layout.swatchX
        const y = layout.swatchY + index * (layout.swatchSize + layout.swatchGap)
        const clipId = `p${index}`
        clips.push(`<clipPath id="${clipId}"><rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${layout.swatchSize.toFixed(3)}" height="${layout.swatchSize.toFixed(3)}" rx="4"/></clipPath>`)
        const image = resolveEmbedded(pin.block, x.toFixed(3), y.toFixed(3), layout.swatchSize.toFixed(3), layout.swatchSize.toFixed(3), clipId)
        if(image) return image
        missing.add(pin.block || '<unassigned palette material>')
        return `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${layout.swatchSize.toFixed(3)}" height="${layout.swatchSize.toFixed(3)}" rx="4" fill="url(#missing)"/>`
    }).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><pattern id="missing" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#6b2f36"/><path d="M0 0h6v6H0zM6 6h6v6H6z" fill="#d3a15d"/></pattern>${textureDefinitions.join('')}${clips.join('')}</defs><rect width="${width}" height="${height}" fill="#0c1615"/><rect x="${(gridX - 4).toFixed(3)}" y="${(gridY - 4).toFixed(3)}" width="${(gridSize + 8).toFixed(3)}" height="${(gridSize + 8).toFixed(3)}" rx="6" fill="#20322f" stroke="#87decd" stroke-width="3"/>${cells.join('')}<rect x="${layout.paletteX.toFixed(3)}" y="${layout.paletteY.toFixed(3)}" width="${layout.paletteWidth.toFixed(3)}" height="${layout.paletteHeight.toFixed(3)}" rx="8" fill="#13211f" stroke="#345049" stroke-width="2"/>${swatches}</svg>`
    return { svg, missing: [...missing].sort() }
}

module.exports = { computeTexturedGradientLayout, renderTexturedGradientSvg }
