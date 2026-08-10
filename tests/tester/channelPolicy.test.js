'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { calculateOfflineGrant, isArtifactAuthorizationError, redactUrlQueries } = require('../../app/assets/js/channelpolicy')

test('offline grants expire exactly after the configured 24-hour window', () => {
    const authorizedAt = '2026-08-09T00:00:00.000Z'
    const grant = { channel: 'test', releaseId: 'release-1', authorizedAt }
    assert.equal(calculateOfflineGrant(grant, 'test', 86400, Date.parse(authorizedAt) + 86400_000).valid, true)
    assert.equal(calculateOfflineGrant(grant, 'test', 86400, Date.parse(authorizedAt) + 86400_001).valid, false)
    assert.equal(calculateOfflineGrant({ ...grant, channel: 'other' }, 'test', 86400, Date.parse(authorizedAt)).valid, false)
})

test('presigned URL query parameters are redacted from log text', () => {
    const input = 'download https://bucket.example/mod.jar?X-Amz-Credential=secret&X-Amz-Signature=hidden failed'
    const output = redactUrlQueries(input)
    assert.equal(output, 'download https://bucket.example/mod.jar?[redacted] failed')
    assert.equal(output.includes('secret'), false)
})

test('expired signed artifact responses are eligible for one authorization retry', () => {
    assert.equal(isArtifactAuthorizationError({ displayable: 'Error during request (HTTP Response 403)' }), true)
    assert.equal(isArtifactAuthorizationError({ message: 'HTTP 401 while downloading' }), true)
    assert.equal(isArtifactAuthorizationError({ message: 'checksum mismatch' }), false)
})
