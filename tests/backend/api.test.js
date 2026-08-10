const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { normalizeJsonSchematic } = require('../../libraries/schematics-core')

const PORT = 8090
const BASE_URL = `http://localhost:${PORT}`
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const PRIVATE_CACHE_CONTROL = 'private, max-age=60'

function getDatabaseUrl() {
    return process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || ''
}

const DATABASE_URL = getDatabaseUrl()
if (DATABASE_URL) {
    process.env.DATABASE_URL = DATABASE_URL
}

async function waitForHealth(timeoutMs = 8000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${BASE_URL}/health`)
            if (res.ok) {
                return true
            }
        } catch (err) {
            // ignore until ready
        }
        await new Promise((r) => setTimeout(r, 250))
    }
    return false
}

function startServer(options = {}) {
    const databaseUrl = getDatabaseUrl()
    if (!databaseUrl) {
        return { child: null, reason: 'DATABASE_URL or DATABASE_URL_TEST is not set.' }
    }

    const child = spawn('node', ['src/index.js'], {
        cwd: require('node:path').resolve(__dirname, '..', '..', 'backend'),
        env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: databaseUrl,
            SCHEMATICS_STORAGE_DIR: options.storageDir || '',
            SCHEMATICS_STORAGE_PROVIDER: '',
            SCHEMATICS_STORAGE_BUCKET: '',
            SCHEMATICS_STORAGE_ENDPOINT: '',
            SCHEMATICS_STORAGE_ACCESS_KEY_ID: '',
            SCHEMATICS_STORAGE_SECRET_ACCESS_KEY: '',
            SCHEMATICS_STORAGE_PUBLIC_BASE_URL: '',
            SCHEMATICS_STORAGE_FORCE_PATH_STYLE: '',
            SCHEMATICS_STORAGE_PUBLIC_CACHE_CONTROL: PUBLIC_CACHE_CONTROL,
            SCHEMATICS_STORAGE_PRIVATE_CACHE_CONTROL: PRIVATE_CACHE_CONTROL
        },
        stdio: 'inherit'
    })

    return { child, reason: null }
}

test('backend health + schematics list', async (t) => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cehelios-schematics-'))
    const { child, reason } = startServer({ storageDir })
    if (!child) {
        t.skip(reason)
        return
    }

    const cleanup = {
        users: [],
        schematics: []
    }
    let db = null
    t.after(async () => {
        try {
            if(db){
                if(cleanup.schematics.length > 0){
                    await db.query('delete from schematics where id = any($1::uuid[])', [cleanup.schematics])
                }
                if(cleanup.users.length > 0){
                    await db.query('delete from sessions where user_id = any($1::bigint[])', [cleanup.users])
                    await db.query('delete from users where id = any($1::bigint[])', [cleanup.users])
                }
                await db.pool.end()
            }
        } catch (err) {
            // ignore cleanup errors
        } finally {
            child.kill()
            await fs.rm(storageDir, { recursive: true, force: true })
        }
    })

    const ready = await waitForHealth()
    assert.equal(ready, true, 'backend should be reachable')

    const health = await fetch(`${BASE_URL}/health`)
    assert.equal(health.status, 200)
    const healthJson = await health.json()
    assert.equal(healthJson.ok, true)

    const list = await fetch(`${BASE_URL}/v1/schematics`)
    assert.equal(list.status, 200)
    const listJson = await list.json()
    assert.ok(listJson && typeof listJson === 'object')
    assert.ok(Array.isArray(listJson.items))

    db = require('../../backend/src/db')
    try {
        await db.query('select 1 from schematics limit 1')
    } catch (err) {
        if(err?.code === '42P01'){
            t.skip('schematics schema not available; run migrations to enable upload tests')
            return
        }
        throw err
    }

    const store = require('../../backend/src/services/store')
    const sessions = require('../../backend/src/services/sessions')

    const userIdA = await store.upsertUser('test', `test-${Date.now()}-a`, 'Test User A')
    const sessionA = await sessions.createSession(userIdA)
    cleanup.users.push(userIdA)

    const userIdB = await store.upsertUser('test', `test-${Date.now()}-b`, 'Test User B')
    const sessionB = await sessions.createSession(userIdB)
    cleanup.users.push(userIdB)

    const schematic = {
        name: 'Test Build',
        category: 'test',
        icon: 'minecraft:stone',
        blocks: [
            { pos: [0, 0, 0], block: 'minecraft:stone' },
            { pos: [1, 0, 0], block: 'minecraft:stone' }
        ]
    }
    const schematicSizeBytes = Buffer.byteLength(JSON.stringify(schematic))
    const normalized = await normalizeJsonSchematic(schematic, {})
    const hash = normalized?.schematic?.meta?.hash || crypto.createHash('sha256').update(JSON.stringify(schematic)).digest('hex')
    const thumbnailBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const thumbnailBuffer = Buffer.from(thumbnailBase64, 'base64')
    const thumbnailPayload = {
        label: 'tiny',
        mime: 'image/png',
        width: 1,
        height: 1,
        sizeBytes: thumbnailBuffer.length,
        data: thumbnailBase64
    }

    const headersA = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionA.token}`
    }
    const headersB = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionB.token}`
    }

    const preflight = await fetch(`${BASE_URL}/v1/schematics/preflight`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({
            sizeBytes: schematicSizeBytes,
            thumbnails: [],
            hash,
            format: 'json'
        })
    })
    assert.equal(preflight.status, 200)
    const preflightJson = await preflight.json()
    assert.ok(preflightJson?.token)

    const wrongUserUpload = await fetch(`${BASE_URL}/v1/schematics/upload/${encodeURIComponent(preflightJson.token)}`, {
        method: 'POST',
        headers: headersB,
        body: JSON.stringify({
            name: 'Test Build',
            creator: 'Tester',
            visibility: 'public',
            format: 'json',
            hash,
            sizeBytes: schematicSizeBytes,
            blockCount: schematic.blocks.length,
            schematic
        })
    })
    assert.equal(wrongUserUpload.status, 403)

    const uploadA = await fetch(`${BASE_URL}/v1/schematics/upload/${encodeURIComponent(preflightJson.token)}`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({
            name: 'Test Build',
            creator: 'Tester',
            visibility: 'public',
            format: 'json',
            hash,
            sizeBytes: schematicSizeBytes,
            blockCount: schematic.blocks.length,
            schematic,
            thumbnails: [thumbnailPayload]
        })
    })
    assert.equal(uploadA.status, 200)
    const uploadAJson = await uploadA.json()
    cleanup.schematics.push(uploadAJson.id)

    const preflight2 = await fetch(`${BASE_URL}/v1/schematics/preflight`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({
            sizeBytes: schematicSizeBytes,
            thumbnails: [],
            hash,
            format: 'json'
        })
    })
    assert.equal(preflight2.status, 200)
    const preflight2Json = await preflight2.json()
    assert.ok(preflight2Json?.token)

    const uploadB = await fetch(`${BASE_URL}/v1/schematics/upload/${encodeURIComponent(preflight2Json.token)}`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({
            name: 'Test Build Copy',
            creator: 'Tester',
            visibility: 'private',
            format: 'json',
            hash,
            sizeBytes: schematicSizeBytes,
            blockCount: schematic.blocks.length,
            schematic,
            thumbnails: [thumbnailPayload]
        })
    })
    assert.equal(uploadB.status, 200)
    const uploadBJson = await uploadB.json()
    cleanup.schematics.push(uploadBJson.id)

    const objectKeys = await db.query(
        'select id, object_key from schematics where hash = $1 order by created_at asc',
        [hash]
    )
    assert.equal(objectKeys.rows.length, 2)
    assert.ok(objectKeys.rows[0]?.object_key)
    assert.equal(objectKeys.rows[0].object_key, objectKeys.rows[1].object_key)

    const likeResponse = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadAJson.id)}/like`, {
        method: 'POST',
        headers: headersA
    })
    assert.equal(likeResponse.status, 200)
    const likeJson = await likeResponse.json()
    assert.equal(likeJson.liked, true)
    assert.ok(Number.isFinite(Number(likeJson.likes)))

    const listAfterLike = await fetch(`${BASE_URL}/v1/schematics`, {
        method: 'GET',
        headers: headersA
    })
    assert.equal(listAfterLike.status, 200)
    const listAfterLikeJson = await listAfterLike.json()
    const likedEntry = Array.isArray(listAfterLikeJson?.items)
        ? listAfterLikeJson.items.find(item => item.id === uploadAJson.id)
        : null
    assert.ok(likedEntry)
    assert.equal(likedEntry.liked, true)
    assert.ok(Number.isFinite(Number(likedEntry.likes)))
    assert.ok(Number.isFinite(Number(likedEntry.views)))

    const unlikeResponse = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadAJson.id)}/like`, {
        method: 'DELETE',
        headers: headersA
    })
    assert.equal(unlikeResponse.status, 200)
    const unlikeJson = await unlikeResponse.json()
    assert.equal(unlikeJson.liked, false)
    assert.ok(Number.isFinite(Number(unlikeJson.likes)))

    const viewResponse1 = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadAJson.id)}/view`, {
        method: 'POST',
        headers: headersA
    })
    assert.equal(viewResponse1.status, 200)
    const viewJson1 = await viewResponse1.json()
    assert.ok(Number.isFinite(Number(viewJson1.views)))

    const viewResponse2 = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadAJson.id)}/view`, {
        method: 'POST',
        headers: headersA
    })
    assert.equal(viewResponse2.status, 200)
    const viewJson2 = await viewResponse2.json()
    assert.ok(Number.isFinite(Number(viewJson2.views)))
    assert.equal(Number(viewJson2.views), Number(viewJson1.views))

    const publicThumb = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadAJson.id)}/thumbnail?size=tiny`, {
        method: 'GET'
    })
    assert.equal(publicThumb.status, 200)
    assert.equal(publicThumb.headers.get('cache-control'), PUBLIC_CACHE_CONTROL)

    const privateThumb = await fetch(`${BASE_URL}/v1/schematics/${encodeURIComponent(uploadBJson.id)}/thumbnail?size=tiny`, {
        method: 'GET',
        headers: headersA
    })
    assert.equal(privateThumb.status, 200)
    assert.equal(privateThumb.headers.get('cache-control'), PRIVATE_CACHE_CONTROL)
})
