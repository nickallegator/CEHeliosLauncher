'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { writeJsonAtomic } = require('./atomicjson')

const INDEX_SCHEMA_VERSION = 1
const ACCOUNT_SCOPED_TYPES = new Set(['automation', 'battle-trainers', 'schematics'])
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,96}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function normalizeSegment(value, label) {
    const normalized = String(value || '').trim()
    if(!SAFE_SEGMENT.test(normalized) || normalized === '.' || normalized === '..') throw new Error(`${label} contains unsafe path characters.`)
    return normalized
}

function hyphenateUuid(value) {
    const compact = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!/^[a-f0-9]{32}$/.test(compact)) throw new Error('A valid Minecraft UUID is required.')
    const normalized = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
    if(!UUID.test(normalized)) throw new Error('A valid Minecraft UUID is required.')
    return normalized
}

function hashBuffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

function hashFile(filePath) {
    return hashBuffer(fs.readFileSync(filePath))
}

function parseJsonBuffer(buffer, label) {
    try {
        const value = JSON.parse(Buffer.from(buffer).toString('utf8'))
        if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
        return value
    } catch(_error) {
        const error = new Error(`${label} is not valid JSON.`)
        error.code = 'invalid_artifact'
        throw error
    }
}

function ensureInside(root, target, label = 'Community content path') {
    const resolvedRoot = path.resolve(root)
    const resolvedTarget = path.resolve(target)
    if(resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`${label} escaped the selected instance.`)
    }
    return resolvedTarget
}

function writeFilesTransaction(entries) {
    const transactionId = crypto.randomUUID()
    const staged = []
    const backups = []
    try {
        for(const entry of entries) {
            fs.mkdirSync(path.dirname(entry.path), { recursive: true })
            if(entry.content != null) {
                const temporaryPath = `${entry.path}.${transactionId}.tmp`
                fs.writeFileSync(temporaryPath, entry.content)
                staged.push({ path: entry.path, temporaryPath })
            } else {
                staged.push({ path: entry.path, temporaryPath: null })
            }
        }
        for(const entry of staged) {
            if(fs.existsSync(entry.path)) {
                const backupPath = `${entry.path}.${transactionId}.bak`
                fs.renameSync(entry.path, backupPath)
                backups.push({ path: entry.path, backupPath })
            }
            if(entry.temporaryPath) fs.renameSync(entry.temporaryPath, entry.path)
        }
        backups.forEach(entry => fs.rmSync(entry.backupPath, { force: true }))
    } catch(error) {
        for(const entry of staged) {
            if(entry.temporaryPath && fs.existsSync(entry.temporaryPath)) fs.rmSync(entry.temporaryPath, { force: true })
            if(fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true })
        }
        for(const entry of [...backups].reverse()) {
            if(fs.existsSync(entry.backupPath)) fs.renameSync(entry.backupPath, entry.path)
        }
        throw error
    }
}

function readOptions(filePath) {
    if(!fs.existsSync(filePath)) return { lines: [], resourcePacks: [] }
    const text = fs.readFileSync(filePath, 'utf8')
    const lines = text.split(/\r?\n/)
    const index = lines.findIndex(line => line.startsWith('resourcePacks:'))
    let resourcePacks = []
    if(index >= 0) {
        try {
            const value = JSON.parse(lines[index].slice('resourcePacks:'.length))
            if(!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('invalid')
            resourcePacks = value
        } catch(_error) {
            const error = new Error('Minecraft options.txt contains an unreadable resourcePacks value.')
            error.code = 'invalid_options_file'
            throw error
        }
    }
    return { lines, resourcePacks, index }
}

function updateResourcePacksOptions(filePath, packId, { enabled = true, highestPriority = true } = {}) {
    const parsed = readOptions(filePath)
    let packs = parsed.resourcePacks.filter(value => value !== packId)
    if(enabled) packs = highestPriority ? [...packs, packId] : [packId, ...packs]
    const line = `resourcePacks:${JSON.stringify(packs)}`
    if(parsed.index >= 0) parsed.lines[parsed.index] = line
    else parsed.lines.push(line)
    return {
        content: Buffer.from(`${parsed.lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8'),
        resourcePacks: packs,
        packId,
        enabled,
        orderIndex: packs.indexOf(packId)
    }
}

function reorderResourcePackOptions(filePath, packId, direction) {
    const parsed = readOptions(filePath)
    const currentIndex = parsed.resourcePacks.indexOf(packId)
    if(currentIndex < 0) throw Object.assign(new Error('Enable this Resource Pack before changing its priority.'), { code: 'resource_pack_disabled' })
    const packs = parsed.resourcePacks.slice()
    let targetIndex = currentIndex
    if(direction === 'higher') targetIndex = Math.min(packs.length - 1, currentIndex + 1)
    else if(direction === 'lower') targetIndex = Math.max(0, currentIndex - 1)
    else if(direction === 'highest') targetIndex = packs.length - 1
    else if(direction === 'lowest') targetIndex = 0
    else throw new Error('Unsupported Resource Pack priority direction.')
    packs.splice(currentIndex, 1)
    packs.splice(targetIndex, 0, packId)
    const line = `resourcePacks:${JSON.stringify(packs)}`
    if(parsed.index >= 0) parsed.lines[parsed.index] = line
    else parsed.lines.push(line)
    return {
        content: Buffer.from(`${parsed.lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8'),
        resourcePacks: packs,
        packId,
        enabled: true,
        orderIndex: packs.indexOf(packId)
    }
}

function resourcePackState(filePath, packId) {
    try {
        const parsed = readOptions(filePath)
        const orderIndex = parsed.resourcePacks.indexOf(packId)
        return { packId, enabled: orderIndex >= 0, orderIndex, total: parsed.resourcePacks.length }
    } catch(_error) {
        return { packId, enabled: false, orderIndex: -1, total: 0, unreadable: true }
    }
}

function remapPortableValue(value, mappings) {
    const text = String(value ?? '')
    return mappings[text] || text
}

function adaptAutomationBundle(bundle, existingMappings = {}) {
    if(bundle?.format !== 'cobblepower_automation_bundle' || Number(bundle.version) !== 1 || !Array.isArray(bundle.assets)) {
        throw Object.assign(new Error('Unsupported Automation bundle.'), { code: 'unsupported_artifact' })
    }
    const mappings = {
        assets: { ...(existingMappings.assets || {}) },
        nodes: { ...(existingMappings.nodes || {}) },
        edges: { ...(existingMappings.edges || {}) }
    }
    for(const asset of bundle.assets) {
        if(!mappings.assets[asset.id]) mappings.assets[asset.id] = crypto.randomUUID()
        mappings.nodes[asset.id] = { ...(mappings.nodes[asset.id] || {}) }
        mappings.edges[asset.id] = { ...(mappings.edges[asset.id] || {}) }
        for(const node of asset.graph?.nodes || []) {
            if(!mappings.nodes[asset.id][node.id]) mappings.nodes[asset.id][node.id] = crypto.randomUUID()
        }
        for(const edge of asset.graph?.edges || []) {
            if(!mappings.edges[asset.id][edge.id]) mappings.edges[asset.id][edge.id] = crypto.randomUUID()
        }
    }
    const flat = { ...mappings.assets }
    for(const [assetPortableId, nodeMappings] of Object.entries(mappings.nodes)) {
        for(const [nodePortableId, localUuid] of Object.entries(nodeMappings)) {
            flat[`${assetPortableId}/${nodePortableId}`] = localUuid
        }
    }
    for(const [assetPortableId, edgeMappings] of Object.entries(mappings.edges)) {
        for(const [edgePortableId, localUuid] of Object.entries(edgeMappings)) {
            flat[`${assetPortableId}/${edgePortableId}`] = localUuid
        }
    }
    const documents = bundle.assets.map(asset => {
        const assetId = mappings.assets[asset.id]
        const dependencies = (asset.dependencies || []).map(value => mappings.assets[value]).filter(Boolean)
        const nodes = (asset.graph?.nodes || []).map(node => ({
            nodeId: mappings.nodes[asset.id][node.id],
            blockTypeId: node.dynamicCall
                ? `cobblepower:call_shared_function_${String(mappings.assets[node.dynamicCall.asset] || '').replaceAll('-', '')}_${String(mappings.nodes[node.dynamicCall.asset]?.[node.dynamicCall.functionNode] || '').replaceAll('-', '')}`
                : remapPortableValue(node.type, flat),
            x: Number(node.x) || 0,
            y: Number(node.y) || 0,
            parameters: Object.fromEntries(Object.entries(node.parameters || {}).map(([key, value]) => [key, remapPortableValue(value, flat)]))
        }))
        const edges = (asset.graph?.edges || []).map(edge => ({
            edgeId: mappings.edges[asset.id][edge.id],
            fromNodeId: mappings.nodes[asset.id][edge.fromNode],
            fromPin: String(edge.fromPin || ''),
            toNodeId: mappings.nodes[asset.id][edge.toNode],
            toPin: String(edge.toPin || ''),
            ...(Array.isArray(edge.route) && edge.route.length ? { routePoints: edge.route } : {})
        }))
        return {
            id: assetId,
            document: {
                format: 'cobblepower_operation',
                version: 1,
                operationId: assetId,
                name: String(asset.name || (asset.kind === 'shared_space' ? 'Shared Space' : 'Operation')),
                updatedAt: Date.now(),
                metadata: {
                    asset_kind: asset.kind === 'shared_space' ? 'shared_space' : 'operation',
                    asset_id: assetId,
                    ...(dependencies.length ? { shared_space_dependencies: dependencies.join(',') } : {})
                },
                graph: { nodes, edges }
            }
        }
    })
    return { documents, mappings }
}

function adaptTrainer(trainer, playerUuid, stableId = null) {
    if(trainer?.format !== 'cobblepower_battle_projector_trainer' || Number(trainer.version) !== 1) {
        throw Object.assign(new Error('Unsupported Battle Trainer.'), { code: 'unsupported_artifact' })
    }
    const owner = hyphenateUuid(playerUuid)
    const trainerId = stableId || crypto.randomUUID()
    return {
        trainerId,
        document: {
            ...trainer,
            id: `cobblepower:client_trainers/${owner}/${trainerId}`
        }
    }
}

function adaptGradient(gradient, title) {
    if(gradient?.format !== 'cobblepower_gradient' || Number(gradient.version) !== 1) {
        throw Object.assign(new Error('Unsupported Builder Preset.'), { code: 'unsupported_artifact' })
    }
    return { ...gradient, metadata: { ...(gradient.metadata || {}), name: String(title || 'Community Preset') } }
}

class CommunityInstallManager {
    constructor(options = {}) {
        this.instanceDirectory = path.resolve(options.instanceDirectory)
        this.launcherDirectory = path.resolve(options.launcherDirectory)
        this.indexPath = options.indexPath || path.join(this.launcherDirectory, 'community-cache', 'install-index-v1.json')
        this.isGameRunning = options.isGameRunning || (() => false)
        this.index = this.loadIndex()
    }

    loadIndex() {
        try {
            const value = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
            return value?.schemaVersion === INDEX_SCHEMA_VERSION && Array.isArray(value.items) ? value.items : []
        } catch(_error) {
            return []
        }
    }

    saveIndex() {
        writeJsonAtomic(this.indexPath, { schemaVersion: INDEX_SCHEMA_VERSION, items: this.index })
    }

    instanceRoot(profileId) {
        return ensureInside(this.instanceDirectory, path.join(this.instanceDirectory, normalizeSegment(profileId, 'Profile id')), 'Instance path')
    }

    key(profileId, playerUuid, type, itemId) {
        const account = ACCOUNT_SCOPED_TYPES.has(type) ? hyphenateUuid(playerUuid) : '_profile'
        return `${normalizeSegment(profileId, 'Profile id')}:${account}:${normalizeSegment(type, 'Community type')}:${normalizeSegment(itemId, 'Community item id')}`
    }

    get(profileId, playerUuid, type, itemId) {
        const key = this.key(profileId, playerUuid, type, itemId)
        return this.index.find(item => item.key === key) || null
    }

    assertRecordUnmodified(record, confirmModified) {
        if(!record) return
        const modified = (record.managedFiles || []).filter(file => {
            if(!fs.existsSync(file.path)) return false
            return hashFile(file.path) !== file.sha256
        })
        if(record.type === 'resource-packs' && record.resourcePackState) {
            const options = resourcePackState(record.resourcePackState.optionsPath, record.resourcePackState.packId)
            if(options.enabled !== record.resourcePackState.enabled
                || options.orderIndex !== record.resourcePackState.orderIndex
            ) {
                modified.push({ path: record.resourcePackState.optionsPath, kind: 'resource-pack-order' })
            }
        }
        if(modified.length === 0) return
        if(typeof confirmModified === 'function' && confirmModified(modified.map(value => value.path))) return
        const error = new Error('One or more launcher-managed Community files were modified locally.')
        error.code = 'locally_modified'
        error.paths = modified.map(value => value.path)
        throw error
    }

    status(profileId, playerUuid, entry) {
        const record = this.get(profileId, playerUuid, entry.type, entry.id)
        if(!record) return { state: 'install', record: null }
        const missing = (record.managedFiles || []).some(file => !fs.existsSync(file.path))
        if(missing) return { state: 'repair', record }
        const modified = (record.managedFiles || []).some(file => hashFile(file.path) !== file.sha256)
        if(modified) return { state: 'modified', record }
        if(record.type === 'resource-packs' && record.resourcePackState) {
            const current = resourcePackState(record.resourcePackState.optionsPath, record.resourcePackState.packId)
            if(!current.enabled) return { state: 'disabled', record }
            if(current.orderIndex !== record.resourcePackState.orderIndex) return { state: 'modified', record }
        }
        if(entry.revision?.sha256 && entry.revision.sha256 !== record.sourceSha256) return { state: 'update', record }
        return { state: 'installed', record }
    }

    install({ profileId, playerUuid, entry, artifact, confirmModified }) {
        if(!entry?.type || !entry?.id || !entry?.revision?.sha256) throw new Error('Community revision metadata is missing.')
        const input = Buffer.isBuffer(artifact) ? artifact : Buffer.from(artifact)
        if(hashBuffer(input) !== entry.revision.sha256) {
            const error = new Error('Downloaded Community artifact failed its SHA-256 integrity check.')
            error.code = 'hash_mismatch'
            throw error
        }
        const existing = this.get(profileId, playerUuid, entry.type, entry.id)
        this.assertRecordUnmodified(existing, confirmModified)
        const root = this.instanceRoot(profileId)
        const writes = []
        const metadata = {}

        if(entry.type === 'automation') {
            const adapted = adaptAutomationBundle(parseJsonBuffer(input, 'Automation bundle'), existing?.mappings)
            metadata.mappings = adapted.mappings
            const owner = hyphenateUuid(playerUuid)
            for(const value of adapted.documents) {
                writes.push({
                    path: ensureInside(root, path.join(root, 'config', 'cobblepower', 'operations', owner, `${value.id}.json`)),
                    content: Buffer.from(`${JSON.stringify(value.document, null, 2)}\n`, 'utf8')
                })
            }
        } else if(entry.type === 'battle-trainers') {
            const adapted = adaptTrainer(parseJsonBuffer(input, 'Battle Trainer'), playerUuid, existing?.trainerId)
            metadata.trainerId = adapted.trainerId
            const owner = hyphenateUuid(playerUuid)
            writes.push({
                path: ensureInside(root, path.join(root, 'config', 'cobblepower', 'trainers', owner, `${adapted.trainerId}.json`)),
                content: Buffer.from(`${JSON.stringify(adapted.document, null, 2)}\n`, 'utf8')
            })
        } else if(entry.type === 'builder-presets') {
            const adapted = adaptGradient(parseJsonBuffer(input, 'Builder Preset'), entry.title)
            writes.push({
                path: ensureInside(root, path.join(root, 'config', 'cobblepower', 'gradients', `ag-community-${normalizeSegment(entry.id, 'Community item id')}.json`)),
                content: Buffer.from(`${JSON.stringify(adapted, null, 2)}\n`, 'utf8')
            })
        } else if(entry.type === 'resource-packs') {
            if(this.isGameRunning()) {
                const error = new Error('Close Minecraft before changing Resource Packs.')
                error.code = 'game_running'
                throw error
            }
            const filename = `ag-community-${normalizeSegment(entry.id, 'Community item id')}.zip`
            const packPath = ensureInside(root, path.join(root, 'resourcepacks', filename))
            const optionsPath = ensureInside(root, path.join(root, 'options.txt'))
            const backupPath = ensureInside(root, path.join(root, 'options.txt.ag-launcher.bak'))
            const packId = `file/${filename}`
            const options = updateResourcePacksOptions(optionsPath, packId, { enabled: true, highestPriority: true })
            writes.push({ path: packPath, content: input })
            writes.push({ path: backupPath, content: fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath) : Buffer.alloc(0) })
            writes.push({ path: optionsPath, content: options.content })
            metadata.resourcePackState = { optionsPath, backupPath, packId, enabled: true, orderIndex: options.orderIndex }
        } else {
            throw Object.assign(new Error(`Unsupported Community type: ${entry.type}`), { code: 'unsupported_type' })
        }

        const newPaths = new Set(writes.map(value => value.path))
        for(const old of existing?.managedFiles || []) {
            if(!newPaths.has(old.path)) writes.push({ path: old.path, content: null })
        }
        const existingManagedPaths = new Set((existing?.managedFiles || []).map(value => value.path))
        const sharedStatePaths = new Set([
            metadata.resourcePackState?.optionsPath,
            metadata.resourcePackState?.backupPath
        ].filter(Boolean))
        const untracked = writes.filter(value => value.content != null
            && fs.existsSync(value.path)
            && !existingManagedPaths.has(value.path)
            && !sharedStatePaths.has(value.path))
        if(untracked.length > 0
            && !(typeof confirmModified === 'function' && confirmModified(untracked.map(value => value.path)))) {
            const error = new Error('A Community installation target already exists and is not managed by AG Launcher.')
            error.code = 'untracked_file'
            error.paths = untracked.map(value => value.path)
            throw error
        }
        writeFilesTransaction(writes)
        const managedFiles = writes.filter(value => value.content != null
            && value.path !== metadata.resourcePackState?.optionsPath
            && value.path !== metadata.resourcePackState?.backupPath).map(value => ({
            path: value.path,
            sha256: hashFile(value.path)
        }))
        const record = {
            key: this.key(profileId, playerUuid, entry.type, entry.id),
            profileId: normalizeSegment(profileId, 'Profile id'),
            playerUuid: ACCOUNT_SCOPED_TYPES.has(entry.type) ? hyphenateUuid(playerUuid) : null,
            type: entry.type,
            itemId: entry.id,
            title: entry.title,
            sourceRevisionId: entry.revision.id,
            sourceRevisionNumber: Number(entry.revision.number),
            sourceSha256: entry.revision.sha256,
            managedFiles,
            dependencies: entry.dependencies || [],
            installedAt: new Date().toISOString(),
            ...metadata
        }
        this.index = this.index.filter(item => item.key !== record.key)
        this.index.push(record)
        this.saveIndex()
        return record
    }

    setResourcePackEnabled({ profileId, itemId, enabled, confirmModified }) {
        const record = this.get(profileId, null, 'resource-packs', itemId)
        if(!record) return false
        this.assertRecordUnmodified(record, confirmModified)
        if(this.isGameRunning()) throw Object.assign(new Error('Close Minecraft before changing Resource Packs.'), { code: 'game_running' })
        const current = updateResourcePacksOptions(record.resourcePackState.optionsPath, record.resourcePackState.packId, { enabled, highestPriority: true })
        const original = fs.existsSync(record.resourcePackState.optionsPath)
            ? fs.readFileSync(record.resourcePackState.optionsPath)
            : Buffer.alloc(0)
        writeFilesTransaction([
            { path: record.resourcePackState.backupPath, content: original },
            { path: record.resourcePackState.optionsPath, content: current.content }
        ])
        record.resourcePackState.enabled = enabled
        record.resourcePackState.orderIndex = current.orderIndex
        this.saveIndex()
        return true
    }

    reorderResourcePack({ profileId, itemId, direction, confirmModified }) {
        const record = this.get(profileId, null, 'resource-packs', itemId)
        if(!record) return false
        this.assertRecordUnmodified(record, confirmModified)
        if(this.isGameRunning()) throw Object.assign(new Error('Close Minecraft before changing Resource Packs.'), { code: 'game_running' })
        const current = reorderResourcePackOptions(
            record.resourcePackState.optionsPath,
            record.resourcePackState.packId,
            direction
        )
        const original = fs.existsSync(record.resourcePackState.optionsPath)
            ? fs.readFileSync(record.resourcePackState.optionsPath)
            : Buffer.alloc(0)
        writeFilesTransaction([
            { path: record.resourcePackState.backupPath, content: original },
            { path: record.resourcePackState.optionsPath, content: current.content }
        ])
        record.resourcePackState.orderIndex = current.orderIndex
        this.saveIndex()
        return true
    }

    remove({ profileId, playerUuid, type, itemId, confirmModified }) {
        const record = this.get(profileId, playerUuid, type, itemId)
        if(!record) return false
        this.assertRecordUnmodified(record, confirmModified)
        if(type === 'resource-packs' && this.isGameRunning()) throw Object.assign(new Error('Close Minecraft before changing Resource Packs.'), { code: 'game_running' })
        const writes = (record.managedFiles || []).map(file => ({ path: file.path, content: null }))
        if(type === 'resource-packs' && record.resourcePackState) {
            const options = updateResourcePacksOptions(record.resourcePackState.optionsPath, record.resourcePackState.packId, { enabled: false })
            writes.push({
                path: record.resourcePackState.backupPath,
                content: fs.existsSync(record.resourcePackState.optionsPath) ? fs.readFileSync(record.resourcePackState.optionsPath) : Buffer.alloc(0)
            })
            writes.push({ path: record.resourcePackState.optionsPath, content: options.content })
        }
        writeFilesTransaction(writes)
        this.index = this.index.filter(item => item.key !== record.key)
        this.saveIndex()
        return true
    }
}

module.exports = {
    ACCOUNT_SCOPED_TYPES,
    CommunityInstallManager,
    INDEX_SCHEMA_VERSION,
    adaptAutomationBundle,
    adaptGradient,
    adaptTrainer,
    ensureInside,
    hashBuffer,
    hashFile,
    hyphenateUuid,
    readOptions,
    resourcePackState,
    reorderResourcePackOptions,
    updateResourcePacksOptions,
    writeFilesTransaction
}
