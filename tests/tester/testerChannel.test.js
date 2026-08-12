'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    loadTesterChannel,
    seedBundledArtifacts
} = require('../../app/assets/js/testerchannel')

function digest(buffer, algorithm) {
    return crypto.createHash(algorithm).update(buffer).digest('hex')
}

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-tester-channel-'))
    const artifact = Buffer.from('locked-test-mod')
    const sourcePath = path.join(root, 'artifacts', 'cobblepower.jar')
    const distributionPath = path.join(root, 'distribution_test.json')
    const channelPath = path.join(root, 'tester-channel.json')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, artifact)
    fs.writeFileSync(distributionPath, '{"version":"1.0.0","servers":[]}')
    fs.writeFileSync(channelPath, JSON.stringify({
        schemaVersion: 1,
        id: 'test',
        name: 'Test Channel',
        distribution: 'distribution_test.json',
        artifacts: [{
            id: 'example:test:1.0.0',
            source: 'artifacts/cobblepower.jar',
            destination: 'common/modstore/example/test/1.0.0/test-1.0.0.jar',
            size: artifact.length,
            md5: digest(artifact, 'md5'),
            sha256: digest(artifact, 'sha256')
        }]
    }))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return { artifact, channelPath, root }
}

test('tester channel resolves its bundled distribution and artifacts', (t) => {
    const fixture = createFixture(t)
    const channel = loadTesterChannel({ channelPath: fixture.channelPath })
    assert.equal(channel.id, 'test')
    assert.equal(channel.distributionPath, path.join(fixture.root, 'distribution_test.json'))
    assert.equal(channel.artifacts[0].sourcePath, path.join(fixture.root, 'artifacts', 'cobblepower.jar'))
})

test('bundled artifacts are installed atomically and corrupt copies are repaired', (t) => {
    const fixture = createFixture(t)
    const dataDirectory = path.join(fixture.root, 'data')
    const options = { channelPath: fixture.channelPath }
    const first = seedBundledArtifacts(dataDirectory, options)
    assert.equal(first.length, 1)
    const destination = first[0]
    assert.deepEqual(fs.readFileSync(destination), fixture.artifact)

    fs.writeFileSync(destination, 'corrupt')
    const repaired = seedBundledArtifacts(dataDirectory, options)
    assert.deepEqual(repaired, [destination])
    assert.deepEqual(fs.readFileSync(destination), fixture.artifact)
    assert.deepEqual(seedBundledArtifacts(dataDirectory, options), [])
})

test('tester channel rejects destination traversal', (t) => {
    const fixture = createFixture(t)
    const channel = JSON.parse(fs.readFileSync(fixture.channelPath, 'utf8'))
    channel.artifacts[0].destination = '../outside.jar'
    fs.writeFileSync(fixture.channelPath, JSON.stringify(channel))
    assert.throws(
        () => seedBundledArtifacts(path.join(fixture.root, 'data'), { channelPath: fixture.channelPath }),
        /must stay inside/
    )
})

test('schema v2 resolves a bootstrap distribution without bundled artifacts', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-v2-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(path.join(root, 'bootstrap.json'), '{"version":"1","servers":[]}')
    const channelPath = path.join(root, 'tester-channel.json')
    fs.writeFileSync(channelPath, JSON.stringify({
        schemaVersion: 2,
        id: 'cobble-power-test',
        name: 'Allegator Games Launcher',
        channel: 'test',
        bootstrapDistribution: 'bootstrap.json',
        remoteDistributionUrl: 'https://api.example.test/v1/releases/channels/test/distribution',
        requiredEntitlement: 'cobblepower:test',
        offlineGrantSeconds: 86400
    }))
    const channel = loadTesterChannel({ channelPath })
    assert.equal(channel.schemaVersion, 2)
    assert.equal(channel.bootstrapDistributionPath, path.join(root, 'bootstrap.json'))
    assert.deepEqual(channel.artifacts, [])
    assert.deepEqual(seedBundledArtifacts(path.join(root, 'data'), { channelPath }), [])
})

test('schema v2 rejects insecure remote endpoints and bootstrap traversal', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-v2-invalid-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const channelPath = path.join(root, 'tester-channel.json')
    const base = {
        schemaVersion: 2,
        id: 'test',
        name: 'Test',
        channel: 'test',
        bootstrapDistribution: '../outside.json',
        remoteDistributionUrl: 'https://api.example.test/v1/releases/channels/test/distribution',
        requiredEntitlement: 'cobblepower:test',
        offlineGrantSeconds: 86400
    }
    fs.writeFileSync(channelPath, JSON.stringify(base))
    assert.throws(() => loadTesterChannel({ channelPath }), /must stay inside/)
    fs.writeFileSync(path.join(root, 'bootstrap.json'), '{}')
    fs.writeFileSync(channelPath, JSON.stringify({ ...base, bootstrapDistribution: 'bootstrap.json', remoteDistributionUrl: 'http://api.example.test/channel' }))
    assert.throws(() => loadTesterChannel({ channelPath }), /must use HTTPS/)
})
