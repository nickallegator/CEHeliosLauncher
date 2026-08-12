'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    SHOWROOM_PROFILE_ID,
    SHOWROOM_TYPES,
    assertSafeShowroomRoot,
    createShowroomEnvironment
} = require('../../scripts/lib/community-showroom')
const { parseCanonicalSchematic } = require('../../libraries/schematics-core')
const { parseArguments } = require('../../scripts/run-community-showroom')

const appDirectory = path.resolve(__dirname, '..', '..')

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

test('showroom arguments preserve explicit directories and reject unknown switches', () => {
    const value = parseArguments(['--keep-data', '--verify', '--data-dir', 'fixture-output'])
    assert.equal(value.keepData, true)
    assert.equal(value.verify, true)
    assert.equal(value.dataDirectory, path.resolve('fixture-output'))
    assert.throws(() => parseArguments(['--unknown']), /Unknown argument/)
    assert.throws(() => parseArguments(['--data-dir']), /requires a path/)
})

test('showroom refuses to reuse unrelated non-empty directories', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-showroom-safety-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(path.join(directory, 'personal-file.txt'), 'keep me')
    assert.throws(() => assertSafeShowroomRoot(directory), /Refusing to use non-empty directory/)
    assert.equal(fs.readFileSync(path.join(directory, 'personal-file.txt'), 'utf8'), 'keep me')
})

test('local showroom serves representative read-only artifacts without production services', async t => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-showroom-test-'))
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }))
    const runtime = await createShowroomEnvironment({ appDirectory, rootDirectory })
    t.after(() => runtime.api.close())

    const capabilities = await fetch(`${runtime.apiBaseUrl}/v1/community/capabilities`).then(response => response.json())
    assert.deepEqual(capabilities.categories.map(value => value.id), SHOWROOM_TYPES)
    assert.equal(capabilities.categories.every(value => value.writable === false), true)

    const catalog = await fetch(`${runtime.apiBaseUrl}/v1/community/catalog?category=all&sort=popular`).then(response => response.json())
    assert.equal(catalog.items.length, 5)
    assert.equal(new Set(catalog.items.map(value => value.type)).size, 5)
    assert.equal(catalog.items.some(value => Object.hasOwn(value, 'artifact')), false)

    const schematicEntry = catalog.items.find(entry => entry.type === 'schematics')
    const schematicDetail = await fetch(`${runtime.apiBaseUrl}/v1/schematics/${schematicEntry.id}`).then(response => response.json())
    const schematicArtifact = await fetch(`${runtime.apiBaseUrl}/v1/schematics/${schematicEntry.id}/download`).then(response => response.json())
    const parsedSchematic = parseCanonicalSchematic(schematicArtifact)
    assert.match(schematicEntry.thumbnailUrl, /\/preview$/)
    assert.equal(schematicDetail.schematic.format, 'cobblepower_schematic')
    assert.equal(parsedSchematic.sha256, schematicEntry.revision.sha256)
    assert.equal(parsedSchematic.blockCount, schematicEntry.typeData.blockCount)
    const schematicPreview = await fetch(`${runtime.apiBaseUrl}${schematicEntry.thumbnailUrl}`).then(response => response.text())
    assert.match(schematicPreview, /3D preview/)
    assert.match(schematicPreview, /<polygon/)

    for(const entry of catalog.items.filter(value => value.type !== 'schematics')) {
        const descriptor = await fetch(`${runtime.apiBaseUrl}/v1/community/items/${entry.type}/${entry.id}/download`).then(response => response.json())
        const artifact = Buffer.from(await fetch(descriptor.downloadUrl).then(response => response.arrayBuffer()))
        assert.equal(artifact.length, entry.revision.sizeBytes)
        assert.equal(digest(artifact), entry.revision.sha256)
    }

    const publishResponse = await fetch(`${runtime.apiBaseUrl}/v1/community/uploads`, { method: 'POST' })
    assert.equal(publishResponse.status, 403)
    assert.equal((await publishResponse.json()).error, 'showroom_read_only')

    const distribution = JSON.parse(fs.readFileSync(runtime.distributionPath, 'utf8'))
    const profile = distribution.servers.find(server => server.id === SHOWROOM_PROFILE_ID)
    assert.ok(profile.modules.some(module => module.id === 'net.allegator.cobblepower:cobblepower:1.0.3-test.1'))
    assert.equal(distribution.community.apiBaseUrl, runtime.apiBaseUrl)
    assert.equal(distribution.schematics.enabled, true)
    assert.equal(distribution.schematics.features.core, true)
    assert.equal(runtime.environment.HELIOS_ACCESS_API_URL, runtime.apiBaseUrl)
    assert.ok(runtime.instanceRoot.startsWith(rootDirectory))
})
