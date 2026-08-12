'use strict'

const fs = require('fs')
const path = require('path')

function parseDocument(filePath) {
    let value
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch(_error) {
        const error = new Error(`Unable to read Community JSON: ${path.basename(filePath)}`)
        error.code = 'invalid_json'
        throw error
    }
    if(!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error('Community JSON must contain an object.'), { code: 'invalid_json' })
    }
    return value
}

function normalizeMinecraftUuid(value) {
    const compact = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!/^[a-f0-9]{32}$/.test(compact)) throw Object.assign(new Error('A selected Minecraft account is required.'), { code: 'account_required' })
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function ensureFileInside(root, filePath, label) {
    let resolvedRoot
    let resolvedFile
    try {
        resolvedRoot = fs.realpathSync(path.resolve(root))
        resolvedFile = fs.realpathSync(path.resolve(filePath))
    } catch(_error) {
        throw Object.assign(new Error(`Select ${label} from the selected Cobble Power profile.`), { code: 'invalid_publish_source' })
    }
    if(!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw Object.assign(new Error(`Select ${label} from the selected Cobble Power profile.`), { code: 'invalid_publish_source' })
    }
    return resolvedFile
}

function validatePublishSource(type, filePath, context) {
    const resolved = path.resolve(filePath)
    if(type === 'resource-packs') {
        if(path.extname(resolved).toLowerCase() !== '.zip') throw Object.assign(new Error('Select a Resource Pack ZIP file.'), { code: 'invalid_publish_source' })
        return resolved
    }
    const profileId = String(context.profileId || '')
    if(!/^[A-Za-z0-9._-]{1,96}$/.test(profileId) || profileId === '.' || profileId === '..') {
        throw Object.assign(new Error('The selected profile has an unsafe identifier.'), { code: 'invalid_profile' })
    }
    const profileRoot = path.join(path.resolve(context.instanceDirectory), profileId)
    if(type === 'builder-presets') {
        return ensureFileInside(path.join(profileRoot, 'config', 'cobblepower', 'gradients'), resolved, 'a Builder Preset')
    }
    const owner = normalizeMinecraftUuid(context.playerUuid)
    if(type === 'automation') {
        return ensureFileInside(path.join(profileRoot, 'config', 'cobblepower', 'operations', owner), resolved, 'an Operation or Shared Space')
    }
    if(type === 'battle-trainers') {
        return ensureFileInside(path.join(profileRoot, 'config', 'cobblepower', 'trainers', owner), resolved, 'a Battle Trainer')
    }
    throw Object.assign(new Error(`Unsupported Community publishing type: ${type}.`), { code: 'unsupported_community_type' })
}

function operationAssetId(document) {
    return String(document?.metadata?.asset_id || document?.operationId || '').trim()
}

function operationDependencies(document) {
    return String(document?.metadata?.shared_space_dependencies || '')
        .split(',').map(value => value.trim()).filter(Boolean)
}

function buildAutomationBundle(rootFilePath) {
    const rootPath = path.resolve(rootFilePath)
    const rootDocument = parseDocument(rootPath)
    if(rootDocument.format !== 'cobblepower_operation' || Number(rootDocument.version) !== 1) {
        throw Object.assign(new Error('Select a Cobble Power Operation version 1 JSON file.'), { code: 'invalid_automation_root' })
    }
    const directory = path.dirname(rootPath)
    const documents = new Map()
    for(const name of fs.readdirSync(directory)) {
        if(!name.toLowerCase().endsWith('.json')) continue
        const candidatePath = path.join(directory, name)
        if(!fs.statSync(candidatePath).isFile()) continue
        try {
            const candidate = parseDocument(candidatePath)
            if(candidate.format !== 'cobblepower_operation' || Number(candidate.version) !== 1) continue
            const assetId = operationAssetId(candidate)
            if(assetId) documents.set(assetId, candidate)
        } catch(_error) {
            // Unrelated malformed files do not prevent selecting a valid local Operation.
        }
    }
    const rootId = operationAssetId(rootDocument)
    if(!rootId) throw Object.assign(new Error('The selected Operation has no asset ID.'), { code: 'missing_asset_id' })
    documents.set(rootId, rootDocument)
    const selected = []
    const visiting = new Set()
    const visited = new Set()
    function visit(assetId) {
        if(visited.has(assetId)) return
        if(visiting.has(assetId)) throw Object.assign(new Error('Shared Space dependencies contain a cycle.'), { code: 'dependency_cycle' })
        const document = documents.get(assetId)
        if(!document) throw Object.assign(new Error(`Referenced Shared Space ${assetId} is not present beside the selected Operation.`), { code: 'missing_shared_space' })
        visiting.add(assetId)
        for(const dependency of operationDependencies(document)) visit(dependency)
        visiting.delete(assetId)
        visited.add(assetId)
        selected.push({
            sourceAssetId: assetId,
            kind: String(document.metadata?.asset_kind || (assetId === rootId ? 'operation' : 'shared_space')),
            document
        })
    }
    visit(rootId)
    return Buffer.from(`${JSON.stringify({
        format: 'cobblepower_automation_bundle',
        version: 1,
        rootAssetId: rootId,
        assets: selected
    }, null, 2)}\n`, 'utf8')
}

function prepareCommunityArtifact(type, filePath) {
    const resolved = path.resolve(filePath)
    if(type === 'automation') return buildAutomationBundle(resolved)
    const bytes = fs.readFileSync(resolved)
    if(type === 'battle-trainers' || type === 'builder-presets') parseDocument(resolved)
    return bytes
}

module.exports = {
    buildAutomationBundle,
    operationAssetId,
    operationDependencies,
    parseDocument,
    prepareCommunityArtifact,
    validatePublishSource
}
