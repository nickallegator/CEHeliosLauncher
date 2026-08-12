'use strict'

const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    CommunityInstallManager,
    hyphenateUuid,
    readOptions,
    updateResourcePacksOptions
} = require('../../app/assets/js/communityinstallmanager')
const { buildAutomationBundle, validatePublishSource } = require('../../app/assets/js/communitypublisher')
const { renderAutomationSvg, renderGradientSvg } = require('../../app/assets/js/communitypreviewworker')

const PLAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM = '11111111-1111-4111-8111-111111111111'

function sha(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex')
}

function entry(type, buffer, revision = 1) {
    return {
        type,
        id: ITEM,
        title: 'Community Test',
        revision: { id: `22222222-2222-4222-8222-${String(revision).padStart(12, '0')}`, number: revision, sha256: sha(buffer) },
        dependencies: []
    }
}

function managerFixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-installs-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return {
        root,
        instances: path.join(root, 'instances'),
        launcher: path.join(root, 'launcher'),
        manager: new CommunityInstallManager({
            instanceDirectory: path.join(root, 'instances'),
            launcherDirectory: path.join(root, 'launcher'),
            isGameRunning: options.isGameRunning || (() => false)
        })
    }
}

test('Automation installation remaps bundled assets atomically and preserves UUID mappings on update', t => {
    const fixture = managerFixture(t)
    const bundle = Buffer.from(`${JSON.stringify({
        format: 'cobblepower_automation_bundle', version: 1, rootAsset: 'asset-001',
        assets: [{
            id: 'asset-001', kind: 'operation', name: 'Root', dependencies: [],
            graph: {
                nodes: [{ id: 'node-0001', type: 'cobblepower:action_wait', x: 0, y: 0, parameters: {} }],
                edges: []
            }
        }]
    })}\n`)
    const first = fixture.manager.install({ profileId: 'Cobble-Power-1.21.1', playerUuid: PLAYER, entry: entry('automation', bundle), artifact: bundle })
    assert.equal(first.managedFiles.length, 1)
    const installed = JSON.parse(fs.readFileSync(first.managedFiles[0].path, 'utf8'))
    assert.match(installed.operationId, /^[a-f0-9-]{36}$/)
    assert.equal(installed.graph.nodes[0].blockTypeId, 'cobblepower:action_wait')
    const mapping = first.mappings.assets['asset-001']

    const secondEntry = entry('automation', bundle, 2)
    secondEntry.revision.sha256 = sha(bundle)
    const second = fixture.manager.install({ profileId: 'Cobble-Power-1.21.1', playerUuid: PLAYER, entry: secondEntry, artifact: bundle })
    assert.equal(second.mappings.assets['asset-001'], mapping)
})

test('Battle Trainers and Builder Presets install at mod-compatible paths', t => {
    const fixture = managerFixture(t)
    const trainer = Buffer.from(`${JSON.stringify({
        format: 'cobblepower_battle_projector_trainer', version: 1, name: 'Ace', skin_id: 'cobblepower:default', team: []
    })}\n`)
    const trainerRecord = fixture.manager.install({
        profileId: 'profile', playerUuid: PLAYER, entry: entry('battle-trainers', trainer), artifact: trainer
    })
    assert.match(trainerRecord.managedFiles[0].path, /config[\\/]cobblepower[\\/]trainers[\\/]aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/)
    assert.match(JSON.parse(fs.readFileSync(trainerRecord.managedFiles[0].path)).id, /^cobblepower:client_trainers\//)

    const gradient = Buffer.from(`${JSON.stringify({ format: 'cobblepower_gradient', version: 1, metadata: {}, nodes: [] })}\n`)
    const gradientRecord = fixture.manager.install({
        profileId: 'profile', playerUuid: null, entry: entry('builder-presets', gradient), artifact: gradient
    })
    assert.match(gradientRecord.managedFiles[0].path, /gradients[\\/]ag-community-/)
    assert.equal(JSON.parse(fs.readFileSync(gradientRecord.managedFiles[0].path)).metadata.name, 'Community Test')
})

test('Resource Packs install at highest priority, preserve options, and can be disabled safely', t => {
    const fixture = managerFixture(t)
    const instance = path.join(fixture.instances, 'profile')
    fs.mkdirSync(instance, { recursive: true })
    fs.writeFileSync(path.join(instance, 'options.txt'), 'fov:0.0\nresourcePacks:["vanilla","file/existing.zip"]\ncustomSetting:kept\n')
    const zip = Buffer.from('validated-resource-pack')
    const record = fixture.manager.install({
        profileId: 'profile', playerUuid: null, entry: entry('resource-packs', zip), artifact: zip
    })
    const options = readOptions(path.join(instance, 'options.txt'))
    assert.equal(options.resourcePacks.at(-1), record.resourcePackState.packId)
    assert.match(fs.readFileSync(path.join(instance, 'options.txt'), 'utf8'), /customSetting:kept/)
    assert.equal(fs.existsSync(path.join(instance, 'options.txt.ag-launcher.bak')), true)
    fixture.manager.setResourcePackEnabled({ profileId: 'profile', itemId: ITEM, enabled: false })
    assert.equal(readOptions(path.join(instance, 'options.txt')).resourcePacks.includes(record.resourcePackState.packId), false)
    assert.equal(fixture.manager.status('profile', null, entry('resource-packs', zip)).state, 'disabled')
    fixture.manager.setResourcePackEnabled({ profileId: 'profile', itemId: ITEM, enabled: true })
    fixture.manager.reorderResourcePack({ profileId: 'profile', itemId: ITEM, direction: 'lower' })
    const lowered = readOptions(path.join(instance, 'options.txt')).resourcePacks
    assert.equal(lowered.indexOf(record.resourcePackState.packId), 1)
    assert.equal(fixture.manager.status('profile', null, entry('resource-packs', zip)).state, 'installed')
})

test('managed files are protected from local changes and updates remain manual', t => {
    const fixture = managerFixture(t)
    const gradient = Buffer.from(`${JSON.stringify({ format: 'cobblepower_gradient', version: 1, metadata: {}, nodes: [] })}\n`)
    const installed = fixture.manager.install({ profileId: 'profile', playerUuid: null, entry: entry('builder-presets', gradient), artifact: gradient })
    fs.appendFileSync(installed.managedFiles[0].path, '\nlocal edit')
    assert.equal(fixture.manager.status('profile', null, entry('builder-presets', gradient)).state, 'modified')
    assert.throws(() => fixture.manager.remove({ profileId: 'profile', playerUuid: null, type: 'builder-presets', itemId: ITEM }), error => error.code === 'locally_modified')

    fs.writeFileSync(installed.managedFiles[0].path, Buffer.from(`${JSON.stringify({ format: 'cobblepower_gradient', version: 1, metadata: { name: 'Community Test' }, nodes: [] }, null, 2)}\n`))
    installed.managedFiles[0].sha256 = sha(fs.readFileSync(installed.managedFiles[0].path))
    fixture.manager.saveIndex()
    const newer = entry('builder-presets', gradient, 2)
    newer.revision.sha256 = 'f'.repeat(64)
    assert.equal(fixture.manager.status('profile', null, newer).state, 'update')
})

test('new installations never overwrite untracked files without confirmation', t => {
    const fixture = managerFixture(t)
    const gradient = Buffer.from(`${JSON.stringify({ format: 'cobblepower_gradient', version: 1, metadata: {}, nodes: [] })}\n`)
    const target = path.join(fixture.instances, 'profile', 'config', 'cobblepower', 'gradients', `ag-community-${ITEM}.json`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'local preset')
    assert.throws(() => fixture.manager.install({
        profileId: 'profile', playerUuid: null, entry: entry('builder-presets', gradient), artifact: gradient
    }), error => error.code === 'untracked_file')
    assert.equal(fs.readFileSync(target, 'utf8'), 'local preset')
    const installed = fixture.manager.install({
        profileId: 'profile', playerUuid: null, entry: entry('builder-presets', gradient), artifact: gradient,
        confirmModified: paths => paths.length === 1 && paths[0] === target
    })
    assert.equal(installed.managedFiles[0].path, target)
})

test('missing managed files can be repaired without a modification override', t => {
    const fixture = managerFixture(t)
    const gradient = Buffer.from(`${JSON.stringify({ format: 'cobblepower_gradient', version: 1, metadata: {}, nodes: [] })}\n`)
    const value = entry('builder-presets', gradient)
    const installed = fixture.manager.install({ profileId: 'profile', playerUuid: null, entry: value, artifact: gradient })
    fs.rmSync(installed.managedFiles[0].path)
    assert.equal(fixture.manager.status('profile', null, value).state, 'repair')
    fixture.manager.install({ profileId: 'profile', playerUuid: null, entry: value, artifact: gradient })
    assert.equal(fixture.manager.status('profile', null, value).state, 'installed')
})

test('release helper bundles referenced Shared Spaces from the local Operations library', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-operation-library-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const rootId = '33333333-3333-4333-8333-333333333333'
    const sharedId = '44444444-4444-4444-8444-444444444444'
    const document = (id, kind, dependencies = '') => ({
        format: 'cobblepower_operation', version: 1, operationId: id, name: kind,
        metadata: { asset_id: id, asset_kind: kind, shared_space_dependencies: dependencies },
        graph: { nodes: [], edges: [] }
    })
    const rootPath = path.join(directory, `${rootId}.json`)
    fs.writeFileSync(rootPath, JSON.stringify(document(rootId, 'operation', sharedId)))
    fs.writeFileSync(path.join(directory, `${sharedId}.json`), JSON.stringify(document(sharedId, 'shared_space')))
    const bundle = JSON.parse(buildAutomationBundle(rootPath))
    assert.equal(bundle.assets.length, 2)
    assert.equal(bundle.rootAssetId, rootId)
})

test('publication sources are confined to the selected profile libraries', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-source-test-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const profileId = 'Cobble-Power-1.21.1'
    const operationRoot = path.join(directory, profileId, 'config', 'cobblepower', 'operations', PLAYER)
    const operation = path.join(operationRoot, 'operation.json')
    fs.mkdirSync(operationRoot, { recursive: true })
    fs.writeFileSync(operation, '{}')
    assert.equal(validatePublishSource('automation', operation, {
        instanceDirectory: directory,
        profileId,
        playerUuid: PLAYER
    }), operation)
    assert.throws(() => validatePublishSource('automation', path.join(directory, 'outside.json'), {
        instanceDirectory: directory,
        profileId,
        playerUuid: PLAYER
    }), error => error.code === 'invalid_publish_source')
    assert.throws(() => validatePublishSource('resource-packs', path.join(directory, 'not-a-pack.jar'), {
        instanceDirectory: directory,
        profileId
    }), error => error.code === 'invalid_publish_source')
})

test('Automation graph previews render deterministic local SVG without player data', () => {
    const artifact = {
        format: 'cobblepower_automation_bundle', version: 1,
        assets: [{ document: { name: 'Preview', graph: { nodes: [
            { nodeId: 'a', blockTypeId: 'cobblepower:event_manual_trigger', x: 0, y: 0 },
            { nodeId: 'b', blockTypeId: 'cobblepower:action_send_message', x: 100, y: 50 }
        ], edges: [{ fromNodeId: 'a', toNodeId: 'b' }] } } }]
    }
    const first = renderAutomationSvg(artifact)
    const second = renderAutomationSvg(artifact)
    assert.equal(first, second)
    assert.match(first, /^<svg/)
    assert.match(first, /2 nodes/)
    assert.equal(first.includes(PLAYER), false)
})

test('Builder Preset previews render deterministically from palette metadata', () => {
    const preset = {
        format: 'cobblepower_gradient', version: 1,
        settings: { type: 'SMOOTH', noise: true },
        nodes: [{ id: 1 }],
        pins: [
            { value: 0, block: 'minecraft:deepslate' },
            { value: 1, block: 'cobblepower:copper_panel' }
        ],
        blend: { enabled: true }
    }
    const first = renderGradientSvg(preset)
    assert.equal(first, renderGradientSvg(preset))
    assert.match(first, /^<svg/)
    assert.match(first, /2 pinned materials/)
    assert.match(first, /SMOOTH BUILDER PRESET/)
})

test('UUID normalization and options editing reject unsafe inputs without losing settings', () => {
    assert.equal(hyphenateUuid(PLAYER), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.throws(() => hyphenateUuid('../bad'))
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-options-'))
    const filePath = path.join(directory, 'options.txt')
    fs.writeFileSync(filePath, 'resourcePacks:["vanilla"]\nother:value\n')
    const updated = updateResourcePacksOptions(filePath, 'file/test.zip')
    assert.equal(updated.resourcePacks.at(-1), 'file/test.zip')
    assert.match(updated.content.toString(), /other:value/)
    fs.rmSync(directory, { recursive: true, force: true })
})
