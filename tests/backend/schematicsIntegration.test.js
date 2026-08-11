'use strict'

const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const test = require('node:test')

const { CreateBucketCommand, HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3')
const sharp = require('../../backend/node_modules/sharp')
const core = require('../../libraries/schematics-core')

const REQUIRED = process.env.SCHEMATICS_INTEGRATION_REQUIRED === '1'
const DATABASE_URL = process.env.DATABASE_URL_TEST || ''
const ENDPOINT = process.env.SCHEMATICS_INTEGRATION_STORAGE_ENDPOINT || ''
const BUCKET = process.env.SCHEMATICS_INTEGRATION_STORAGE_BUCKET || 'cobblepower-schematics-test'
const ACCESS_KEY = process.env.SCHEMATICS_INTEGRATION_STORAGE_ACCESS_KEY_ID || 'cobblepower-test'
const SECRET_KEY = process.env.SCHEMATICS_INTEGRATION_STORAGE_SECRET_ACCESS_KEY || 'cobblepower-test-secret'
const PORT = 8094
const BASE = `http://127.0.0.1:${PORT}`

async function readJson(response, expectedStatus) {
    const body = await response.text()
    assert.equal(response.status, expectedStatus, body)
    return JSON.parse(body)
}

async function waitForReady(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while(Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/ready`)
            if(response.ok) return
        } catch(_err) {
            // Readiness is expected to fail while the child process starts.
        }
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('Schematic integration backend did not become ready.')
}

async function ensureBucket() {
    const client = new S3Client({
        region: 'us-east-1',
        endpoint: ENDPOINT,
        forcePathStyle: true,
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
    })
    try {
        await client.send(new HeadBucketCommand({ Bucket: BUCKET }))
    } catch(_err) {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
    }
}

async function uploadRevision({ token, targetSchematicId = null, name, canonical, schematicBody = null, preview }) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }
    const create = await fetch(`${BASE}/v1/schematics/uploads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, description: 'Integration test', tags: ['pilot'], visibility: 'public', previewMime: 'image/png', targetSchematicId })
    })
    const session = await readJson(create, 201)
    for(const [descriptor, body] of [
        [session.uploads.schematic, schematicBody || Buffer.from(JSON.stringify(canonical))],
        [session.uploads.preview, preview]
    ]) {
        const put = await fetch(descriptor.uploadUrl, { method: 'PUT', headers: { 'Content-Type': descriptor.mime }, body })
        assert.equal(put.ok, true, `signed PUT failed: ${put.status}`)
    }
    return fetch(`${BASE}/v1/schematics/uploads/${encodeURIComponent(session.token)}/finalize`, {
        method: 'POST', headers, body: '{}'
    })
}

test('schematic community migrates, validates R2 bytes, revisions, and moderation', { skip: !REQUIRED }, async t => {
    assert.ok(DATABASE_URL, 'DATABASE_URL_TEST is required')
    assert.ok(ENDPOINT, 'SCHEMATICS_INTEGRATION_STORAGE_ENDPOINT is required')
    const migration = spawnSync(process.execPath, ['scripts/db-migrate.js', '--database-url', DATABASE_URL], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'),
        encoding: 'utf8'
    })
    assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`)
    const migrationAgain = spawnSync(process.execPath, ['scripts/db-migrate.js', '--database-url', DATABASE_URL], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'),
        encoding: 'utf8'
    })
    assert.equal(migrationAgain.status, 0, `${migrationAgain.stdout}\n${migrationAgain.stderr}`)
    await ensureBucket()

    const child = spawn(process.execPath, ['src/index.js'], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(PORT),
            DATABASE_URL,
            RELEASES_ENABLED: 'false',
            SCHEMATICS_ENABLED: 'true',
            SCHEMATICS_WRITE_MODE: 'authenticated',
            SCHEMATICS_STORAGE_PROVIDER: 's3',
            SCHEMATICS_STORAGE_BUCKET: BUCKET,
            SCHEMATICS_STORAGE_REGION: 'us-east-1',
            SCHEMATICS_STORAGE_ENDPOINT: ENDPOINT,
            SCHEMATICS_STORAGE_ACCESS_KEY_ID: ACCESS_KEY,
            SCHEMATICS_STORAGE_SECRET_ACCESS_KEY: SECRET_KEY,
            SCHEMATICS_STORAGE_FORCE_PATH_STYLE: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    t.after(() => child.kill())
    await waitForReady().catch(error => { throw new Error(`${error.message}\n${output}`) })

    process.env.DATABASE_URL = DATABASE_URL
    const db = require('../../backend/src/db')
    const store = require('../../backend/src/services/store')
    const sessions = require('../../backend/src/services/sessions')
    t.after(() => db.pool.end())
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`
    const userId = await store.upsertUser('minecraft', `00112233445566778899aabb${suffix.slice(-8).padStart(8, '0')}`.slice(0, 32), 'Integration Builder')
    const session = await sessions.createSession(userId)

    const malicious = {
        format: core.FORMAT_ID,
        version: 2,
        id: 'cobblepower:source/pilot',
        name: 'Pilot',
        category: 'utility',
        type: 'standard',
        palette: ['minecraft:chest[facing=north,type=single,waterlogged=false]'],
        blocks: [{ pos: [0, 0, 0], state: 0, nbt: '{Items:[{id:"minecraft:diamond",count:64}]}' }]
    }
    const preview = await sharp({ create: { width: 640, height: 360, channels: 4, background: '#345678' } }).png().toBuffer()
    const first = await uploadRevision({ token: session.token, name: 'Community Pilot', canonical: malicious, preview })
    const published = await readJson(first, 201)
    assert.equal(published.schemaVersion, 2)
    assert.equal(published.revision.number, 1)
    assert.equal(published.sanitization.blockEntityNbtRemoved, 1)

    const list = await fetch(`${BASE}/v1/schematics`)
    assert.equal(list.status, 200)
    assert.ok((await list.json()).items.some(item => item.id === published.id))
    const download = await fetch(`${BASE}/v1/schematics/${published.id}/download`)
    assert.equal(download.status, 200)
    const downloaded = await download.json()
    assert.equal(downloaded.blocks[0].nbt, undefined)
    assert.equal(core.parseCanonicalSchematic(downloaded).sha256, published.revision.sha256)

    const revisedCanonical = { ...malicious, name: 'Pilot v2', palette: ['minecraft:stone'], blocks: [{ pos: [0, 0, 0], state: 0 }] }
    const second = await uploadRevision({ token: session.token, targetSchematicId: published.id, name: 'Community Pilot', canonical: revisedCanonical, preview })
    const revised = await readJson(second, 201)
    assert.equal(revised.revision.number, 2)
    assert.notEqual(revised.revision.sha256, published.revision.sha256)

    const duplicate = await uploadRevision({ token: session.token, targetSchematicId: published.id, name: 'Community Pilot', canonical: revisedCanonical, preview })
    assert.equal((await readJson(duplicate, 200)).alreadyCurrent, true)

    const anonymousReport = await fetch(`${BASE}/v1/schematics/${published.id}/report`, { method: 'POST' })
    assert.equal(anonymousReport.status, 401)
    const report = await fetch(`${BASE}/v1/schematics/${published.id}/report`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test' })
    })
    assert.equal(report.status, 201)

    const invalidId = await fetch(`${BASE}/v1/schematics/not-a-uuid`)
    assert.equal(invalidId.status, 400)

    const privateUpload = await fetch(`${BASE}/v1/schematics/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private', visibility: 'private', previewMime: 'image/png' })
    })
    assert.equal(privateUpload.status, 400)

    const malformed = await uploadRevision({
        token: session.token,
        name: 'Malformed',
        schematicBody: Buffer.from('{not-json'),
        preview
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error, 'invalid_json')

    const badPreview = await uploadRevision({
        token: session.token,
        name: 'Bad Preview',
        canonical: revisedCanonical,
        preview: Buffer.from('not-an-image')
    })
    assert.equal(badPreview.status, 400)
    assert.equal((await badPreview.json()).error, 'invalid_preview')

    const oversized = await uploadRevision({
        token: session.token,
        name: 'Oversized',
        schematicBody: Buffer.alloc((5 * 1024 * 1024) + 1, 0x20),
        preview
    })
    assert.equal(oversized.status, 400)
    assert.equal((await oversized.json()).error, 'file_too_large')

    const secondUuid = crypto.randomUUID().replace(/-/g, '')
    const secondUserId = await store.upsertUser('minecraft', secondUuid, 'Other Builder')
    const secondSession = await sessions.createSession(secondUserId)
    const stolenRevision = await fetch(`${BASE}/v1/schematics/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secondSession.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Stolen', visibility: 'public', previewMime: 'image/png', targetSchematicId: published.id })
    })
    assert.equal(stolenRevision.status, 403)

    const ownerHide = await fetch(`${BASE}/v1/schematics/${published.id}/hide`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}` }
    })
    assert.equal(ownerHide.status, 403)
    await store.replaceEntitlements(userId, ['minecraft:player', 'schematics:admin'], 'minecraft')
    const hidden = await fetch(`${BASE}/v1/schematics/${published.id}/hide`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}` }
    })
    assert.equal(hidden.status, 200)
    assert.equal((await fetch(`${BASE}/v1/schematics/${published.id}`)).status, 404)
    const hiddenRevision = await uploadRevision({
        token: session.token,
        targetSchematicId: published.id,
        name: 'Community Pilot',
        canonical: { ...revisedCanonical, blocks: [{ pos: [1, 0, 0], state: 0 }] },
        preview
    })
    const hiddenRevisionResult = await readJson(hiddenRevision, 201)
    assert.equal(hiddenRevisionResult.status, 'hidden')
    assert.equal((await fetch(`${BASE}/v1/schematics/${published.id}`)).status, 404)
    const reports = await readJson(await fetch(`${BASE}/v1/schematics/admin/reports`, {
        headers: { Authorization: `Bearer ${session.token}` }
    }), 200)
    assert.ok(reports.items.some(item => Number(item.id) > 0))
    const reportId = reports.items[0].id
    const resolved = await fetch(`${BASE}/v1/schematics/admin/reports/${reportId}/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Integration verification' })
    })
    assert.equal(resolved.status, 200)
    const restored = await fetch(`${BASE}/v1/schematics/${published.id}/restore`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}` }
    })
    assert.equal(restored.status, 200)
    assert.equal((await fetch(`${BASE}/v1/schematics/${published.id}`)).status, 200)
})
