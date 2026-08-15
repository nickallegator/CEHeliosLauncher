'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createExternalTokenEncryption } = require('../../backend/src/services/externalTokenEncryption')
const { createModrinthProvider, isPrivateAddress, validateDownloadUrl } = require('../../backend/src/services/modrinth')
const { compareIndex, normalizeChannels } = require('../../backend/src/services/modrinthSources')

const settings = {
    clientId: 'client-id', clientSecret: 'never-exposed', redirectUri: 'https://api.example.test/v1/integrations/modrinth/oauth/callback',
    scopes: ['USER_READ','PROJECT_READ'], authorizeUrl: 'https://modrinth.com/auth/authorize',
    tokenUrl: 'https://api.modrinth.com/_internal/oauth/token', apiBase: 'https://api.modrinth.com', userAgent: 'AGLauncher/test'
}

test('external OAuth tokens use authenticated AES-256-GCM encryption', () => {
    const encryption = createExternalTokenEncryption(crypto.randomBytes(32).toString('base64'), 'test-key')
    const encrypted = encryption.encrypt('secret-access-token')
    assert.notEqual(encrypted.ciphertext, 'secret-access-token')
    assert.equal(encryption.decrypt(encrypted), 'secret-access-token')
    assert.throws(() => encryption.decrypt({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }))
})

test('Modrinth authorization requests only the configured identity and project-read scopes', () => {
    const provider = createModrinthProvider(settings, { fetch: async () => { throw new Error('not used') } })
    const url = new URL(provider.authorizationUrl({ state: 'one-time-state' }))
    assert.equal(url.origin, 'https://modrinth.com')
    assert.equal(url.searchParams.get('scope'), 'USER_READ PROJECT_READ')
    assert.equal(url.searchParams.get('state'), 'one-time-state')
    assert.equal(url.toString().includes(settings.clientSecret), false)
})

test('Modrinth token exchange keeps the client secret in the authorization header', async () => {
    let captured
    const provider = createModrinthProvider(settings, { fetch: async (url, options) => {
        captured = { url: String(url), options }
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
    } })
    await provider.exchangeCode('one-time-code')
    assert.equal(captured.options.headers.Authorization, settings.clientSecret)
    assert.equal(String(captured.options.body).includes('client_secret'), false)
})

test('Modrinth ownership requires an accepted member with the UPLOAD_VERSION bit', async () => {
    const responses = new Map([
        ['/v2/team/team/members', [{ user: { id: 'owner' }, accepted: true, permissions: 1 }]]
    ])
    const provider = createModrinthProvider(settings, { fetch: async url => new Response(JSON.stringify(responses.get(new URL(url).pathname)), { status: 200, headers: { 'content-type': 'application/json' } }) })
    await provider.verifyOwnership({ team: 'team' }, 'owner', 'token')
    await assert.rejects(() => provider.verifyOwnership({ team: 'team' }, 'someone-else', 'token'), error => error.code === 'modrinth_project_permission_required')
})

test('Modrinth downloads are host-restricted and verify size, SHA-512, and SHA-256 while streaming', async () => {
    assert.equal(validateDownloadUrl('https://cdn.modrinth.com/data/project/versions/version/pack.zip').hostname, 'cdn.modrinth.com')
    assert.throws(() => validateDownloadUrl('https://example.com/pack.zip'), error => error.code === 'modrinth_unsafe_download_url')
    const payload = Buffer.from('resource-pack-test')
    const sha512 = crypto.createHash('sha512').update(payload).digest('hex')
    const provider = createModrinthProvider(settings, { lookup: async () => [{ address: '104.18.1.1', family: 4 }], fetch: async () => new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }) })
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-modrinth-test-'))
    try {
        const result = await provider.downloadToFile({ url: 'https://cdn.modrinth.com/data/p/v/x.zip', size: payload.length, hashes: { sha512 } }, path.join(directory, 'pack.zip'))
        assert.equal(result.sha512, sha512)
        assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'))
        assert.equal(result.sizeBytes, payload.length)
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }) }
})

test('Modrinth download DNS policy rejects private and link-local destinations', () => {
    for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.1.1','::1','fe80::1','fd00::1']) assert.equal(isPrivateAddress(address), true)
    assert.equal(isPrivateAddress('104.18.1.1'), false)
})

test('Modrinth migration makes revision object storage optional and backfills R2 sources', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../backend/migrations/2026-08-15_modrinth_sources.sql'), 'utf8')
    assert.match(sql, /alter table community_revisions alter column object_key drop not null/i)
    assert.match(sql, /create table if not exists community_revision_sources/i)
    assert.match(sql, /select id, 'r2', object_key/i)
    assert.match(sql, /unique \(provider, provider_project_id\)/i)
})

test('release channels and review diffs are deterministic and release-safe', () => {
    assert.deepEqual(normalizeChannels(['alpha','beta','alpha']), ['release','alpha','beta'])
    assert.deepEqual(compareIndex(
        [{ path: 'a', sha256: '1' }, { path: 'b', sha256: '2' }],
        [{ path: 'b', sha256: '3' }, { path: 'c', sha256: '4' }], 'path', 'sha256'
    ), { added: ['c'], removed: ['a'], changed: ['b'] })
})
