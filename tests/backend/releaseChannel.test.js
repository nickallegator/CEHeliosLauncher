'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused'
process.env.RELEASES_STORAGE_BUCKET = 'test'
process.env.RELEASES_STORAGE_ACCESS_KEY_ID = 'test'
process.env.RELEASES_STORAGE_SECRET_ACCESS_KEY = 'test'

const {
    assertReleasePointer,
    createReleaseStorage,
    replaceR2Urls,
    validateObjectKey
} = require('../../backend/src/services/releaseStorage')
const { normalizeMinecraftUuid } = require('../../backend/src/services/store')
const { buildMinecraftEntitlements } = require('../../backend/src/routes/minecraftAuth')

test('Minecraft UUIDs normalize consistently and reject invalid identities', () => {
    assert.equal(normalizeMinecraftUuid('12345678-1234-1234-1234-123456789ABC'), '12345678123412341234123456789abc')
    assert.throws(() => normalizeMinecraftUuid('../tester'), /32 hexadecimal/)
})

test('Minecraft authentication grants and revokes only the test-channel entitlement', () => {
    assert.deepEqual(buildMinecraftEntitlements(true), ['minecraft:player', 'cobblepower:test'])
    assert.deepEqual(buildMinecraftEntitlements(false), ['minecraft:player'])
})

test('release pointer and R2 traversal validation rejects unsafe keys', () => {
    const pointer = assertReleasePointer({
        releaseId: 'cobble-power-1.0.1-test.1',
        templateKey: 'channels/test/releases/cobble-power-1.0.1-test.1/distribution-template.json',
        descriptorKey: 'channels/test/releases/cobble-power-1.0.1-test.1/release.json'
    }, 'test')
    assert.equal(pointer.releaseId, 'cobble-power-1.0.1-test.1')
    assert.throws(() => validateObjectKey('maven/../../secret'), /disallowed/)
    assert.throws(() => assertReleasePointer({ ...pointer, templateKey: 'channels/prod/releases/x/distribution-template.json' }, 'test'), /templateKey/)
})

test('authorized distributions recursively replace all permitted placeholders', async () => {
    const signed = await replaceR2Urls({
        servers: [{ modules: [{ artifact: { url: 'r2://maven/net/example/mod/1/mod-1.jar' } }] }]
    }, async key => `https://signed.example/${key}?signature=one-hour`)
    assert.equal(signed.servers[0].modules[0].artifact.url, 'https://signed.example/maven/net/example/mod/1/mod-1.jar?signature=one-hour')
})

test('release storage resolves current template and returns its release ID', async () => {
    const values = new Map([
        ['channels/test/current.json', {
            releaseId: 'release-1',
            templateKey: 'channels/test/releases/release-1/distribution-template.json',
            descriptorKey: 'channels/test/releases/release-1/release.json'
        }],
        ['channels/test/releases/release-1/distribution-template.json', {
            version: '1',
            servers: [{ modules: [{ artifact: { url: 'r2://maven/example/mod/1/mod-1.jar' } }] }]
        }]
    ])
    const service = createReleaseStorage({
        settings: { getTtlSeconds: 3600 },
        storage: {
            getJson: async key => values.get(key),
            signGet: async key => `https://signed.example/${key}?token=private`
        }
    })
    const result = await service.getAuthorizedDistribution('test')
    assert.equal(result.releaseId, 'release-1')
    assert.match(result.distribution.servers[0].modules[0].artifact.url, /^https:\/\/signed\.example\//)
})
