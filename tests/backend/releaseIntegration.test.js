'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const PORT = 8091
const BASE_URL = `http://127.0.0.1:${PORT}`

async function waitForReady(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    while(Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE_URL}/ready`)
            if(response.ok) return true
        } catch(_err) { /* server is still starting */ }
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    return false
}

test('authenticated release flow works against staging Postgres and S3 storage', async (t) => {
    const databaseUrl = process.env.DATABASE_URL_TEST
    const endpoint = process.env.RELEASES_INTEGRATION_STORAGE_ENDPOINT
    const bucket = process.env.RELEASES_INTEGRATION_STORAGE_BUCKET
    const accessKeyId = process.env.RELEASES_INTEGRATION_STORAGE_ACCESS_KEY_ID
    const secretAccessKey = process.env.RELEASES_INTEGRATION_STORAGE_SECRET_ACCESS_KEY
    if(!databaseUrl || !endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        t.skip('Set DATABASE_URL_TEST and RELEASES_INTEGRATION_STORAGE_* to run the release integration test.')
        return
    }

    process.env.DATABASE_URL = databaseUrl
    const db = require('../../backend/src/db')
    const store = require('../../backend/src/services/store')
    const sessions = require('../../backend/src/services/sessions')
    const uuid = '12345678123412341234123456789abc'
    let userId
    try {
        await db.query('select 1 from minecraft_testers limit 1')
        await store.upsertMinecraftTester(uuid, 'Release integration test')
        userId = await store.upsertUser('minecraft', uuid, 'Release Integration')
        await store.replaceEntitlements(userId, ['minecraft:player', 'cobblepower:test'], 'minecraft')
    } catch(err) {
        await db.pool.end()
        t.skip(`Release migration is not available: ${err.message}`)
        return
    }
    const session = await sessions.createSession(userId)
    const child = spawn(process.execPath, ['src/index.js'], {
        cwd: path.resolve(__dirname, '..', '..', 'backend'),
        env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: databaseUrl,
            RELEASES_ENABLED: 'true',
            RELEASES_CHANNEL: 'test',
            RELEASES_STORAGE_PROVIDER: 's3',
            RELEASES_STORAGE_ENDPOINT: endpoint,
            RELEASES_STORAGE_BUCKET: bucket,
            RELEASES_STORAGE_REGION: process.env.RELEASES_INTEGRATION_STORAGE_REGION || 'auto',
            RELEASES_STORAGE_ACCESS_KEY_ID: accessKeyId,
            RELEASES_STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
            RELEASES_STORAGE_FORCE_PATH_STYLE: process.env.RELEASES_INTEGRATION_STORAGE_FORCE_PATH_STYLE || 'false',
            SCHEMATICS_ENABLED: 'false'
        },
        stdio: 'inherit'
    })
    t.after(async () => {
        child.kill()
        await db.query('delete from sessions where user_id = $1', [userId])
        await db.query('delete from entitlements where user_id = $1', [userId])
        await db.query('delete from users where id = $1', [userId])
        await db.query('delete from minecraft_testers where minecraft_uuid = $1', [uuid])
        await db.pool.end()
    })

    assert.equal(await waitForReady(), true)
    const unauthenticated = await fetch(`${BASE_URL}/v1/releases/channels/test/distribution`)
    assert.equal(unauthenticated.status, 401)
    const authorized = await fetch(`${BASE_URL}/v1/releases/channels/test/distribution`, {
        headers: { Authorization: `Bearer ${session.token}` }
    })
    assert.equal(authorized.status, 200)
    assert.equal(authorized.headers.get('cache-control'), 'private, no-store')
    assert.ok(authorized.headers.get('x-cobblepower-release'))
    const body = await authorized.text()
    assert.equal(body.includes('r2://'), false)
    assert.match(body, /https?:\/\//)

    await store.disableMinecraftTester(uuid)
    const revoked = await fetch(`${BASE_URL}/v1/releases/channels/test/distribution`, {
        headers: { Authorization: `Bearer ${session.token}` }
    })
    assert.equal(revoked.status, 403)
})
