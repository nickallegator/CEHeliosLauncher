'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { hashFile } = require('../../scripts/lib/release-publisher')
const { promoteRelease, publishPrepared } = require('../../scripts/lib/release-remote')

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
