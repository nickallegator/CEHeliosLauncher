'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    createLauncherVersionMiddleware,
    createLauncherVersionPolicies,
    normalizePolicy,
    publicPolicy
} = require('../../backend/src/services/launcherVersionPolicy')

function runMiddleware(policies, options = {}) {
    const headers = options.headers || {}
    const response = {
        statusCode: 200,
        headers: {},
        body: null,
        status(value) { this.statusCode = value; return this },
        set(name, value) { this.headers[name] = value; return this },
        json(value) { this.body = value; return this }
    }
    let nextCalled = false
    createLauncherVersionMiddleware(policies)(
        { headers, path: options.path || '/releases/channels/test/distribution', requestId: 'request-1' },
        response,
        () => { nextCalled = true }
    )
    return { nextCalled, response }
}

test('launcher policies validate channels, versions, URLs, and duplicates', () => {
    const policy = normalizePolicy({
        channel: 'test',
        recommendedVersion: '2.8.0-test.2',
        minimumVersion: '2.8.0-test.1',
        updateUrl: 'https://github.com/nickallegator/CEHeliosLauncher/releases',
        enforce: true
    })
    assert.equal(publicPolicy(policy).schemaVersion, 1)
    assert.throws(() => normalizePolicy({ channel: 'nightly' }), /invalid channel/)
    assert.throws(() => normalizePolicy({ channel: 'test', recommendedVersion: '2.8' }), /SemVer/)
    assert.throws(() => normalizePolicy({ channel: 'test', updateUrl: 'http://example.com' }), /HTTPS/)
    assert.throws(() => createLauncherVersionPolicies([policy, policy]), /Duplicate/)
})

test('disabled policies and migration clients pass through protected routes', () => {
    const policies = createLauncherVersionPolicies([{
        channel: 'test', minimumVersion: '2.8.0-test.1', enforce: false
    }])
    assert.equal(runMiddleware(policies, { headers: { authorization: 'Bearer token' } }).nextCalled, true)

    const enforced = createLauncherVersionPolicies([{
        channel: 'test', minimumVersion: '2.8.0-test.1', enforce: true, requireHeader: false
    }])
    assert.equal(runMiddleware(enforced, { headers: { authorization: 'Bearer token', 'x-ag-launcher-channel': 'test' } }).nextCalled, true)
})

test('enforced minimum versions return a structured 426 without blocking auth', () => {
    const policies = createLauncherVersionPolicies([{
        channel: 'test',
        recommendedVersion: '2.8.0-test.2',
        minimumVersion: '2.8.0-test.2',
        updateUrl: 'https://github.com/nickallegator/CEHeliosLauncher/releases',
        enforce: true,
        requireHeader: true
    }])
    const denied = runMiddleware(policies, {
        headers: {
            authorization: 'Bearer token',
            'x-ag-launcher-channel': 'test',
            'x-ag-launcher-version': '2.8.0-test.1'
        }
    })
    assert.equal(denied.nextCalled, false)
    assert.equal(denied.response.statusCode, 426)
    assert.equal(denied.response.body.error, 'launcher_update_required')
    assert.equal(denied.response.body.minimumVersion, '2.8.0-test.2')
    assert.equal(denied.response.body.requestId, 'request-1')
    assert.equal(denied.response.headers['Cache-Control'], 'private, no-store')

    const auth = runMiddleware(policies, {
        path: '/auth/minecraft',
        headers: { authorization: 'Bearer token' }
    })
    assert.equal(auth.nextCalled, true)
})

test('current and newer compatible versions pass an enforced policy', () => {
    const policies = createLauncherVersionPolicies([{
        channel: 'test', minimumVersion: '2.8.0-test.2', enforce: true, requireHeader: true
    }])
    for(const version of ['2.8.0-test.2', '2.8.1-test.1']) {
        const result = runMiddleware(policies, {
            headers: {
                authorization: 'Bearer token',
                'x-ag-launcher-channel': 'test',
                'x-ag-launcher-version': version
            }
        })
        assert.equal(result.nextCalled, true)
    }
})
