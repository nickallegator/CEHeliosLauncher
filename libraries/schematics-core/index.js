'use strict'

const crypto = require('crypto')

const FORMAT_ID = 'cobblepower_schematic'
const FORMAT_VERSION = 2
const MAX_BLOCKS = 200_000
const MAX_BYTES = 5 * 1024 * 1024
const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const CLIENT_OWNER = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SCHEMATIC_ID = /^[a-z0-9_-]{1,64}$/

class SchematicValidationError extends Error {
    constructor(code, message, details = null) {
        super(message)
        this.name = 'SchematicValidationError'
        this.code = code
        this.details = details
    }
}

function assertObject(value, label) {
    if(value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SchematicValidationError('invalid_object', `${label} must be an object.`)
    }
}

function stableStringify(value) {
    if(value === undefined) return undefined
    if(value == null || typeof value !== 'object') return JSON.stringify(value)
    if(Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`
    const entries = Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
}

function cloneJson(value, label) {
    if(value == null) return undefined
    try {
        return JSON.parse(JSON.stringify(value))
    } catch(_err) {
        throw new SchematicValidationError('invalid_metadata', `${label} must contain JSON-compatible values.`)
    }
}

function normalizeResourceLocation(value, label, fallback = null) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if(!normalized) return fallback
    if(!RESOURCE_LOCATION.test(normalized)) {
        throw new SchematicValidationError('invalid_resource_location', `${label} is not a valid resource location.`)
    }
    return normalized
}

function parseStateString(value, label = 'Block state') {
    if(typeof value !== 'string' || !value.trim()) {
        throw new SchematicValidationError('invalid_block_state', `${label} must be a non-empty string.`)
    }
    const normalized = value.trim().toLowerCase()
    const match = normalized.match(/^([a-z0-9_.-]+:[a-z0-9_./-]+)(?:\[([^\]]*)\])?$/)
    if(!match) {
        throw new SchematicValidationError('invalid_block_state', `${label} is not a valid Minecraft block state.`)
    }
    const properties = {}
    if(match[2]) {
        for(const rawPart of match[2].split(',')) {
            const part = rawPart.trim()
            const separator = part.indexOf('=')
            if(separator <= 0 || separator === part.length - 1) {
                throw new SchematicValidationError('invalid_block_state', `${label} contains an invalid property.`)
            }
            const key = part.slice(0, separator).trim()
            const propertyValue = part.slice(separator + 1).trim()
            if(!/^[a-z0-9_]+$/.test(key) || !/^[a-z0-9_.-]+$/.test(propertyValue)) {
                throw new SchematicValidationError('invalid_block_state', `${label} contains an invalid property.`)
            }
            properties[key] = propertyValue
        }
    }
    const keys = Object.keys(properties).sort()
    return {
        value: keys.length === 0
            ? match[1]
            : `${match[1]}[${keys.map(key => `${key}=${properties[key]}`).join(',')}]`,
        block: match[1],
        state: keys.length === 0 ? undefined : properties
    }
}

function stateFromLegacy(entry, index) {
    if(typeof entry.state === 'string' && entry.state.trim()) {
        return parseStateString(entry.state, `Block ${index} state`).value
    }
    const block = normalizeResourceLocation(entry.block, `Block ${index} id`)
    if(!block) {
        throw new SchematicValidationError('invalid_block', `Block ${index} is missing a block id or state.`)
    }
    const rawProperties = entry.properties && typeof entry.properties === 'object'
        ? entry.properties
        : (entry.state && typeof entry.state === 'object' ? entry.state : null)
    if(!rawProperties || Object.keys(rawProperties).length === 0) return block
    const properties = Object.keys(rawProperties)
        .sort()
        .map(key => `${String(key).toLowerCase()}=${String(rawProperties[key]).toLowerCase()}`)
        .join(',')
    return parseStateString(`${block}[${properties}]`, `Block ${index} state`).value
}

function normalizePosition(value, index) {
    if(!Array.isArray(value) || value.length !== 3) {
        throw new SchematicValidationError('invalid_position', `Block ${index} must have a three-number pos array.`)
    }
    const pos = value.map(Number)
    if(!pos.every(Number.isSafeInteger)) {
        throw new SchematicValidationError('invalid_position', `Block ${index} coordinates must be safe integers.`)
    }
    return pos
}

function computeBounds(blocks) {
    if(!Array.isArray(blocks) || blocks.length === 0) {
        return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
    }
    const positions = blocks.map(block => block.pos || [block.x, block.y, block.z])
    const min = positions[0].slice()
    const max = positions[0].slice()
    for(const pos of positions.slice(1)) {
        for(let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], pos[axis])
            max[axis] = Math.max(max[axis], pos[axis])
        }
    }
    return { min, max, size: max.map((value, axis) => value - min[axis] + 1) }
}

function normalizeMetadata(raw) {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Untitled Schematic'
    const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().slice(0, 64) : 'misc'
    const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim().toLowerCase() : 'standard'
    const icon = normalizeResourceLocation(raw.icon, 'Schematic icon', undefined)
    const metadata = {
        name,
        category,
        type,
        icon,
        bridge: cloneJson(raw.bridge, 'Bridge metadata'),
        scalable: cloneJson(raw.scalable, 'Scalable metadata'),
        modifiers: Array.isArray(raw.modifiers) ? cloneJson(raw.modifiers, 'Modifiers') : undefined
    }
    return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
}

function canonicalizePaletteAndBlocks(raw, options, warnings) {
    const sanitizeNbt = options.stripBlockEntityNbt === true
    const inputBlocks = Array.isArray(raw.blocks) ? raw.blocks : []
    if(inputBlocks.length === 0) {
        throw new SchematicValidationError('empty_schematic', 'Schematic must contain at least one block.')
    }
    if(inputBlocks.length > MAX_BLOCKS) {
        throw new SchematicValidationError('too_many_blocks', `Schematic exceeds the ${MAX_BLOCKS.toLocaleString()} block limit.`)
    }

    const isV2 = raw.format === FORMAT_ID || raw.version != null || Array.isArray(raw.palette)
    let sourcePalette = null
    if(isV2) {
        if(raw.format !== FORMAT_ID) {
            throw new SchematicValidationError('unsupported_format', `Expected format ${FORMAT_ID}.`)
        }
        const version = Number(raw.version)
        if(version > FORMAT_VERSION) {
            throw new SchematicValidationError('future_version', `Schematic format version ${version} requires a launcher update.`)
        }
        if(version !== FORMAT_VERSION) {
            throw new SchematicValidationError('unsupported_version', `Schematic format version ${version} is not supported.`)
        }
        if(!Array.isArray(raw.palette) || raw.palette.length === 0) {
            throw new SchematicValidationError('invalid_palette', 'Version 2 schematics require a non-empty palette.')
        }
        sourcePalette = raw.palette.map((entry, index) => parseStateString(entry, `Palette entry ${index}`).value)
    } else {
        warnings.push('Legacy raw-block schematic converted to cobblepower_schematic version 2.')
    }

    const palette = []
    const paletteIndexes = new Map()
    const blocks = []
    let strippedNbtCount = 0
    const positions = new Set()
    for(let index = 0; index < inputBlocks.length; index++) {
        const entry = inputBlocks[index]
        assertObject(entry, `Block ${index}`)
        const pos = normalizePosition(entry.pos, index)
        const positionKey = pos.join(',')
        if(positions.has(positionKey)) {
            throw new SchematicValidationError('duplicate_position', `Schematic contains duplicate block position ${positionKey}.`)
        }
        positions.add(positionKey)

        let stateString
        if(sourcePalette) {
            if(!Number.isSafeInteger(entry.state) || entry.state < 0 || entry.state >= sourcePalette.length) {
                throw new SchematicValidationError('invalid_palette_index', `Block ${index} references an invalid palette index.`)
            }
            stateString = sourcePalette[entry.state]
        } else {
            stateString = stateFromLegacy(entry, index)
        }
        let paletteIndex = paletteIndexes.get(stateString)
        if(paletteIndex == null) {
            paletteIndex = palette.length
            paletteIndexes.set(stateString, paletteIndex)
            palette.push(stateString)
        }
        const block = { pos, state: paletteIndex }
        if(typeof entry.nbt === 'string' && entry.nbt.trim()) {
            if(sanitizeNbt) strippedNbtCount++
            else block.nbt = entry.nbt.trim()
        }
        blocks.push(block)
    }

    if(strippedNbtCount > 0) {
        warnings.push(`Removed block-entity NBT from ${strippedNbtCount} block${strippedNbtCount === 1 ? '' : 's'}.`)
    }
    return { palette, blocks, strippedNbtCount }
}

function contentHashPayload(canonical) {
    const content = { ...canonical }
    delete content.id
    return content
}

function hashCanonicalSchematic(canonical) {
    return crypto.createHash('sha256').update(stableStringify(contentHashPayload(canonical)), 'utf8').digest('hex')
}

function parseCanonicalSchematic(raw, options = {}) {
    assertObject(raw, 'Schematic')
    if(options.sourceBytes != null && Number(options.sourceBytes) > MAX_BYTES) {
        throw new SchematicValidationError('file_too_large', `Schematic exceeds the ${MAX_BYTES} byte limit.`)
    }
    const warnings = []
    const metadata = normalizeMetadata(raw)
    const { palette, blocks, strippedNbtCount } = canonicalizePaletteAndBlocks(raw, options, warnings)
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().toLowerCase() : undefined
    if(id && !RESOURCE_LOCATION.test(id)) {
        throw new SchematicValidationError('invalid_id', 'Schematic id must be a valid resource location.')
    }
    const canonical = {
        format: FORMAT_ID,
        version: FORMAT_VERSION,
        ...(id ? { id } : {}),
        ...metadata,
        palette,
        blocks
    }
    const serialized = `${stableStringify(canonical)}\n`
    if(Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
        throw new SchematicValidationError('file_too_large', `Canonical schematic exceeds the ${MAX_BYTES} byte limit.`)
    }
    return {
        canonical,
        serialized,
        sha256: hashCanonicalSchematic(canonical),
        sizeBytes: Buffer.byteLength(serialized, 'utf8'),
        blockCount: blocks.length,
        bounds: computeBounds(blocks),
        warnings,
        sanitization: { blockEntityNbtRemoved: strippedNbtCount }
    }
}

function toPreviewModel(parsed) {
    const source = parsed.canonical ? parsed : parseCanonicalSchematic(parsed)
    const canonical = source.canonical
    return {
        ...canonical,
        palette: canonical.palette.map(stateString => {
            const parsedState = parseStateString(stateString)
            return parsedState.state ? { block: parsedState.block, state: parsedState.state } : { block: parsedState.block }
        }),
        blocks: canonical.blocks.map(block => ({ x: block.pos[0], y: block.pos[1], z: block.pos[2], p: block.state })),
        bounds: source.bounds || computeBounds(canonical.blocks),
        meta: {
            version: FORMAT_VERSION,
            hash: source.sha256 || hashCanonicalSchematic(canonical),
            blockCount: canonical.blocks.length
        }
    }
}

async function normalizeJsonSchematic(raw, options = {}) {
    const parsed = parseCanonicalSchematic(raw, {
        sourceBytes: options.sourceBytes,
        stripBlockEntityNbt: options.stripBlockEntityNbt
    })
    if(options.id && !parsed.canonical.id) parsed.canonical.id = options.id
    return { schematic: toPreviewModel(parsed), canonical: parsed.canonical, warnings: parsed.warnings, sanitization: parsed.sanitization }
}

async function hashSchematic(value) {
    if(value?.canonical) return hashCanonicalSchematic(value.canonical)
    if(value?.format === FORMAT_ID && Array.isArray(value.palette)) return hashCanonicalSchematic(parseCanonicalSchematic(value).canonical)
    return (await normalizeJsonSchematic(value)).schematic.meta.hash
}

function normalizeUuid(value) {
    const compact = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!/^[a-f0-9]{32}$/.test(compact)) throw new SchematicValidationError('invalid_uuid', 'Minecraft UUID must contain 32 hexadecimal characters.')
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function validateCommunitySchematicId(value) {
    const id = String(value || '').trim().toLowerCase()
    if(!SCHEMATIC_ID.test(id)) throw new SchematicValidationError('invalid_community_id', 'Community schematic id must use 1-64 lowercase letters, numbers, underscores, or hyphens.')
    return id
}

function adaptCanonicalForPlayer(canonicalInput, playerUuid, schematicId) {
    const parsed = parseCanonicalSchematic(canonicalInput)
    const owner = normalizeUuid(playerUuid)
    if(!CLIENT_OWNER.test(owner)) throw new SchematicValidationError('invalid_uuid', 'Invalid player UUID.')
    const communityId = validateCommunitySchematicId(schematicId)
    return {
        ...parsed.canonical,
        id: `cobblepower:client/${owner}/${communityId}`
    }
}

module.exports = {
    FORMAT_ID,
    FORMAT_VERSION,
    MAX_BLOCKS,
    MAX_BYTES,
    SchematicValidationError,
    adaptCanonicalForPlayer,
    computeBounds,
    hashCanonicalSchematic,
    hashSchematic,
    normalizeJsonSchematic,
    normalizeUuid,
    parseCanonicalSchematic,
    parseStateString,
    stableStringify,
    toPreviewModel,
    validateCommunitySchematicId
}
