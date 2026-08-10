/**
 * schematics-core
 * Shared, runtime-agnostic helpers for parsing and normalizing schematic data.
 * No DOM or renderer dependencies.
 */

'use strict'

const DEFAULT_VERSION = 1

/**
 * @typedef {Object} RawSchematic
 * @property {string=} name
 * @property {string=} category
 * @property {string=} icon
 * @property {Array<{pos: [number, number, number], block: string, state?: Object}>=} blocks
 */

/**
 * @typedef {Object} NormalizedSchematic
 * @property {string} id
 * @property {string} name
 * @property {string=} category
 * @property {string=} icon
 * @property {{min: [number,number,number], max: [number,number,number], size: [number,number,number]}} bounds
 * @property {Array<{block: string, state?: Object}>} palette
 * @property {Array<{x:number,y:number,z:number,p:number}>} blocks
 * @property {{version: number, hash: string, blockCount: number}} meta
 */

/**
 * Normalize a JSON schematic into a palette-based representation.
 *
 * @param {RawSchematic} raw
 * @param {{ id?: string, version?: number }=} options
 * @returns {Promise<{ schematic: NormalizedSchematic, warnings: string[] }>}
 */
async function normalizeJsonSchematic(raw, options = {}) {
    if(raw == null || typeof raw !== 'object'){
        throw new Error('Schematic must be an object.')
    }

    const warnings = []
    const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : 'Untitled Schematic'
    const category = typeof raw.category === 'string' ? raw.category : undefined
    const icon = typeof raw.icon === 'string' ? raw.icon : undefined
    const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : []

    if(rawBlocks.length === 0){
        warnings.push('Schematic has no blocks.')
    }

    const { palette, blocks } = buildPalette(rawBlocks, warnings)
    const bounds = computeBounds(blocks)
    const blockCount = blocks.length

    const meta = {
        version: Number.isFinite(options.version) ? options.version : DEFAULT_VERSION,
        hash: '',
        blockCount
    }

    const schematic = {
        id: options.id || '',
        name,
        category,
        icon,
        bounds,
        palette,
        blocks,
        meta
    }

    const hash = await hashSchematic(schematic)
    schematic.meta.hash = hash
    if(!schematic.id){
        schematic.id = hash.slice(0, 12)
    }

    return { schematic, warnings }
}

/**
 * Build a palette and normalized block list.
 *
 * @param {Array<{pos: [number,number,number], block: string, state?: Object}>} rawBlocks
 * @param {string[]} warnings
 */
function buildPalette(rawBlocks, warnings) {
    const palette = []
    const paletteIndex = new Map()
    const blocks = []

    for(const entry of rawBlocks){
        if(!entry || !Array.isArray(entry.pos) || entry.pos.length !== 3){
            warnings.push('Block entry missing valid pos array.')
            continue
        }
        const blockId = typeof entry.block === 'string' ? entry.block : null
        if(!blockId){
            warnings.push('Block entry missing valid block id.')
            continue
        }

        const x = Number(entry.pos[0])
        const y = Number(entry.pos[1])
        const z = Number(entry.pos[2])
        if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)){
            warnings.push(`Block entry has invalid coordinates: ${entry.pos}`)
            continue
        }

        const state = entry.state && typeof entry.state === 'object' ? entry.state : undefined
        const key = state ? `${blockId}:${stableStringify(state)}` : blockId
        let p = paletteIndex.get(key)
        if(p == null){
            p = palette.length
            paletteIndex.set(key, p)
            palette.push(state ? { block: blockId, state } : { block: blockId })
        }

        blocks.push({ x, y, z, p })
    }

    return { palette, blocks }
}

/**
 * Compute schematic bounds from normalized blocks.
 *
 * @param {Array<{x:number,y:number,z:number}>} blocks
 */
function computeBounds(blocks) {
    if(blocks.length === 0){
        return {
            min: [0, 0, 0],
            max: [0, 0, 0],
            size: [0, 0, 0]
        }
    }

    let minX = blocks[0].x
    let minY = blocks[0].y
    let minZ = blocks[0].z
    let maxX = blocks[0].x
    let maxY = blocks[0].y
    let maxZ = blocks[0].z

    for(const { x, y, z } of blocks){
        if(x < minX) minX = x
        if(y < minY) minY = y
        if(z < minZ) minZ = z
        if(x > maxX) maxX = x
        if(y > maxY) maxY = y
        if(z > maxZ) maxZ = z
    }

    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1]
    }
}

/**
 * Create a stable JSON string for hashing.
 *
 * @param {any} value
 */
function stableStringify(value) {
    if(value == null || typeof value !== 'object'){
        return JSON.stringify(value)
    }
    if(Array.isArray(value)){
        return `[${value.map(stableStringify).join(',')}]`
    }
    const keys = Object.keys(value).sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
}

/**
 * Compute a SHA-256 hash of the normalized schematic.
 *
 * @param {NormalizedSchematic} schematic
 * @returns {Promise<string>}
 */
async function hashSchematic(schematic) {
    const payload = {
        name: schematic.name,
        category: schematic.category,
        icon: schematic.icon,
        bounds: schematic.bounds,
        palette: schematic.palette,
        blocks: schematic.blocks
    }
    const message = stableStringify(payload)
    const data = new TextEncoder().encode(message)

    if(typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function'){
        const hashBuffer = await crypto.subtle.digest('SHA-256', data)
        return bufferToHex(hashBuffer)
    }

    try {
        // Node/Electron main process fallback
        // eslint-disable-next-line global-require
        const nodeCrypto = require('crypto')
        return nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest('hex')
    } catch (err) {
        throw new Error('No crypto implementation available to hash schematic.')
    }
}

function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
}

module.exports = {
    normalizeJsonSchematic,
    computeBounds,
    hashSchematic,
    stableStringify
}
