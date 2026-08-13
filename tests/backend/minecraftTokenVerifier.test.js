const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
    MAX_TOKEN_LENGTH,
    MinecraftTokenVerificationError,
    loadTrustedKeys,
    parseKeyDocument,
    verifyMinecraftAccessToken
} = require('../../backend/src/services/minecraftTokenVerifier')

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const alternateKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const trustedKeys = parseKeyDocument({ authenticationKeys: [publicKey] })
const now = 1_786_585_000
const uuid = '83432a03e4f141158b29fdb3527ed589'

function signToken(payloadOverrides = {}, headerOverrides = {}, signingKey = keyPair.privateKey) {
    const header = { alg: 'RS256', kid: 'test-key', ...headerOverrides }
    const payload = {
        iss: 'authentication',
        iat: now - 10,
        nbf: now - 10,
        exp: now + 3600,
        profiles: { mc: uuid },
        sub: 'test-subject',
        ...payloadOverrides
    }
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const input = `${encodedHeader}.${encodedPayload}`
    const signature = crypto.sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')
    return `${input}.${signature}`
}

function assertRejected(token, code) {
    assert.throws(
        () => verifyMinecraftAccessToken(token, { keys: trustedKeys, now }),
        error => error instanceof MinecraftTokenVerificationError && error.code === code
    )
}

test('verifies a signed Minecraft token and returns its normalized UUID', () => {
    const result = verifyMinecraftAccessToken(signToken({ profiles: { mc: '83432a03-e4f1-4115-8b29-fdb3527ed589' } }), {
        keys: trustedKeys,
        now
    })
    assert.equal(result.id, uuid)
    assert.equal(result.claims.subject, 'test-subject')
    assert.equal(result.claims.expiresAt, now + 3600)
})

test('rejects invalid signatures and algorithms', () => {
    assertRejected(signToken({}, {}, alternateKeyPair.privateKey), 'invalid_signature')
    assertRejected(signToken({}, { alg: 'none' }), 'invalid_algorithm')
})

test('rejects expired, future, excessive-lifetime, and wrong-issuer tokens', () => {
    assertRejected(signToken({ exp: now - 61 }), 'token_expired')
    assertRejected(signToken({ nbf: now + 61 }), 'token_not_active')
    assertRejected(signToken({ iat: now - 10, exp: now + (49 * 60 * 60) }), 'invalid_claims')
    assertRejected(signToken({ iss: 'another-service' }), 'invalid_issuer')
})

test('rejects malformed tokens and invalid profile claims', () => {
    assertRejected('not-a-jwt', 'malformed_token')
    assertRejected('x'.repeat(MAX_TOKEN_LENGTH + 1), 'malformed_token')
    assertRejected(signToken({ profiles: {} }), 'invalid_profile')
    assertRejected(signToken({ profiles: { mc: '../invalid' } }), 'invalid_profile')
})

test('loads a valid environment override and rejects malformed key configuration', () => {
    const keys = loadTrustedKeys({ MINECRAFT_AUTH_KEYS_JSON: JSON.stringify({ authenticationKeys: [publicKey] }) })
    assert.equal(keys.length, 1)
    assert.throws(() => loadTrustedKeys({ MINECRAFT_AUTH_KEYS_JSON: '{' }), /not valid JSON/)
    assert.throws(() => parseKeyDocument({ authenticationKeys: [] }), /between 1 and 8/)
})
