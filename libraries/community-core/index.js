'use strict'

const crypto = require('crypto')

const TYPES = Object.freeze({
    AUTOMATION: 'automation',
    BATTLE_TRAINERS: 'battle-trainers',
    BUILDER_PRESETS: 'builder-presets',
    RESOURCE_PACKS: 'resource-packs'
})

const JSON_LIMITS = Object.freeze({
    [TYPES.AUTOMATION]: 1024 * 1024,
    [TYPES.BATTLE_TRAINERS]: 256 * 1024,
    [TYPES.BUILDER_PRESETS]: 256 * 1024
})

const FORMAT_CONTRACTS = Object.freeze({
    [TYPES.AUTOMATION]: Object.freeze({ id: 'cobblepower_automation_bundle', version: 1, extension: 'json', mime: 'application/json' }),
    [TYPES.BATTLE_TRAINERS]: Object.freeze({ id: 'cobblepower_battle_projector_trainer', version: 1, extension: 'json', mime: 'application/json' }),
    [TYPES.BUILDER_PRESETS]: Object.freeze({ id: 'cobblepower_gradient', version: 1, extension: 'json', mime: 'application/json' }),
    [TYPES.RESOURCE_PACKS]: Object.freeze({ id: 'minecraft_resource_pack', version: 1, extension: 'zip', mime: 'application/zip' })
})

const DEFAULT_COMPATIBILITY = Object.freeze({
    minecraft: '1.21.1',
    loader: 'neoforge',
    cobblePower: '>=1.0.4-test.1 <1.1.0',
    cobblemon: '>=1.6.0 <1.7.0'
})

const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const UUID_ANY = /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/ig
class CommunityValidationError extends Error {
    constructor(code, message, details = null) {
        super(message)
        this.name = 'CommunityValidationError'
        this.code = code
        this.details = details
        this.statusCode = 400
    }
}

function fail(code, message, details = null) {
    throw new CommunityValidationError(code, message, details)
}

function isPlainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

function deepSort(value) {
    if(Array.isArray(value)) return value.map(deepSort)
    if(!isPlainObject(value)) {
        if(typeof value === 'number' && Number.isFinite(value)) return Number(value.toFixed(6))
        return value
    }
    return Object.keys(value).sort().reduce((output, key) => {
        output[key] = deepSort(value[key])
        return output
    }, {})
}

function stableStringify(value) {
    return `${JSON.stringify(deepSort(value), null, 2)}\n`
}

function digestSerialized(serialized) {
    const bytes = Buffer.byteLength(serialized)
    return {
        serialized,
        sizeBytes: bytes,
        sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex')
    }
}

function parseJsonArtifact(input, maxBytes, label) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8')
    if(buffer.length === 0 || buffer.length > maxBytes) {
        fail('invalid_artifact_size', `${label} must be between 1 and ${maxBytes} bytes.`, { maxBytes, actualBytes: buffer.length })
    }
    let value
    try {
        value = typeof input === 'object' && !Buffer.isBuffer(input) ? input : JSON.parse(buffer.toString('utf8'))
    } catch(_error) {
        fail('invalid_json', `${label} is not valid JSON.`)
    }
    if(!isPlainObject(value)) fail('invalid_document', `${label} must contain a JSON object.`)
    return value
}

function requireFormat(value, format, { allowMissing = false } = {}) {
    if(!allowMissing && value.format !== format.id) {
        fail('unsupported_artifact_format', `Expected ${format.id} format.`)
    }
    if(value.format != null && value.format !== format.id) {
        fail('unsupported_artifact_format', `Expected ${format.id} format.`)
    }
    const version = Number(value.version)
    if(!Number.isInteger(version) || version !== format.version) {
        const code = version > format.version ? 'future_artifact_version' : 'unsupported_artifact_version'
        fail(code, `${format.id} version ${String(value.version)} is not supported; expected version ${format.version}.`)
    }
}

function cleanText(value, max, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : ''
    return (text || fallback).slice(0, max)
}

function resourceLocation(value, label, { allowEmpty = false } = {}) {
    const normalized = cleanText(value, 256).toLowerCase()
    if(allowEmpty && !normalized) return ''
    if(!RESOURCE_LOCATION.test(normalized)) fail('invalid_resource_location', `${label} must be a namespaced identifier.`)
    return normalized
}

function finiteNumber(value, label, min, max, fallback = null) {
    const number = Number(value)
    if(!Number.isFinite(number)) {
        if(fallback != null) return fallback
        fail('invalid_number', `${label} must be a finite number.`)
    }
    if(number < min || number > max) fail('number_out_of_range', `${label} must be between ${min} and ${max}.`)
    return Number(number.toFixed(6))
}

function integer(value, label, min, max, fallback = null) {
    const number = Number(value)
    if(!Number.isInteger(number)) {
        if(fallback != null) return fallback
        fail('invalid_integer', `${label} must be an integer.`)
    }
    if(number < min || number > max) fail('integer_out_of_range', `${label} must be between ${min} and ${max}.`)
    return number
}

function stablePortableIds(values, prefix, identity) {
    const sorted = [...values].sort((left, right) => identity(left).localeCompare(identity(right)))
    return new Map(sorted.map((value, index) => [identity(value), `${prefix}-${String(index + 1).padStart(4, '0')}`]))
}

const PORTABLE_REFERENCE_KEYS = new Set([
    'shared_space_asset_id', 'call_shared_space_asset_id',
    'shared_variable_id', 'function_start_node_id', 'call_function_start_node_id'
])

const PORTABLE_ASSET_REFERENCE_KEYS = new Set([
    'shared_space_asset_id', 'call_shared_space_asset_id'
])

const DYNAMIC_SHARED_FUNCTION = /^cobblepower:call_shared_function_([a-f0-9]{32})_([a-f0-9]{32})$/i

function expandUuidToken(value) {
    const token = String(value || '').toLowerCase()
    if(!/^[a-f0-9]{32}$/.test(token)) return null
    return `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`
}

function portableParameter(value, key, mappings) {
    const text = cleanText(value, 2048)
    if(PORTABLE_REFERENCE_KEYS.has(key)) {
        if(PORTABLE_ASSET_REFERENCE_KEYS.has(key) && mappings.asset.has(text)) return mappings.asset.get(text)
        if(!PORTABLE_ASSET_REFERENCE_KEYS.has(key)) {
            const referencedAsset = cleanText(
                mappings.parameters?.call_shared_space_asset_id || mappings.parameters?.shared_space_asset_id,
                80,
                mappings.sourceAssetId
            )
            const qualified = mappings.node.get(`${referencedAsset}/${text}`)
            if(qualified) return qualified
        }
        fail('unresolved_automation_reference', `Automation parameter ${key} refers to an asset or node that is not bundled.`)
    }
    if(/(?:player|pokemon|owner)_?(?:id|uuid)/i.test(key) && UUID.test(text)) {
        fail('non_portable_identity', `Automation parameter ${key} contains a fixed player or Pokémon identity.`)
    }
    if(/(?:dimension|world|position|block_pos|coordinates?)/i.test(key) && /(?:^-?\d+[, ]+-?\d+[, ]+-?\d+$|^[a-z0-9_.-]+:[a-z0-9/._-]+$)/i.test(text)) {
        fail('non_portable_world_reference', `Automation parameter ${key} contains an absolute world reference.`)
    }
    const unknownUuid = text.match(UUID_ANY)?.[0]
    if(unknownUuid && !mappings.asset.has(unknownUuid) && !mappings.node.has(unknownUuid)) {
        fail('non_portable_uuid', `Automation parameter ${key} contains a fixed UUID that cannot be remapped.`)
    }
    return text
}

function canonicalizeAutomation(input, options = {}) {
    const format = FORMAT_CONTRACTS[TYPES.AUTOMATION]
    const root = parseJsonArtifact(input, JSON_LIMITS[TYPES.AUTOMATION], 'Automation bundle')
    requireFormat(root, format)
    const sourceAssets = Array.isArray(root.assets) ? root.assets : []
    if(sourceAssets.length < 1 || sourceAssets.length > 32) fail('automation_asset_limit', 'Automation bundles must contain between 1 and 32 assets.')

    const prepared = sourceAssets.map((entry, index) => {
        const document = isPlainObject(entry?.document) ? entry.document : entry
        if(document.format !== 'cobblepower_operation' || Number(document.version) !== 1) {
            fail('invalid_automation_asset', `Automation asset ${index + 1} is not a cobblepower_operation version 1 document.`)
        }
        const sourceId = cleanText(entry.sourceAssetId || entry.assetId || document.metadata?.asset_id || document.operationId, 80)
        if(!sourceId) fail('missing_automation_asset_id', `Automation asset ${index + 1} has no source asset ID.`)
        const kind = cleanText(entry.kind || document.metadata?.asset_kind, 24, 'operation').toLowerCase()
        if(!['operation', 'shared_space'].includes(kind)) fail('invalid_automation_asset_kind', `Automation asset ${sourceId} has an unsupported kind.`)
        return { entry, document, sourceId, kind }
    })
    if(new Set(prepared.map(asset => asset.sourceId)).size !== prepared.length) fail('duplicate_automation_asset', 'Automation bundle contains duplicate asset IDs.')

    const rootSourceId = cleanText(root.rootAssetId, 80) || prepared.find(asset => asset.kind === 'operation')?.sourceId || prepared[0].sourceId
    if(!prepared.some(asset => asset.sourceId === rootSourceId)) fail('missing_automation_root', 'Automation rootAssetId does not identify a bundled asset.')
    const ordered = [prepared.find(asset => asset.sourceId === rootSourceId), ...prepared.filter(asset => asset.sourceId !== rootSourceId).sort((a, b) => a.sourceId.localeCompare(b.sourceId))]
    const assetMap = new Map(ordered.map((asset, index) => [asset.sourceId, `asset-${String(index + 1).padStart(3, '0')}`]))

    const nodeMaps = new Map()
    const globalNodeMap = new Map()
    for(const asset of ordered) {
        const nodes = Array.isArray(asset.document.graph?.nodes) ? asset.document.graph.nodes : []
        const localMap = stablePortableIds(nodes, 'node', node => cleanText(node?.nodeId, 80))
        if(localMap.has('')) fail('missing_automation_node_id', `Asset ${asset.sourceId} contains a node without an ID.`)
        if(localMap.size !== nodes.length) fail('duplicate_automation_node', `Asset ${asset.sourceId} contains duplicate node IDs.`)
        for(const [sourceNodeId, portableNodeId] of localMap) {
            globalNodeMap.set(`${asset.sourceId}/${sourceNodeId}`, `${assetMap.get(asset.sourceId)}/${portableNodeId}`)
        }
        nodeMaps.set(asset.sourceId, localMap)
    }

    let totalNodes = 0
    let totalEdges = 0
    const assets = ordered.map(asset => {
        const graph = isPlainObject(asset.document.graph) ? asset.document.graph : {}
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
        const edges = Array.isArray(graph.edges) ? graph.edges : []
        totalNodes += nodes.length
        totalEdges += edges.length
        if(totalNodes > 2048) fail('automation_node_limit', 'Automation bundles may contain at most 2,048 nodes.')
        if(totalEdges > 4096) fail('automation_edge_limit', 'Automation bundles may contain at most 4,096 edges.')
        const nodeMap = nodeMaps.get(asset.sourceId)
        const edgeMap = stablePortableIds(edges, 'edge', edge => cleanText(edge?.edgeId, 80))
        if(edgeMap.has('')) fail('missing_automation_edge_id', `Asset ${asset.sourceId} contains an edge without an ID.`)
        if(edgeMap.size !== edges.length) fail('duplicate_automation_edge', `Asset ${asset.sourceId} contains duplicate edge IDs.`)
        const mappings = { asset: assetMap, node: globalNodeMap }
        const canonicalNodes = nodes.map(node => {
            const sourceType = resourceLocation(node.blockTypeId, 'Automation node type')
            const dynamicMatch = sourceType.match(DYNAMIC_SHARED_FUNCTION)
            let dynamicCall
            let type = sourceType
            if(dynamicMatch) {
                const sourceAssetId = expandUuidToken(dynamicMatch[1])
                const sourceFunctionNodeId = expandUuidToken(dynamicMatch[2])
                const portableAssetId = assetMap.get(sourceAssetId)
                const qualifiedNodeId = globalNodeMap.get(`${sourceAssetId}/${sourceFunctionNodeId}`)
                const [nodeAssetId, portableFunctionNodeId] = String(qualifiedNodeId || '').split('/')
                if(!portableAssetId || nodeAssetId !== portableAssetId || !portableFunctionNodeId) {
                    fail('unresolved_imported_function', 'An imported Shared Space function refers to an asset or function node that is not bundled.')
                }
                type = 'cobblepower:call_shared_function'
                dynamicCall = { asset: portableAssetId, functionNode: portableFunctionNodeId }
            }
            if(options.allowedNodeTypes && !options.allowedNodeTypes.has(type) && !dynamicCall) {
                fail('unknown_automation_node_type', `Automation node type ${sourceType} is not supported by this release.`)
            }
            const parameters = isPlainObject(node.parameters) ? Object.keys(node.parameters).sort().reduce((output, key) => {
                output[key] = portableParameter(node.parameters[key], key, {
                    ...mappings,
                    sourceAssetId: asset.sourceId,
                    parameters: node.parameters
                })
                return output
            }, {}) : {}
            return {
                id: nodeMap.get(String(node.nodeId)),
                type,
                ...(dynamicCall ? { dynamicCall } : {}),
                x: integer(node.x, 'Automation node x', -1000000, 1000000, 0),
                y: integer(node.y, 'Automation node y', -1000000, 1000000, 0),
                parameters
            }
        }).sort((a, b) => a.id.localeCompare(b.id))
        const canonicalEdges = edges.map(edge => {
            const from = nodeMap.get(String(edge.fromNodeId))
            const to = nodeMap.get(String(edge.toNodeId))
            if(!from || !to) fail('dangling_automation_edge', `Asset ${asset.sourceId} contains an edge connected to a missing node.`)
            return {
                id: edgeMap.get(String(edge.edgeId)),
                fromNode: from,
                fromPin: cleanText(edge.fromPin, 128),
                toNode: to,
                toPin: cleanText(edge.toPin, 128),
                route: (Array.isArray(edge.routePoints) ? edge.routePoints : []).slice(0, 256).map(point => ({
                    x: integer(point?.x, 'Automation route x', -1000000, 1000000, 0),
                    y: integer(point?.y, 'Automation route y', -1000000, 1000000, 0)
                }))
            }
        }).sort((a, b) => a.id.localeCompare(b.id))
        const rawDependencies = cleanText(asset.document.metadata?.shared_space_dependencies, 4096)
            .split(',').map(value => value.trim()).filter(Boolean)
        const dependencies = Array.from(new Set(rawDependencies.map(value => {
            const mapped = assetMap.get(value)
            if(!mapped) fail('unresolved_shared_space', `Automation asset ${asset.sourceId} references an unbundled Shared Space.`)
            return mapped
        }))).sort()
        return {
            id: assetMap.get(asset.sourceId),
            kind: asset.kind,
            name: cleanText(asset.document.name, 80, asset.kind === 'shared_space' ? 'Shared Space' : 'Operation'),
            dependencies,
            graph: { nodes: canonicalNodes, edges: canonicalEdges }
        }
    })

    const canonical = {
        format: format.id,
        version: format.version,
        rootAsset: assetMap.get(rootSourceId),
        assets
    }
    const digest = digestSerialized(stableStringify(canonical))
    if(digest.sizeBytes > JSON_LIMITS[TYPES.AUTOMATION]) fail('automation_size_limit', 'Canonical Automation bundle exceeds 1 MiB.')
    return {
        ...digest,
        canonical,
        format,
        typeData: {
            subtype: assets.find(asset => asset.id === canonical.rootAsset)?.kind || 'operation',
            assetCount: assets.length,
            nodeCount: totalNodes,
            edgeCount: totalEdges,
            dependencyCount: Math.max(0, assets.length - 1),
            portable: true
        },
        dependencies: []
    }
}

function stringList(value, length, maxText = 128) {
    const source = Array.isArray(value) ? value : []
    return Array.from({ length }, (_, index) => cleanText(source[index], maxText).toLowerCase())
}

function statList(value, label, max, totalMax = null, fallback = 0) {
    const source = Array.isArray(value) ? value : []
    const result = Array.from({ length: 6 }, (_, index) => integer(source[index], `${label} ${index + 1}`, 0, max, fallback))
    if(totalMax != null && result.reduce((sum, item) => sum + item, 0) > totalMax) fail('stat_total_exceeded', `${label} total may not exceed ${totalMax}.`)
    return result
}

function canonicalizeTrainer(input) {
    const format = FORMAT_CONTRACTS[TYPES.BATTLE_TRAINERS]
    const root = parseJsonArtifact(input, JSON_LIMITS[TYPES.BATTLE_TRAINERS], 'Battle Trainer')
    requireFormat(root, format)
    const sourceTeam = Array.isArray(root.team) ? root.team : []
    if(sourceTeam.length > 6) fail('trainer_party_limit', 'Battle Trainers may contain at most six party slots.')
    const team = sourceTeam.map((pokemon, index) => {
        if(!isPlainObject(pokemon)) fail('invalid_trainer_slot', `Battle Trainer party slot ${index + 1} is invalid.`)
        const species = resourceLocation(pokemon.species, `Party slot ${index + 1} species`)
        const gender = cleanText(pokemon.gender, 16, 'MALE').toUpperCase()
        if(!['MALE', 'FEMALE', 'GENDERLESS'].includes(gender)) fail('invalid_trainer_gender', `Party slot ${index + 1} has an invalid gender.`)
        return {
            species,
            form: cleanText(pokemon.form, 80).toLowerCase(),
            level: integer(pokemon.level, `Party slot ${index + 1} level`, 1, 100, 50),
            gender,
            nature: cleanText(pokemon.nature, 64, 'hardy').toLowerCase(),
            ability: cleanText(pokemon.ability, 128).toLowerCase(),
            moves: stringList(pokemon.moves, 4),
            ivs: statList(pokemon.ivs, `Party slot ${index + 1} IV`, 31, null, 31),
            evs: statList(pokemon.evs, `Party slot ${index + 1} EV`, 255, 500, 0)
        }
    })
    if(team.length === 0) fail('empty_trainer_party', 'Battle Trainers must contain at least one configured Pokémon.')
    const skinId = resourceLocation(root.skin_id || 'cobblepower:default', 'Battle Trainer skin ID')
    const canonical = {
        format: format.id,
        version: format.version,
        name: cleanText(root.name, 80, 'Trainer'),
        skin_id: skinId,
        skill: integer(root.skill, 'Battle Trainer skill', 0, 10, 3),
        team
    }
    const strippedFields = ['id', 'texture', 'copied_skin_png', 'copied_skin_model_type', 'copied_skin_label']
        .filter(key => root[key] != null && String(root[key]).length > 0)
    const dependencies = Array.isArray(root.communityDependencies) ? root.communityDependencies.map(dependency => ({
        type: TYPES.RESOURCE_PACKS,
        itemId: cleanText(dependency?.itemId, 80),
        revisionId: cleanText(dependency?.revisionId, 80)
    })).filter(dependency => dependency.itemId) : []
    if(!skinId.startsWith('cobblepower:') && !dependencies.length) {
        fail('trainer_skin_dependency_required', 'Custom Battle Trainer skins require a declared Community Resource Pack dependency.')
    }
    const digest = digestSerialized(stableStringify(canonical))
    return {
        ...digest,
        canonical,
        format,
        typeData: {
            partySize: team.length,
            species: team.map(pokemon => pokemon.species),
            minLevel: Math.min(...team.map(pokemon => pokemon.level)),
            maxLevel: Math.max(...team.map(pokemon => pokemon.level)),
            skill: canonical.skill,
            skinId,
            strippedFields
        },
        dependencies
    }
}

function objectArray(value, label, max) {
    const result = Array.isArray(value) ? value : []
    if(result.length > max) fail('preset_structure_limit', `${label} may contain at most ${max} entries.`)
    if(result.some(item => !isPlainObject(item))) fail('invalid_preset_structure', `${label} must contain objects.`)
    return result
}

function canonicalizeGradient(input) {
    const format = FORMAT_CONTRACTS[TYPES.BUILDER_PRESETS]
    const root = parseJsonArtifact(input, JSON_LIMITS[TYPES.BUILDER_PRESETS], 'Builder Preset')
    requireFormat(root, format)
    const nodes = objectArray(root.nodes, 'Gradient nodes', 128).map((node, index) => {
        const shapes = objectArray(node.shape_nodes, `Gradient node ${index + 1} shape nodes`, 2048)
        return {
            id: index + 1,
            x: finiteNumber(node.x, 'Gradient x', 0, 1, 0),
            y: finiteNumber(node.y, 'Gradient y', 0, 1, 0),
            value: finiteNumber(node.value, 'Gradient value', 0, 1, 0),
            falloff: finiteNumber(node.falloff, 'Gradient falloff', 0, 1, 0.25),
            strength: finiteNumber(node.strength, 'Gradient strength', 0, 1, 1),
            shape_nodes: shapes.map((shape, shapeIndex) => ({
                id: shapeIndex + 1,
                parent_id: index + 1,
                x: finiteNumber(shape.x, 'Shape x', 0, 1, 0),
                y: finiteNumber(shape.y, 'Shape y', 0, 1, 0),
                falloff: finiteNumber(shape.falloff, 'Shape falloff', 0, 1, 0.25),
                strength: finiteNumber(shape.strength, 'Shape strength', 0, 1, 1)
            }))
        }
    })
    const shapeNodeCount = nodes.reduce((sum, node) => sum + node.shape_nodes.length, 0)
    if(shapeNodeCount > 2048) fail('preset_shape_node_limit', 'Builder Presets may contain at most 2,048 total shape nodes.')
    const faceIslands = objectArray(root.face_islands, 'Face islands', 64).map(island => ({
        face: cleanText(island.face, 16).toLowerCase(),
        u: finiteNumber(island.u, 'Face island u', 0, 1, 0.5),
        v: finiteNumber(island.v, 'Face island v', 0, 1, 0.5),
        w: finiteNumber(island.w, 'Face island width', 0, 1, 0.25),
        h: finiteNumber(island.h, 'Face island height', 0, 1, 0.25),
        r: finiteNumber(island.r, 'Face island rotation', -360, 360, 0)
    })).sort((a, b) => a.face.localeCompare(b.face) || a.u - b.u || a.v - b.v)
    const pins = objectArray(root.pins, 'Block pins', 256).map(pin => ({
        value: finiteNumber(pin.value, 'Block pin value', 0, 1, 0),
        block: resourceLocation(pin.block, 'Pinned block')
    })).sort((a, b) => a.value - b.value || a.block.localeCompare(b.block))
    const type = cleanText(root.settings?.type, 32, 'SMOOTH').toUpperCase()
    if(!['SMOOTH', 'BANDS', 'NEAREST'].includes(type)) fail('invalid_gradient_type', `Unsupported gradient type: ${type}`)
    const canonical = {
        format: format.id,
        version: format.version,
        metadata: {},
        settings: {
            type,
            noise: Boolean(root.settings?.noise),
            noise_strength: finiteNumber(root.settings?.noise_strength, 'Noise strength', 0, 4, 1)
        },
        face_islands: faceIslands,
        nodes,
        pins,
        blend: {
            enabled: Boolean(root.blend?.enabled),
            sharpness: finiteNumber(root.blend?.sharpness, 'Blend sharpness', 0, 1, 0.5),
            radius: finiteNumber(root.blend?.radius, 'Blend radius', 0, 1, 0.25),
            seed: integer(root.blend?.seed, 'Blend seed', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0)
        },
        preview: { grid_cells: integer(root.preview?.grid_cells, 'Preview grid size', 1, 256, 16) }
    }
    const digest = digestSerialized(stableStringify(canonical))
    return {
        ...digest,
        canonical,
        format,
        typeData: {
            gradientType: type,
            noise: canonical.settings.noise,
            blend: canonical.blend.enabled,
            nodeCount: nodes.length,
            shapeNodeCount,
            pinnedBlocks: pins.map(pin => pin.block)
        },
        dependencies: []
    }
}

function canonicalizeJsonArtifact(type, input, options = {}) {
    if(type === TYPES.AUTOMATION) return canonicalizeAutomation(input, options)
    if(type === TYPES.BATTLE_TRAINERS) return canonicalizeTrainer(input, options)
    if(type === TYPES.BUILDER_PRESETS) return canonicalizeGradient(input, options)
    fail('unsupported_community_type', `Community type ${type} is not a JSON artifact type.`)
}

function normalizeCompatibility(value = {}, options = {}) {
    const source = isPlainObject(value) ? value : {}
    const result = {
        minecraft: cleanText(source.minecraft, 32, DEFAULT_COMPATIBILITY.minecraft),
        loader: cleanText(source.loader, 32, DEFAULT_COMPATIBILITY.loader).toLowerCase(),
        cobblePower: cleanText(source.cobblePower, 80, DEFAULT_COMPATIBILITY.cobblePower),
        cobblemon: cleanText(source.cobblemon, 80, DEFAULT_COMPATIBILITY.cobblemon)
    }
    if(result.minecraft !== DEFAULT_COMPATIBILITY.minecraft || result.loader !== DEFAULT_COMPATIBILITY.loader) {
        fail('incompatible_minecraft', 'This Community service currently accepts Minecraft 1.21.1 with NeoForge only.')
    }
    const allowedRanges = Array.isArray(options.allowedRanges) && options.allowedRanges.length > 0
        ? options.allowedRanges
        : [DEFAULT_COMPATIBILITY]
    const rangeAllowed = allowedRanges.some(allowed => (
        result.cobblePower === allowed.cobblePower && result.cobblemon === allowed.cobblemon
    ))
    if(!rangeAllowed) {
        fail('unsupported_compatibility_range', 'The declared Cobble Power or Cobblemon compatibility is not in the deployed compatibility matrix.')
    }
    return result
}

function typeContract(type) {
    const value = FORMAT_CONTRACTS[type]
    if(!value) fail('unsupported_community_type', `Unsupported Community type: ${type}`)
    return value
}

module.exports = {
    CommunityValidationError,
    DEFAULT_COMPATIBILITY,
    FORMAT_CONTRACTS,
    JSON_LIMITS,
    TYPES,
    canonicalizeAutomation,
    canonicalizeGradient,
    canonicalizeJsonArtifact,
    canonicalizeTrainer,
    deepSort,
    digestSerialized,
    normalizeCompatibility,
    stableStringify,
    typeContract
}
