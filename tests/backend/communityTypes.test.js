'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const AdmZip = require('adm-zip')

const {
    CommunityValidationError,
    canonicalizeAutomation,
    canonicalizeGradient,
    canonicalizeTrainer
} = require('../../libraries/community-core')
const {
    normalizeEntryPath,
    validateResourcePack
} = require('../../backend/src/services/communityResourcePack')

const UUIDS = {
    root: '11111111-1111-4111-8111-111111111111',
    shared: '22222222-2222-4222-8222-222222222222',
    nodeA: '33333333-3333-4333-8333-333333333333',
    nodeB: '44444444-4444-4444-8444-444444444444',
    edge: '55555555-5555-4555-8555-555555555555'
}

function operationDocument(id, kind, dependency = '') {
    return {
        format: 'cobblepower_operation',
        version: 1,
        operationId: id,
        updatedAt: 123456,
        name: kind === 'shared_space' ? 'Variables' : 'Root Operation',
        metadata: {
            asset_id: id,
            asset_kind: kind,
            shared_space_dependencies: dependency
        },
        graph: {
            nodes: [
                { nodeId: UUIDS.nodeA, blockTypeId: 'cobblepower:data_number', x: 0, y: 0, parameters: {} },
                { nodeId: UUIDS.nodeB, blockTypeId: 'cobblepower:action_wait', x: 20, y: 30, parameters: {} }
            ],
            edges: [{
                edgeId: UUIDS.edge,
                fromNodeId: UUIDS.nodeA,
                fromPin: 'value',
                toNodeId: UUIDS.nodeB,
                toPin: 'ticks'
            }]
        }
    }
}

test('Automation bundles canonicalize deterministically with bundled Shared Spaces', () => {
    const bundle = {
        format: 'cobblepower_automation_bundle',
        version: 1,
        rootAssetId: UUIDS.root,
        assets: [
            { sourceAssetId: UUIDS.shared, kind: 'shared_space', document: operationDocument(UUIDS.shared, 'shared_space') },
            { sourceAssetId: UUIDS.root, kind: 'operation', document: operationDocument(UUIDS.root, 'operation', UUIDS.shared) }
        ]
    }
    const first = canonicalizeAutomation(bundle)
    const second = canonicalizeAutomation({ ...bundle, assets: [...bundle.assets].reverse() })
    assert.equal(first.sha256, second.sha256)
    assert.equal(first.typeData.assetCount, 2)
    assert.equal(first.canonical.assets[0].dependencies[0], 'asset-002')
    assert.equal(first.serialized.includes(UUIDS.root), false)
    assert.equal(first.serialized.includes('updatedAt'), false)
})

test('Automation rejects unresolved dependencies and fixed player identities', () => {
    const document = operationDocument(UUIDS.root, 'operation', UUIDS.shared)
    assert.throws(() => canonicalizeAutomation({
        format: 'cobblepower_automation_bundle', version: 1, rootAssetId: UUIDS.root,
        assets: [{ sourceAssetId: UUIDS.root, document }]
    }), error => error instanceof CommunityValidationError && error.code === 'unresolved_shared_space')

    document.metadata.shared_space_dependencies = ''
    document.graph.nodes[0].parameters.player_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    assert.throws(() => canonicalizeAutomation({
        format: 'cobblepower_automation_bundle', version: 1, rootAssetId: UUIDS.root,
        assets: [{ sourceAssetId: UUIDS.root, document }]
    }), error => error.code === 'non_portable_identity')
})

test('Automation canonicalizes imported Shared Space function block IDs', () => {
    const root = operationDocument(UUIDS.root, 'operation', UUIDS.shared)
    const shared = operationDocument(UUIDS.shared, 'shared_space')
    root.graph.nodes[0].blockTypeId = `cobblepower:call_shared_function_${UUIDS.shared.replaceAll('-', '')}_${UUIDS.nodeA.replaceAll('-', '')}`
    root.graph.nodes[0].parameters = {
        call_shared_space_asset_id: UUIDS.shared,
        call_function_start_node_id: UUIDS.nodeA
    }
    root.graph.nodes[1].nodeId = '66666666-6666-4666-8666-666666666666'
    root.graph.edges[0].toNodeId = root.graph.nodes[1].nodeId
    shared.graph.nodes[1].nodeId = '77777777-7777-4777-8777-777777777777'
    shared.graph.edges[0].toNodeId = shared.graph.nodes[1].nodeId

    const result = canonicalizeAutomation({
        format: 'cobblepower_automation_bundle', version: 1, rootAssetId: UUIDS.root,
        assets: [
            { sourceAssetId: UUIDS.root, document: root },
            { sourceAssetId: UUIDS.shared, kind: 'shared_space', document: shared }
        ]
    })
    const node = result.canonical.assets[0].graph.nodes[0]
    assert.equal(node.type, 'cobblepower:call_shared_function')
    assert.deepEqual(node.dynamicCall, { asset: 'asset-002', functionNode: 'node-0001' })
    assert.equal(result.serialized.includes(UUIDS.shared), false)
})

test('Battle Trainer canonicalization strips copied skins and enforces party limits', () => {
    const trainer = canonicalizeTrainer({
        format: 'cobblepower_battle_projector_trainer',
        version: 1,
        id: 'cobblepower:client_trainers/player/original',
        name: 'Ace',
        skin_id: 'cobblepower:default',
        copied_skin_png: 'not-public',
        copied_skin_model_type: 'slim',
        texture: 'C:/private/skin.png',
        skill: 5,
        team: [{
            species: 'cobblemon:pikachu', level: 50, gender: 'FEMALE', nature: 'jolly', ability: 'static',
            moves: ['thunderbolt'], ivs: [31, 31, 31, 31, 31, 31], evs: [252, 0, 0, 0, 4, 244]
        }]
    })
    assert.deepEqual(trainer.typeData.strippedFields.sort(), ['copied_skin_model_type', 'copied_skin_png', 'id', 'texture'])
    assert.equal(trainer.serialized.includes('not-public'), false)
    assert.equal(trainer.canonical.team.length, 1)
})

test('Builder Presets canonicalize title-free data and reject future versions', () => {
    const preset = canonicalizeGradient({
        format: 'cobblepower_gradient', version: 1,
        metadata: { name: 'Local title' },
        settings: { type: 'smooth', noise: true, noise_strength: 0.5 },
        nodes: [{ id: 91, x: 0.1, y: 0.2, value: 0.3, falloff: 0.4, strength: 0.5 }],
        pins: [{ value: 0.5, block: 'minecraft:stone' }],
        blend: { enabled: true, sharpness: 0.4, radius: 0.2, seed: 4 },
        preview: { grid_cells: 16 }
    })
    assert.deepEqual(preset.canonical.metadata, {})
    assert.equal(preset.canonical.nodes[0].id, 1)
    assert.throws(() => canonicalizeGradient({ format: 'cobblepower_gradient', version: 2 }), error => error.code === 'future_artifact_version')
})

test('Resource Pack validator accepts Cobble ecosystem packs and rejects forbidden files', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-resource-pack-test-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const validPath = path.join(directory, 'valid.zip')
    const valid = new AdmZip()
    valid.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Test' } })))
    valid.addFile('assets/cobblepower/textures/example.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    valid.writeZip(validPath)
    const result = await validateResourcePack(validPath)
    assert.equal(result.typeData.packFormat, 34)
    assert.deepEqual(result.typeData.namespaces, ['cobblepower'])

    const badPath = path.join(directory, 'bad.zip')
    const bad = new AdmZip()
    bad.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Test' } })))
    bad.addFile('assets/cobblepower/evil.jar', Buffer.from('bad'))
    bad.writeZip(badPath)
    await assert.rejects(validateResourcePack(badPath), error => error.code === 'forbidden_resource_pack_file')
})

test('Resource Pack validator discovers selected subjects and builds a bounded render overlay', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-resource-pack-showcase-test-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const filePath = path.join(directory, 'showcase.zip')
    const zip = new AdmZip()
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Showcase' } })))
    zip.addFile('assets/cobblepower/blockstates/copper_machine.json', Buffer.from(JSON.stringify({ variants: { '': { model: 'cobblepower:block/copper_machine' } } })))
    zip.addFile('assets/cobblepower/models/block/copper_machine.json', Buffer.from(JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'cobblepower:block/copper_machine' } })))
    zip.addFile('assets/cobblepower/textures/block/copper_machine.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    zip.writeZip(filePath)
    const result = await validateResourcePack(filePath, {
        showcase: { schemaVersion: 1, subjects: [{ kind: 'block', id: 'cobblepower:copper_machine', state: {} }] }
    })
    assert.equal(result.typeData.showcase.subjects[0].id, 'cobblepower:copper_machine')
    assert.equal(result.renderAssets.length, 1)
    assert.equal(result.renderAssets[0].role, 'render-overlay')
    assert.ok(result.renderAssets[0].bytes.length > 0)
})

test('Resource Pack validator rejects malformed content files', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-resource-pack-content-test-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const malformedPngPath = path.join(directory, 'malformed-png.zip')
    const malformedPng = new AdmZip()
    malformedPng.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Test' } })))
    malformedPng.addFile('assets/cobblepower/textures/example.png', Buffer.from([1, 2, 3]))
    malformedPng.writeZip(malformedPngPath)
    await assert.rejects(validateResourcePack(malformedPngPath), error => error.code === 'invalid_resource_pack_png')

    const malformedJsonPath = path.join(directory, 'malformed-json.zip')
    const malformedJson = new AdmZip()
    malformedJson.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Test' } })))
    malformedJson.addFile('assets/cobblepower/models/example.json', Buffer.from('{'))
    malformedJson.writeZip(malformedJsonPath)
    await assert.rejects(validateResourcePack(malformedJsonPath), error => error.code === 'invalid_resource_pack_json')
})

test('Resource Pack path normalization rejects traversal and Windows paths', () => {
    assert.throws(() => normalizeEntryPath('../outside.json'), error => error.code === 'unsafe_resource_pack_path')
    assert.throws(() => normalizeEntryPath('C:/outside.json'), error => error.code === 'unsafe_resource_pack_path')
    assert.throws(() => normalizeEntryPath('assets\\cobblepower\\bad.json'), error => error.code === 'unsafe_resource_pack_path')
})

test('Resource Pack validator rejects unrelated mod namespaces', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-resource-pack-namespace-test-'))
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
    const filePath = path.join(directory, 'unrelated.zip')
    const zip = new AdmZip()
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Test' } })))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    zip.addFile('assets/cobblepower/textures/example.png', png)
    zip.addFile('assets/unrelated/textures/example.png', png)
    zip.writeZip(filePath)
    await assert.rejects(validateResourcePack(filePath), error => error.code === 'unapproved_resource_pack_namespace')
})
