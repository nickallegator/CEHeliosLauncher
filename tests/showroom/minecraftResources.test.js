'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const AdmZip = require('adm-zip')

const {
    JarResourceProvider,
    DirectoryResourceProvider,
    ZipBufferResourceProvider,
    createResourceStack,
    discoverProfileResources,
    parseMavenCoordinate,
    resolveModstoreArtifactPath
} = require('../../libraries/minecraft-resources')
const { pokemonResources } = require('../../app/assets/js/communitypreviews/resource-pack')

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

test('resource stacks enumerate overlay-first paths without hiding base Cobblemon resolvers', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-resource-stack-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const basePath = path.join(directory, 'base.jar')
    const base = new AdmZip()
    base.addFile('assets/cobblemon/bedrock/pokemon/resolvers/0025_pikachu/base.json', Buffer.from(JSON.stringify({
        species: 'cobblemon:pikachu', variations: [{ aspects: [], model: 'cobblemon:pikachu_male.geo', texture: 'cobblemon:textures/pokemon/base.png' }]
    })))
    base.addFile('assets/cobblemon/bedrock/pokemon/models/0025_pikachu/pikachu_male.geo.json', Buffer.from(JSON.stringify({ 'minecraft:geometry': [] })))
    base.addFile('assets/cobblemon/textures/pokemon/base.png', Buffer.from('base-texture'))
    base.writeZip(basePath)

    const overlay = new AdmZip()
    overlay.addFile('assets/cobblemon/bedrock/pokemon/resolvers/0025_pikachu/base.json', Buffer.from(JSON.stringify({
        species: 'cobblemon:pikachu', variations: [{ aspects: [], model: 'cobblemon:pikachu_male.geo', texture: 'cobblepower:textures/pokemon/pack.png' }]
    })))
    overlay.addFile('assets/cobblepower/textures/pokemon/pack.png', Buffer.from('pack-texture'))

    const baseStack = createResourceStack([new JarResourceProvider(basePath)])
    const packStack = createResourceStack([new ZipBufferResourceProvider(overlay.toBuffer()), baseStack])
    const prefix = 'assets/cobblemon/bedrock/pokemon/resolvers/'
    assert.equal((await packStack.list(prefix)).length, 1)
    assert.equal((await pokemonResources({ species: 'cobblemon:pikachu', form: '', gender: 'MALE' }, baseStack)).texture.toString(), 'base-texture')
    assert.equal((await pokemonResources({ species: 'cobblemon:pikachu', form: '', gender: 'MALE' }, packStack)).texture.toString(), 'pack-texture')

    const extension = new AdmZip()
    extension.addFile('assets/example_models/bedrock/pokemon/resolvers/1_cosmog_base.json', Buffer.from(JSON.stringify({
        species: 'cobblemon:cosmog', order: 1,
        variations: [{ aspects: [], model: 'example_models:cosmog.geo', texture: 'example_models:textures/pokemon/cosmog.png' }]
    })))
    extension.addFile('assets/example_models/bedrock/pokemon/models/cosmog/cosmog.geo.json', Buffer.from(JSON.stringify({ 'minecraft:geometry': [] })))
    extension.addFile('assets/example_models/textures/pokemon/cosmog.png', Buffer.from('extension-texture'))
    const extensionStack = createResourceStack([new ZipBufferResourceProvider(extension.toBuffer()), baseStack])
    const resolved = await pokemonResources({
        species: 'cobblemon:cosmog', form: '', gender: 'GENDERLESS', resourceNamespace: 'example_models'
    }, extensionStack)
    assert.equal(resolved.texture.toString(), 'extension-texture')
})

test('directory resource providers enumerate only files below a safe prefix', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-directory-resources-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const resolverDirectory = path.join(directory, 'assets', 'cobblemon', 'bedrock', 'pokemon', 'resolvers', 'test')
    fs.mkdirSync(resolverDirectory, { recursive: true })
    fs.writeFileSync(path.join(resolverDirectory, 'resolver.json'), '{}')
    const provider = new DirectoryResourceProvider(directory)
    assert.deepEqual(await provider.list('assets/cobblemon/bedrock/pokemon/resolvers/'), [
        'assets/cobblemon/bedrock/pokemon/resolvers/test/resolver.json'
    ])
    await assert.rejects(() => provider.list('../outside'), /unsafe path/)
})
