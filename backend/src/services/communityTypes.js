'use strict'

const fs = require('fs')
const path = require('path')
const {
    FORMAT_CONTRACTS,
    JSON_LIMITS,
    TYPES,
    canonicalizeJsonArtifact
} = require('@allegator-games/community-core')
const { MAX_COMPRESSED_BYTES, validateResourcePack } = require('./communityResourcePack')

const compatibilityManifest = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'config', 'community-compatibility-1.0.4-test.1.json'),
    'utf8'
))
const allowedAutomationNodeTypes = new Set(compatibilityManifest.automationNodeTypes || [])

const DISPLAY_NAMES = Object.freeze({
    [TYPES.AUTOMATION]: 'Automation',
    [TYPES.BATTLE_TRAINERS]: 'Battle Trainers',
    [TYPES.BUILDER_PRESETS]: 'Builder Presets',
    [TYPES.RESOURCE_PACKS]: 'Resource Packs'
})

class CommunityTypeRegistry {
    constructor(handlers = []) {
        this.handlers = new Map()
        handlers.forEach(handler => this.register(handler))
    }

    register(handler) {
        if(!handler?.id || typeof handler.validate !== 'function' || !handler.format) {
            throw new TypeError('Community type handlers require id, format, and validate.')
        }
        if(this.handlers.has(handler.id)) throw new Error(`Duplicate Community type handler: ${handler.id}`)
        this.handlers.set(handler.id, Object.freeze({ ...handler }))
        return this
    }

    get(id) {
        return this.handlers.get(String(id || '').toLowerCase()) || null
    }

    enabled(settings) {
        return Array.from(this.handlers.values()).filter(handler => settings?.types?.[handler.id] === true)
    }
}

function jsonHandler(id) {
    return {
        id,
        displayName: DISPLAY_NAMES[id],
        format: FORMAT_CONTRACTS[id],
        maxBytes: JSON_LIMITS[id],
        async validate(context) {
            const input = await fs.promises.readFile(context.filePath)
            return canonicalizeJsonArtifact(id, input, {
                ...(context.options || {}),
                ...(id === TYPES.AUTOMATION ? { allowedNodeTypes: allowedAutomationNodeTypes } : {})
            })
        }
    }
}

function createDefaultCommunityTypeRegistry() {
    return new CommunityTypeRegistry([
        jsonHandler(TYPES.AUTOMATION),
        jsonHandler(TYPES.BATTLE_TRAINERS),
        jsonHandler(TYPES.BUILDER_PRESETS),
        {
            id: TYPES.RESOURCE_PACKS,
            displayName: DISPLAY_NAMES[TYPES.RESOURCE_PACKS],
            format: FORMAT_CONTRACTS[TYPES.RESOURCE_PACKS],
            maxBytes: MAX_COMPRESSED_BYTES,
            validate: context => validateResourcePack(context.filePath, context.options || {})
        }
    ])
}

module.exports = {
    CommunityTypeRegistry,
    DISPLAY_NAMES,
    compatibilityManifest,
    createDefaultCommunityTypeRegistry
}
