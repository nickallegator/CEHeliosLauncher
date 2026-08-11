'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const vm = require('node:vm')

const core = require('../../libraries/schematics-core')
const {
    SchematicApiClient,
    SchematicInstallManager,
    moduleContainsCobblePower,
    redactUrl
} = require('../../app/assets/js/schematicmanager')

function source() {
    return core.parseCanonicalSchematic({
        format: core.FORMAT_ID,
        version: 2,
        id: 'cobblepower:source',
        name: 'Pilot',
        category: 'test',
        type: 'standard',
        palette: ['minecraft:stone'],
        blocks: [{ pos: [0, 0, 0], state: 0 }]
    })
}

test('install manager writes to the selected instance and adapts owner id', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-install-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const parsed = source()
    const manager = new SchematicInstallManager({
        instanceDirectory: path.join(root, 'instances'),
        launcherDirectory: path.join(root, 'launcher'),
        core
    })
    const entry = { id: 'pilot-one', name: 'Pilot', revision: { id: 'r1', number: 1, sha256: parsed.sha256 } }
    const record = manager.install({ profileId: 'cobble-power-1-21-1', playerUuid: '00112233445566778899aabbccddeeff', entry, canonical: parsed.canonical })
    assert.match(record.filePath, /instances[\\/]cobble-power-1-21-1[\\/]config[\\/]cobblepower[\\/]schematics/)
    assert.equal(JSON.parse(fs.readFileSync(record.filePath, 'utf8')).id, 'cobblepower:client/00112233-4455-6677-8899-aabbccddeeff/pilot-one')
    assert.equal(manager.status('cobble-power-1-21-1', '00112233445566778899aabbccddeeff', entry).state, 'installed')
})

test('install manager protects locally modified managed files', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-modified-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const parsed = source()
    const manager = new SchematicInstallManager({ instanceDirectory: path.join(root, 'instances'), launcherDirectory: path.join(root, 'launcher'), core })
    const entry = { id: 'pilot-two', revision: { id: 'r1', number: 1, sha256: parsed.sha256 } }
    const record = manager.install({ profileId: 'pack', playerUuid: '00112233445566778899aabbccddeeff', entry, canonical: parsed.canonical })
    fs.appendFileSync(record.filePath, '\nmodified')
    assert.throws(() => manager.remove({ profileId: 'pack', playerUuid: '00112233445566778899aabbccddeeff', schematicId: entry.id }), error => error.code === 'locally_modified')
    assert.equal(fs.existsSync(record.filePath), true)
})

test('install manager reports manual updates without changing files', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-update-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const parsed = source()
    const manager = new SchematicInstallManager({ instanceDirectory: path.join(root, 'instances'), launcherDirectory: path.join(root, 'launcher'), core })
    const entry = { id: 'pilot-three', revision: { id: 'r1', number: 1, sha256: parsed.sha256 } }
    manager.install({ profileId: 'pack', playerUuid: '00112233445566778899aabbccddeeff', entry, canonical: parsed.canonical })
    assert.equal(manager.status('pack', '00112233445566778899aabbccddeeff', { ...entry, revision: { id: 'r2', number: 2, sha256: 'f'.repeat(64) } }).state, 'update')
})

test('catalog client uses ETags and last-successful offline cache', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-catalog-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    let online = true
    const fetchMock = async (_url, options) => {
        if(!online) throw new Error('offline https://signed.example/file?secret=value')
        assert.equal(options.headers['If-None-Match'], undefined)
        return new Response(JSON.stringify({ schemaVersion: 2, items: [{ id: 'one' }], total: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"catalog-1"' }
        })
    }
    const client = new SchematicApiClient({ baseUrl: 'https://api.example', fetch: fetchMock, cachePath: path.join(root, 'cache.json'), timeoutMs: 100 })
    assert.equal((await client.list()).offline, false)
    online = false
    const cached = await client.list()
    assert.equal(cached.offline, true)
    assert.equal(cached.items[0].id, 'one')
    assert.equal(redactUrl('failed https://x.test/a?token=secret'), 'failed https://x.test/a?[redacted]')
})

test('catalog cache is isolated by normalized query parameters', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-query-cache-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    let online = true
    const fetchMock = async url => {
        if(!online) throw new Error('offline')
        const query = new URL(url).searchParams.get('query')
        return new Response(JSON.stringify({ schemaVersion: 2, items: [{ id: query }], total: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: `"${query}"` }
        })
    }
    const client = new SchematicApiClient({ baseUrl: 'https://api.example', fetch: fetchMock, cachePath: path.join(root, 'cache.json') })
    await client.list({ sort: 'release', query: 'bridges' })
    await client.list({ query: 'farms', sort: 'release' })
    online = false
    assert.equal((await client.list({ query: 'bridges', sort: 'release' })).items[0].id, 'bridges')
    assert.equal((await client.list({ sort: 'release', query: 'farms' })).items[0].id, 'farms')
    await assert.rejects(() => client.list({ query: 'unknown', sort: 'release' }))
})

test('Cobble Power module detection walks nested profile modules', () => {
    assert.equal(moduleContainsCobblePower([{ subModules: [{ rawModule: { id: 'net.allegator.cobblepower:cobblepower:1.0.2-test.1' } }] }]), true)
    assert.equal(moduleContainsCobblePower([{ rawModule: { id: 'example:other:1' } }]), false)
})

test('service discovery follows an authorized distribution refresh', async () => {
    let distribution = { rawDistribution: {} }
    const context = vm.createContext({
        process: { env: {} },
        DistroAPI: { getDistribution: async () => distribution }
    })
    const apiSource = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'app', 'assets', 'js', 'scripts', 'landing', 'schematics', 'api.js'),
        'utf8'
    )
    vm.runInContext(apiSource, context)
    assert.equal((await context.resolveSchematicsServiceConfig()).enabled, false)
    distribution = {
        rawDistribution: {
            schematics: {
                schemaVersion: 2,
                enabled: true,
                apiBaseUrl: 'https://schematics.example.test',
                features: { core: true, collections: false, creators: false },
                allowedVisibilities: ['public']
            }
        }
    }
    const refreshed = await context.resolveSchematicsServiceConfig()
    assert.equal(refreshed.enabled, true)
    assert.equal(refreshed.apiBaseUrl, 'https://schematics.example.test')
})
