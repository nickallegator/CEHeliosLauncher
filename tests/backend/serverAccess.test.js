'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const express = require('../../backend/node_modules/express')
const http = require('node:http')
const test = require('node:test')

const {
    parseCredentials,
    authenticateCredential,
    hyphenateUuid,
    buildWhitelistPayload
} = require('../../backend/src/services/serverAccess')
const { createServerAccessRouter } = require('../../backend/src/routes/serverAccess')

async function withServer(router, callback) {
    const app = express()
    app.use((req, res, next) => {
        req.requestId = 'test-request'
        next()
    })
    app.use('/v1', router)
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }))
    const server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        await callback(`http://127.0.0.1:${server.address().port}`)
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
}

test('server credentials are scoped, hashed, and timing-safe comparable', () => {
    const token = 'a'.repeat(48)
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const credentials = parseCredentials(`ag-prod-01=${hash},ag-stage-01=${'b'.repeat(64)}`)
    assert.equal(credentials.size, 2)
    assert.equal(authenticateCredential('AG-PROD-01', token, credentials), true)
    assert.equal(authenticateCredential('ag-prod-01', 'c'.repeat(48), credentials), false)
    assert.equal(authenticateCredential('unknown', token, credentials), false)
    assert.throws(() => parseCredentials(`ag-prod-01=${hash},ag-prod-01=${hash}`), /Duplicate/)
    assert.throws(() => parseCredentials('ag-prod-01=plaintext-secret'), /hash/)
})

test('server whitelist payload is deterministic and excludes unresolved profiles', () => {
    const rows = [
        { minecraftUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Tester_2' },
        { minecraftUuid: '11111111111111111111111111111111', displayName: null },
        { minecraftUuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', displayName: 'Tester1' }
    ]
    const first = buildWhitelistPayload(rows, new Date('2026-09-06T12:00:00Z'))
    const second = buildWhitelistPayload([...rows].reverse(), new Date('2026-09-06T12:05:00Z'))
    assert.equal(first.revision, second.revision)
    assert.equal(first.activeCount, 3)
    assert.equal(first.resolvedCount, 2)
    assert.equal(first.pendingProfileCount, 1)
    assert.deepEqual(first.players, [
        { uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Tester_2' },
        { uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Tester1' }
    ])
})

test('server whitelist rejects malformed and ambiguous identities', () => {
    assert.equal(hyphenateUuid('00112233-4455-6677-8899-aabbccddeeff'), '00112233-4455-6677-8899-aabbccddeeff')
    assert.throws(() => buildWhitelistPayload([
        { minecraftUuid: 'a'.repeat(32), displayName: 'SameName' },
        { minecraftUuid: 'b'.repeat(32), displayName: 'samename' }
    ]), /Duplicate Minecraft name/)
    assert.throws(() => buildWhitelistPayload([
        { minecraftUuid: 'not-a-uuid', displayName: 'Tester' }
    ]), /Invalid Minecraft UUID/)
})

test('server whitelist endpoint authenticates, returns ETags, and supports conditional checks', async () => {
    const token = 'z'.repeat(48)
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const router = createServerAccessRouter({
        credentials: `ag-prod-01=${hash}`,
        rateLimitPerMinute: 10,
        store: {
            async listActiveMinecraftServerPlayers() {
                return [{ minecraftUuid: 'a'.repeat(32), displayName: 'Tester' }]
            }
        }
    })
    await withServer(router, async baseUrl => {
        const denied = await fetch(`${baseUrl}/v1/internal/server-access/whitelist`)
        assert.equal(denied.status, 401)
        assert.equal(denied.headers.get('www-authenticate'), 'Bearer realm="ag-server-access"')

        const headers = { Authorization: `Bearer ${token}`, 'X-AG-Server-ID': 'ag-prod-01' }
        const response = await fetch(`${baseUrl}/v1/internal/server-access/whitelist`, { headers })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        const etag = response.headers.get('etag')
        const body = await response.json()
        assert.equal(body.resolvedCount, 1)
        assert.equal(etag, `"${body.revision}"`)

        const unchanged = await fetch(`${baseUrl}/v1/internal/server-access/whitelist`, {
            headers: { ...headers, 'If-None-Match': etag }
        })
        assert.equal(unchanged.status, 304)
    })
})
