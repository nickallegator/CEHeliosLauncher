'use strict'

const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const AdmZip = require('adm-zip')
const { CreateBucketCommand, HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3')
const sharp = require('../../backend/node_modules/sharp')

const REQUIRED = process.env.SCHEMATICS_INTEGRATION_REQUIRED === '1'
const DATABASE_URL = process.env.DATABASE_URL_TEST || ''
const ENDPOINT = process.env.SCHEMATICS_INTEGRATION_STORAGE_ENDPOINT || ''
const BUCKET = process.env.SCHEMATICS_INTEGRATION_STORAGE_BUCKET || 'cobblepower-schematics-test'
const ACCESS_KEY = process.env.SCHEMATICS_INTEGRATION_STORAGE_ACCESS_KEY_ID || 'cobblepower-test'
const SECRET_KEY = process.env.SCHEMATICS_INTEGRATION_STORAGE_SECRET_ACCESS_KEY || 'cobblepower-test-secret'
const PORT = 8095
const BASE = `http://127.0.0.1:${PORT}`

async function ensureBucket() {
    const client = new S3Client({
        region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true,
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
    })
    try { await client.send(new HeadBucketCommand({ Bucket: BUCKET })) }
    catch(_error) { await client.send(new CreateBucketCommand({ Bucket: BUCKET })) }
}

async function waitForReady(output, timeout = 15_000) {
    const end = Date.now() + timeout
    while(Date.now() < end) {
        try { if((await fetch(`${BASE}/ready`)).ok) return }
        catch(_error) { /* startup in progress */ }
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Community integration backend did not become ready.\n${output()}`)
}

async function responseJson(response, status) {
    const text = await response.text()
    assert.equal(response.status, status, text)
    return text ? JSON.parse(text) : null
}

async function publish(token, type, artifact, preview, extraMetadata = {}) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const session = await responseJson(await fetch(`${BASE}/v1/community/uploads`, {
        method: 'POST', headers,
        body: JSON.stringify({
            type, title: `Pilot ${type}`, description: 'Community integration pilot', tags: ['pilot'],
            license: 'Community-Use-1.0', rightsAttested: true, visibility: 'public',
            previewMime: preview ? 'image/png' : null,
            compatibility: { minecraft: '1.21.1', loader: 'neoforge', cobblePower: '>=1.0.4-test.1 <1.1.0', cobblemon: '>=1.6.0 <1.7.0' },
            ...extraMetadata
        })
    }), 201)
    const artifactPut = await fetch(session.uploads.artifact.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': session.uploads.artifact.mimeType }, body: artifact
    })
    assert.equal(artifactPut.ok, true)
    if(session.uploads.preview) {
        const previewPut = await fetch(session.uploads.preview.uploadUrl, {
            method: 'PUT', headers: { 'Content-Type': session.uploads.preview.mimeType }, body: preview
        })
        assert.equal(previewPut.ok, true)
    }
    return responseJson(await fetch(`${BASE}/v1/community/uploads/${encodeURIComponent(session.token)}/finalize`, {
        method: 'POST', headers, body: '{}'
    }), 201)
}

function automation() {
    return Buffer.from(JSON.stringify({
        format: 'cobblepower_automation_bundle', version: 1, rootAssetId: '11111111-1111-4111-8111-111111111111',
        assets: [{
            sourceAssetId: '11111111-1111-4111-8111-111111111111', kind: 'operation',
            document: {
                format: 'cobblepower_operation', version: 1, operationId: '11111111-1111-4111-8111-111111111111', name: 'Pilot',
                metadata: { asset_kind: 'operation', asset_id: '11111111-1111-4111-8111-111111111111' },
                graph: { nodes: [{ nodeId: '22222222-2222-4222-8222-222222222222', blockTypeId: 'cobblepower:event_manual_trigger', x: 0, y: 0, parameters: {} }], edges: [] }
            }
        }]
    }))
}

function trainer() {
    return Buffer.from(JSON.stringify({
        format: 'cobblepower_battle_projector_trainer', version: 1, name: 'Ace', skin_id: 'cobblepower:default', skill: 4,
        team: [{ species: 'cobblemon:pikachu', form: '', level: 50, gender: 'FEMALE', nature: 'jolly', ability: 'static', moves: ['thunderbolt', '', '', ''], ivs: [31, 31, 31, 31, 31, 31], evs: [252, 0, 0, 0, 4, 244] }]
    }))
}

function gradient() {
    return Buffer.from(JSON.stringify({
        format: 'cobblepower_gradient', version: 1, metadata: { name: 'Local' },
        settings: { type: 'SMOOTH', noise: false, noise_strength: 1 }, face_islands: [],
        nodes: [{ id: 1, x: 0.5, y: 0.5, value: 0.5, falloff: 0.25, strength: 1 }],
        pins: [{ value: 0.5, block: 'minecraft:stone' }], blend: { enabled: false, sharpness: 0.5, radius: 0.25, seed: 0 }, preview: { grid_cells: 16 }
    }))
}

function resourcePack(directory) {
    const filePath = path.join(directory, 'pilot.zip')
    const zip = new AdmZip()
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Pilot' } })))
    zip.addFile('assets/cobblepower/textures/community/pilot.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    zip.addFile('assets/cobblepower/blockstates/pilot.json', Buffer.from(JSON.stringify({ variants: { '': { model: 'cobblepower:block/pilot' } } })))
    zip.addFile('assets/cobblepower/models/block/pilot.json', Buffer.from(JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'cobblepower:community/pilot' } })))
    zip.writeZip(filePath)
    return fs.readFileSync(filePath)
}

test('generic Community types migrate, publish, browse, engage, and download through private storage', { skip: !REQUIRED }, async t => {
    assert.ok(DATABASE_URL)
    assert.ok(ENDPOINT)
    const migration = spawnSync(process.execPath, ['scripts/db-migrate.js', '--database-url', DATABASE_URL], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'), encoding: 'utf8'
    })
    assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`)
    await ensureBucket()
    const child = spawn(process.execPath, ['src/index.js'], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'),
        env: {
            ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL,
            RELEASES_ENABLED: 'false', SCHEMATICS_ENABLED: 'false', COMMUNITY_ENABLED: 'true', COMMUNITY_WRITE_MODE: 'authenticated',
            COMMUNITY_RICH_PREVIEWS_ENABLED: 'true', COMMUNITY_PACK_STUDIO_ENABLED: 'true',
            COMMUNITY_AUTOMATION_ENABLED: 'true', COMMUNITY_BATTLE_TRAINERS_ENABLED: 'true',
            COMMUNITY_BUILDER_PRESETS_ENABLED: 'true', COMMUNITY_RESOURCE_PACKS_ENABLED: 'true',
            COMMUNITY_STORAGE_PROVIDER: 's3', COMMUNITY_STORAGE_BUCKET: BUCKET, COMMUNITY_STORAGE_REGION: 'us-east-1',
            COMMUNITY_STORAGE_ENDPOINT: ENDPOINT, COMMUNITY_STORAGE_ACCESS_KEY_ID: ACCESS_KEY,
            COMMUNITY_STORAGE_SECRET_ACCESS_KEY: SECRET_KEY, COMMUNITY_STORAGE_FORCE_PATH_STYLE: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    t.after(() => child.kill())
    await waitForReady(() => output)

    process.env.DATABASE_URL = DATABASE_URL
    const db = require('../../backend/src/db')
    const store = require('../../backend/src/services/store')
    const sessions = require('../../backend/src/services/sessions')
    t.after(() => db.pool.end())
    const uuid = `1234567890abcdef12345678${Date.now().toString(16).slice(-8)}`.slice(0, 32)
    const userId = await store.upsertUser('minecraft', uuid, 'Community Integrator')
    const session = await sessions.createSession(userId)
    const preview = await sharp({ create: { width: 512, height: 320, channels: 4, background: '#345678' } }).png().toBuffer()
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-community-integration-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

    const pilots = []
    pilots.push(await publish(session.token, 'builder-presets', gradient(), preview))
    pilots.push(await publish(session.token, 'battle-trainers', trainer(), preview))
    pilots.push(await publish(session.token, 'automation', automation(), preview))
    pilots.push(await publish(session.token, 'resource-packs', resourcePack(temp), null, {
        showcase: { schemaVersion: 1, subjects: [{ kind: 'block', id: 'cobblepower:pilot', state: {} }] },
        packStudioOptIn: true,
        packStudioTermsAccepted: true
    }))
    assert.deepEqual(pilots.map(item => item.type), ['builder-presets', 'battle-trainers', 'automation', 'resource-packs'])

    const capabilities = await responseJson(await fetch(`${BASE}/v1/community/capabilities`), 200)
    assert.ok(['builder-presets', 'battle-trainers', 'automation', 'resource-packs'].every(type => capabilities.categories.some(item => item.id === type)))
    assert.equal(capabilities.features.packStudio, true)
    const catalog = await responseJson(await fetch(`${BASE}/v1/community/catalog?category=all&sort=popular&limit=20`), 200)
    assert.ok(pilots.every(pilot => catalog.items.some(item => item.key === `${pilot.type}:${pilot.id}`)))

    const first = pilots[0]
    await responseJson(await fetch(`${BASE}/v1/community/items/${first.type}/${first.id}/like`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}` }
    }), 200)
    assert.equal((await fetch(`${BASE}/v1/community/items/${first.type}/${first.id}/view`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}` }
    })).status, 204)
    const download = await responseJson(await fetch(`${BASE}/v1/community/items/${first.type}/${first.id}/download`), 200)
    const artifact = await fetch(download.downloadUrl)
    assert.equal(artifact.ok, true)
    assert.equal(Buffer.from(await artifact.arrayBuffer()).length, first.revision.sizeBytes)
    const resourcePackPilot = pilots.find(pilot => pilot.type === 'resource-packs')
    const previewAssets = await responseJson(await fetch(`${BASE}/v1/community/items/resource-packs/${resourcePackPilot.id}/preview-assets`), 200)
    assert.equal(previewAssets.assets.length, 1)
    assert.equal(previewAssets.assets[0].role, 'render-overlay')
    assert.equal((await fetch(previewAssets.assets[0].downloadUrl)).ok, true)

    const components = await responseJson(await fetch(`${BASE}/v1/community/composer/components?kind=block&query=pilot`), 200)
    assert.equal(components.schemaVersion, 1)
    assert.equal(components.items.length, 1)
    assert.equal(components.items[0].key, 'block:cobblepower:pilot')
    const resolution = await responseJson(await fetch(`${BASE}/v1/community/composer/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            schemaVersion: 1,
            selections: [{
                sourceItemId: resourcePackPilot.id,
                sourceRevisionId: resourcePackPilot.revision.id,
                componentKey: components.items[0].key
            }],
            conflictResolutions: {}
        })
    }), 200)
    assert.equal(resolution.plan.conflicts.length, 0)
    assert.equal(resolution.sources.length, 1)
    assert.equal((await fetch(resolution.sources[0].downloadUrl)).ok, true)
    const grant = await responseJson(await fetch(`${BASE}/v1/community/items/resource-packs/${resourcePackPilot.id}/revisions/${resourcePackPilot.revision.id}/composition`), 200)
    assert.equal(grant.enabled, true)
    await responseJson(await fetch(`${BASE}/v1/community/items/resource-packs/${resourcePackPilot.id}/revisions/${resourcePackPilot.revision.id}/composition`, {
        method: 'PUT', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, termsAccepted: false })
    }), 200)
    assert.equal((await fetch(`${BASE}/v1/community/composer/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: [{ sourceItemId: resourcePackPilot.id, sourceRevisionId: resourcePackPilot.revision.id, componentKey: components.items[0].key }] })
    })).status, 409)

    const traversal = await fetch(`${BASE}/v1/community/items/resource-packs/not-a-uuid/download`)
    assert.equal(traversal.status, 400)
})
