'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    discoverProfileResources,
    parseMavenCoordinate,
    resolveModstoreArtifactPath
} = require('../../libraries/minecraft-resources')

test('profile resource discovery resolves only active, path-safe artifacts', async t => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-resource-source-'))
    t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }))
    const profileId = 'Cobble-Power-1.21.1'
    const instanceDirectory = path.join(dataDirectory, 'instances', profileId)
    const modstoreDirectory = path.join(dataDirectory, 'common', 'modstore')
    const coordinate = 'net.allegator:cobblepower:1.0.3-test.1'
    const modPath = resolveModstoreArtifactPath(modstoreDirectory, coordinate)
    const minecraftJar = path.join(dataDirectory, 'common', 'versions', '1.21.1', '1.21.1.jar')
    fs.mkdirSync(path.dirname(modPath), { recursive: true })
    fs.mkdirSync(path.dirname(minecraftJar), { recursive: true })
    fs.mkdirSync(path.join(instanceDirectory, 'mods'), { recursive: true })
    fs.mkdirSync(path.join(instanceDirectory, 'resourcepacks', 'local-pack'), { recursive: true })
    fs.writeFileSync(modPath, 'mod')
    fs.writeFileSync(minecraftJar, 'minecraft')
    fs.writeFileSync(path.join(instanceDirectory, 'mods', 'local.jar'), 'local')
    fs.writeFileSync(path.join(instanceDirectory, 'forgeMods.list'), `${coordinate}\nmissing:test:1.0.0\n`)

    const result = await discoverProfileResources({ dataDirectory, profileId, minecraftVersion: '1.21.1' })

    assert.deepEqual(result.activeModJars, [modPath])
    assert.deepEqual(result.missingCoordinates, ['missing:test:1.0.0'])
    assert.equal(result.minecraftJar, minecraftJar)
    assert.equal(result.looseResources.some(entry => entry.path.endsWith('local.jar')), true)
    assert.equal(result.looseResources.some(entry => entry.path.endsWith('local-pack')), true)
})

test('Maven resource paths reject traversal and malformed coordinates', () => {
    assert.deepEqual(parseMavenCoordinate('com.example:artifact:1.2.3'), {
        coordinate: 'com.example:artifact:1.2.3',
        group: 'com.example',
        artifact: 'artifact',
        version: '1.2.3',
        classifier: null
    })
    assert.equal(parseMavenCoordinate('../outside:artifact:1.0.0'), null)
    assert.equal(resolveModstoreArtifactPath('C:\\safe', 'com.example:../../escape:1.0.0'), null)
})
