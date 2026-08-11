'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { hashFile } = require('../../scripts/lib/release-publisher')
const { getCurrentRelease, promoteRelease, publishPrepared } = require('../../scripts/lib/release-remote')

test('current release summary is stable, machine-readable, and contains no storage credentials', async () => {
    const result = await getCurrentRelease('test', {
        getJson: async () => ({ value: { releaseId: 'release-1', secretAccessKey: 'must-not-leak' }, etag: 'private-etag' })
    })
    assert.deepEqual(result, { schemaVersion: 1, channel: 'test', releaseId: 'release-1' })
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
    assert.equal(JSON.stringify(result).includes('private-etag'), false)
})

test('current release summary represents an empty channel and propagates storage failures', async () => {
    assert.deepEqual(await getCurrentRelease('test', {
        getJson: async () => { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error }
    }), { schemaVersion: 1, channel: 'test', releaseId: null })
    await assert.rejects(() => getCurrentRelease('test', {
        getJson: async () => { throw new Error('storage unavailable') }
    }), /storage unavailable/)
})

test('publish refuses immutable-object drift before uploading', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-publish-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const filePath = path.join(root, 'artifact.jar')
    fs.writeFileSync(filePath, 'expected')
    const integrity = await hashFile(filePath)
    fs.writeFileSync(path.join(root, 'publish-state.json'), JSON.stringify({
        schemaVersion: 1,
        releaseId: 'release-1',
        channel: 'test',
        objects: [{ key: 'maven/example/artifact/1/artifact-1.jar', file: 'artifact.jar', contentType: 'application/java-archive', ...integrity }]
    }))
    let putCalled = false
    const storage = {
        head: async () => ({ ContentLength: integrity.size, Metadata: { sha256: '0'.repeat(64) } }),
        put: async () => { putCalled = true },
        hash: async () => integrity
    }
    await assert.rejects(() => publishPrepared(root, storage), /Refusing to overwrite immutable object/)
    assert.equal(putCalled, false)
})

test('promotion rejects a concurrently changed channel pointer', async () => {
    const releaseId = 'release-2'
    const descriptor = { releaseId, channel: 'test', modules: [] }
    const storage = {
        getJson: async key => key.endsWith('/release.json')
            ? { value: descriptor, etag: 'descriptor' }
            : { value: { releaseId: 'release-unexpected' }, etag: 'current-etag' },
        head: async () => ({ ContentLength: 1, Metadata: {} }),
        put: async () => { throw new Error('put must not be reached') }
    }
    await assert.rejects(() => promoteRelease({
        channel: 'test',
        releaseId,
        expectedPreviousReleaseId: 'release-1'
    }, storage), /Channel moved/)
})

test('rollback uses the same verified compare-and-swap promotion path', async () => {
    const releaseId = 'release-1'
    let written = null
    const storage = {
        getJson: async key => {
            if(key.endsWith('/release.json')) return { value: { releaseId, channel: 'test', modules: [] }, etag: 'descriptor' }
            if(written) return { value: JSON.parse(written), etag: 'new-etag' }
            return { value: { releaseId: 'release-2' }, etag: 'old-etag' }
        },
        head: async () => ({ ContentLength: 1, Metadata: {} }),
        put: async (_key, body, options) => {
            assert.equal(options.ifMatch, 'old-etag')
            written = body
        }
    }
    const pointer = await promoteRelease({ channel: 'test', releaseId, expectedPreviousReleaseId: 'release-2', promotedAt: '2026-08-09T00:00:00.000Z' }, storage)
    assert.equal(pointer.releaseId, releaseId)
})

test('duplicate promotion verifies the release without rewriting the current pointer', async () => {
    const releaseId = 'release-2'
    let writes = 0
    const storage = {
        getJson: async key => key.endsWith('/release.json')
            ? { value: { releaseId, channel: 'test', modules: [] }, etag: 'descriptor' }
            : { value: { schemaVersion: 1, releaseId }, etag: 'current-etag' },
        head: async () => ({ ContentLength: 1, Metadata: {} }),
        put: async () => { writes++ }
    }
    const result = await promoteRelease({ channel: 'test', releaseId, expectedPreviousReleaseId: 'release-1' }, storage)
    assert.equal(result.unchanged, true)
    assert.equal(writes, 0)
})
