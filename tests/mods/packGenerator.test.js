'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { HeliosDistribution } = require('helios-core/common')
const {
    buildPack,
    downloadArtifact,
    parseArgs,
    resolveSource,
    runPack,
    validatePackManifest
} = require('../../scripts/lib/pack-generator')

function digest(algorithm, content) {
    return crypto.createHash(algorithm).update(content).digest('hex')
}

function artifactDefinition(content) {
    const buffer = Buffer.from(content)
    return {
        buffer,
        md5: digest('md5', buffer),
        sha256: digest('sha256', buffer),
        size: buffer.length
    }
}

function createManifest() {
    const loader = artifactDefinition('test-loader')
    const required = artifactDefinition('required-module')
    const optional = artifactDefinition('optional-module')
    return {
        artifacts: { loader, required, optional },
        manifest: {
            schemaVersion: 1,
            pack: {
                id: 'Test-Pack-1.21.1',
                name: 'Test Pack',
                description: 'Generator test fixture.',
                version: '1.0.0',
                minecraftVersion: '1.21.1',
                address: 'localhost:25565',
                icon: 'https://example.invalid/icon.png',
                mainServer: false,
                autoconnect: false,
                futureModuleId: 'example:test-mod:<version>',
                javaOptions: {
                    distribution: 'TEMURIN',
                    supported: '21.x',
                    suggestedMajor: 21,
                    ram: {
                        minimum: 4096,
                        recommended: 6144
                    }
                },
                loader: {
                    type: 'neoforge',
                    version: '21.1.77',
                    expectedSha256: loader.sha256,
                    expectedSize: loader.size,
                    source: {
                        type: 'direct',
                        url: 'https://example.invalid/neoforge-installer.jar'
                    }
                }
            },
            modules: [
                {
                    id: 'example:optional:1.0.0',
                    name: 'Optional Module',
                    version: '1.0.0',
                    type: 'ForgeMod',
                    role: 'optional',
                    required: false,
                    defaultEnabled: true,
                    side: 'client',
                    order: 20,
                    minecraftVersion: '1.21.1',
                    loader: 'neoforge',
                    expectedSha256: optional.sha256,
                    expectedSize: optional.size,
                    source: {
                        type: 'direct',
                        url: 'https://example.invalid/optional.jar'
                    }
                },
                {
                    id: 'example:required:1.0.0',
                    name: 'Required Module',
                    version: '1.0.0',
                    type: 'ForgeMod',
                    role: 'required',
                    required: true,
                    side: 'both',
                    order: 10,
                    minecraftVersion: '1.21.1',
                    loader: 'neoforge',
                    expectedSha256: required.sha256,
                    expectedSize: required.size,
                    source: {
                        type: 'maven',
                        base: 'https://example.invalid/maven',
                        group: 'example',
                        artifact: 'required',
                        version: '1.0.0'
                    }
                }
            ]
        }
    }
}

function createArtifactProvider(artifacts) {
    const bySha = new Map(Object.values(artifacts).map((artifact) => [artifact.sha256, artifact]))
    return async (_url, options) => {
        const artifact = bySha.get(options.expectedSha256)
        if (!artifact) {
            throw new Error(`Missing fixture artifact ${options.expectedSha256}`)
        }
        return {
            md5: artifact.md5,
            sha256: artifact.sha256,
            size: artifact.size,
            fromCache: false
        }
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

async function startArtifactServer(content) {
    let requests = 0
    const server = http.createServer((_req, res) => {
        requests++
        res.writeHead(200, {
            'Content-Length': content.length,
            'Content-Type': 'application/java-archive'
        })
        res.end(content)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return {
        close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
        requestCount: () => requests,
        url: `http://127.0.0.1:${address.port}/artifact.jar`
    }
}

test('argument parsing supports flag-only check mode', () => {
    assert.deepEqual(parseArgs(['node', 'script', '--pack', 'pack.json', '--check', '--quiet']), {
        pack: 'pack.json',
        check: true,
        quiet: true
    })
})

test('source resolution creates stable Maven and Curse Maven URLs', async () => {
    assert.deepEqual(await resolveSource({
        type: 'maven',
        base: 'https://repo.example.test/',
        group: 'example.group',
        artifact: 'demo',
        version: '1.2.3',
        classifier: 'all'
    }), {
        type: 'maven',
        url: 'https://repo.example.test/example/group/demo/1.2.3/demo-1.2.3-all.jar',
        coordinate: 'example.group:demo:1.2.3:all'
    })
    assert.deepEqual(await resolveSource({
        type: 'cursemaven',
        projectId: 'demo-123',
        fileId: '456'
    }), {
        type: 'cursemaven',
        url: 'https://www.cursemaven.com/curse/maven/demo-123/456/demo-123-456.jar',
        coordinate: 'curse.maven:demo-123:456'
    })
})

test('manifest validation rejects duplicate module ids and incompatible loaders', () => {
    const { manifest } = createManifest()
    manifest.modules.push(clone(manifest.modules[0]))
    assert.throws(() => validatePackManifest(manifest), /Duplicate module id/)

    const incompatible = createManifest().manifest
    incompatible.modules[0].loader = 'fabric'
    assert.throws(() => validatePackManifest(incompatible), /loader must be neoforge/)
})

test('pack generation is ordered, maps optional defaults, and parses in Helios', async () => {
    const { manifest, artifacts } = createManifest()
    const generated = await buildPack(manifest, {}, {
        artifactProvider: createArtifactProvider(artifacts)
    })

    assert.deepEqual(generated.modules.map((module) => module.id), [
        'net.neoforged:neoforge:21.1.77:installer@jar',
        'example:required:1.0.0',
        'example:optional:1.0.0'
    ])
    assert.equal(generated.modules[1].required, undefined)
    assert.deepEqual(generated.modules[2].required, {
        value: false,
        def: true
    })

    const parsed = new HeliosDistribution({
        version: '1.0.0',
        servers: [clone(generated.server)]
    }, os.tmpdir(), os.tmpdir())
    assert.equal(parsed.getServerById('Test-Pack-1.21.1').effectiveJavaOptions.suggestedMajor, 21)
    assert.equal(parsed.getServerById('Test-Pack-1.21.1').modules.length, 3)
})

test('artifact downloads repair corrupt cache entries and then reuse the cache', async (t) => {
    const content = Buffer.from('immutable-artifact')
    const expected = artifactDefinition(content)
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-mod-cache-'))
    const server = await startArtifactServer(content)
    t.after(async () => {
        await server.close()
        fs.rmSync(cacheDir, { recursive: true, force: true })
    })

    fs.writeFileSync(path.join(cacheDir, expected.sha256), 'corrupt')
    const first = await downloadArtifact(server.url, {
        cacheDir,
        expectedSha256: expected.sha256,
        expectedSize: expected.size,
        retries: 0
    })
    const second = await downloadArtifact(server.url, {
        cacheDir,
        expectedSha256: expected.sha256,
        expectedSize: expected.size,
        retries: 0
    })

    assert.equal(first.fromCache, false)
    assert.equal(second.fromCache, true)
    assert.equal(server.requestCount(), 1)
    assert.equal(digest('sha256', fs.readFileSync(second.cachePath)), expected.sha256)
})

test('artifact downloads reject checksum drift without retaining the bad object', async (t) => {
    const content = Buffer.from('changed-upstream-content')
    const wrongSha = digest('sha256', 'expected-content')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-drift-cache-'))
    const server = await startArtifactServer(content)
    t.after(async () => {
        await server.close()
        fs.rmSync(cacheDir, { recursive: true, force: true })
    })

    await assert.rejects(downloadArtifact(server.url, {
        cacheDir,
        expectedSha256: wrongSha,
        expectedSize: content.length,
        retries: 0
    }), /Checksum mismatch/)
    assert.equal(fs.existsSync(path.join(cacheDir, wrongSha)), false)
})

test('failed generation leaves the distribution and lock untouched', async (t) => {
    const { manifest } = createManifest()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-atomic-'))
    const manifestPath = path.join(tempDir, 'pack.json')
    const distroPath = path.join(tempDir, 'distribution.json')
    const lockPath = path.join(tempDir, 'pack.lock.json')
    const originalDistribution = '{"version":"1.0.0","servers":[]}\n'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
    fs.writeFileSync(distroPath, originalDistribution, 'utf8')
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

    await assert.rejects(runPack({
        pack: manifestPath,
        distro: distroPath,
        lock: lockPath,
        quiet: true
    }, {
        artifactProvider: async () => {
            throw new Error('simulated artifact failure')
        }
    }), /simulated artifact failure/)

    assert.equal(fs.readFileSync(distroPath, 'utf8'), originalDistribution)
    assert.equal(fs.existsSync(lockPath), false)
})

test('check mode detects stale output without rewriting it', async (t) => {
    const { manifest, artifacts } = createManifest()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-check-'))
    const manifestPath = path.join(tempDir, 'pack.json')
    const distroPath = path.join(tempDir, 'distribution.json')
    const lockPath = path.join(tempDir, 'pack.lock.json')
    const provider = createArtifactProvider(artifacts)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
    fs.writeFileSync(distroPath, JSON.stringify({ version: '1.0.0', servers: [] }), 'utf8')
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

    await runPack({ pack: manifestPath, distro: distroPath, lock: lockPath, quiet: true }, {
        artifactProvider: provider
    })
    await runPack({ pack: manifestPath, distro: distroPath, lock: lockPath, check: true, quiet: true }, {
        artifactProvider: provider
    })

    const distribution = JSON.parse(fs.readFileSync(distroPath, 'utf8'))
    distribution.servers[0].name = 'Stale Name'
    fs.writeFileSync(distroPath, JSON.stringify(distribution), 'utf8')
    const staleText = fs.readFileSync(distroPath, 'utf8')
    await assert.rejects(runPack({
        pack: manifestPath,
        distro: distroPath,
        lock: lockPath,
        check: true,
        quiet: true
    }, {
        artifactProvider: provider
    }), /out of date/)
    assert.equal(fs.readFileSync(distroPath, 'utf8'), staleText)
})

test('Cobble Power distribution matches the committed dependency lock', () => {
    const projectRoot = path.resolve(__dirname, '..', '..')
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'packs', 'cobble-power-1.21.1.json'), 'utf8'))
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'packs', 'locks', 'cobble-power-1.21.1.lock.json'), 'utf8'))
    const distribution = JSON.parse(fs.readFileSync(path.join(projectRoot, 'distribution_dev.json'), 'utf8'))
    const profile = distribution.servers.find((server) => server.id === manifest.pack.id)

    assert.deepEqual(distribution.servers.map((server) => server.id), [
        'Demo-1.19.4',
        'Demo-1.20',
        'Fabric-Demo-1.20.4',
        'WesterosCraft-Demo-1.12.2',
        'Cobble-Power-1.21.1'
    ])
    assert.ok(profile)
    assert.equal(profile.minecraftVersion, '1.21.1')
    assert.equal(profile.javaOptions.supported, '21.x')
    assert.equal(profile.javaOptions.suggestedMajor, 21)
    assert.equal(profile.version, '0.1.0-deps.5')
    assert.equal(profile.modules.length, 19)
    assert.equal(profile.modules.some((module) => module.id.startsWith('net.allegator.cobblepower:')), false)

    const kotlinForForgeModules = profile.modules
        .filter((module) => module.id.startsWith('thedarkcolour:'))
        .map((module) => ({ id: module.id, type: module.type }))
    assert.deepEqual(kotlinForForgeModules, [
        {
            id: 'thedarkcolour:kfflang-neoforge:5.3.0',
            type: 'Library'
        },
        {
            id: 'thedarkcolour:kfflib-neoforge:5.3.0',
            type: 'Library'
        },
        {
            id: 'thedarkcolour:kffmod-neoforge:5.3.0',
            type: 'ForgeMod'
        }
    ])

    const kotlinRuntimeLibraries = profile.modules
        .filter((module) => module.id === 'org.jetbrains:annotations:13.0'
            || module.id.startsWith('org.jetbrains.kotlin:')
            || module.id.startsWith('org.jetbrains.kotlinx:'))
        .map((module) => ({ id: module.id, type: module.type }))
    assert.deepEqual(kotlinRuntimeLibraries, [
        { id: 'org.jetbrains:annotations:13.0', type: 'Library' },
        { id: 'org.jetbrains.kotlin:kotlin-stdlib:2.0.0', type: 'Library' },
        { id: 'org.jetbrains.kotlin:kotlin-stdlib-jdk7:2.0.0', type: 'Library' },
        { id: 'org.jetbrains.kotlin:kotlin-stdlib-jdk8:2.0.0', type: 'Library' },
        { id: 'org.jetbrains.kotlin:kotlin-reflect:2.0.0', type: 'Library' },
        { id: 'org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.8.1', type: 'Library' },
        { id: 'org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:1.8.1', type: 'Library' },
        { id: 'org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.7.0', type: 'Library' },
        { id: 'org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.7.0', type: 'Library' }
    ])
    assert.equal(profile.modules.some((module) => module.id.includes('kotlinforforge-neoforge')), false)

    const optionalModules = profile.modules.filter((module) => module.required?.value === false)
    assert.equal(optionalModules.length, 4)
    assert.equal(optionalModules.every((module) => module.required.def === true), true)
    assert.deepEqual(
        lock.artifacts.map((artifact) => artifact.integrity.sha256),
        [manifest.pack.loader.expectedSha256, ...manifest.modules
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
            .map((module) => module.expectedSha256)]
    )

    const parsed = new HeliosDistribution(clone(distribution), os.tmpdir(), os.tmpdir())
    assert.equal(parsed.getServerById('Cobble-Power-1.21.1').modules.length, 19)
})
