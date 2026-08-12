'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const AdmZip = require('adm-zip')

const {
    hashFile,
    prepareRelease,
    replaceModuleUrl,
    validateSourceCommit,
    validateVersionAgreement
} = require('../../scripts/lib/release-publisher')

const projectRoot = path.resolve(__dirname, '..', '..')

function createTestMod(root, version) {
    const jarPath = path.join(root, `cobblepower-${version}.jar`)
    const archive = new AdmZip()
    archive.addFile('META-INF/neoforge.mods.toml', Buffer.from(`
modLoader="javafml"
loaderVersion="[4,)"
license="All Rights Reserved"
[[mods]]
modId="cobblepower"
version="${version}"
displayName="Cobble Power"
[[dependencies.cobblepower]]
modId="neoforge"
type="required"
versionRange="[21.1.0,)"
ordering="NONE"
side="BOTH"
[[dependencies.cobblepower]]
modId="minecraft"
type="required"
versionRange="[1.21.1,1.22)"
ordering="NONE"
side="BOTH"
`))
    archive.addFile('example.txt', Buffer.from('deterministic-test-mod'))
    archive.writeZip(jarPath)
    return jarPath
}

function createTestCommunityContract(root, version) {
    const contractPath = path.join(root, 'community-contracts.json')
    fs.writeFileSync(contractPath, JSON.stringify({
        schemaVersion: 1,
        modId: 'cobblepower',
        modVersion: version,
        types: {
            automation: { formatId: 'cobblepower_automation_bundle', formatVersion: 1 },
            'battle-trainers': { formatId: 'cobblepower_battle_projector_trainer', formatVersion: 1 },
            'builder-presets': { formatId: 'cobblepower_gradient', formatVersion: 1 },
            'resource-packs': { formatId: 'minecraft_resource_pack', formatVersion: 1 }
        }
    }))
    return contractPath
}

test('publisher rejects tag, metadata, and non-prerelease version disagreement', () => {
    assert.throws(() => validateVersionAgreement({
        version: '1.0.0',
        tag: 'v1.0.0',
        metadata: { mod: { version: '1.0.0' } }
    }), /SemVer prerelease/)
    assert.throws(() => validateVersionAgreement({
        version: '1.0.1-test.1',
        tag: 'v1.0.1-test.2',
        metadata: { mod: { version: '1.0.1-test.1' } }
    }), /Git tag/)
})

test('publisher rejects a tagged source commit mismatch', (t) => {
    const sourceRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-source-'))
    t.after(() => fs.rmSync(sourceRepo, { recursive: true, force: true }))
    execFileSync('git', ['init'], { cwd: sourceRepo })
    execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: sourceRepo })
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: sourceRepo })
    fs.writeFileSync(path.join(sourceRepo, 'tracked.txt'), 'source')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: sourceRepo })
    execFileSync('git', ['commit', '-m', 'Test source'], { cwd: sourceRepo })
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim()
    assert.equal(validateSourceCommit(sourceRepo, actual), actual)
    assert.throws(() => validateSourceCommit(sourceRepo, 'f'.repeat(40)), /does not match requested commit/)
})

test('private module URL replacement is exact and deterministic', () => {
    const distribution = { servers: [{ modules: [{ id: 'a:b:1', artifact: { url: 'https://old' }, subModules: [] }] }] }
    replaceModuleUrl(distribution, 'a:b:1', 'maven/a/b/1/b-1.jar')
    assert.equal(distribution.servers[0].modules[0].artifact.url, 'r2://maven/a/b/1/b-1.jar')
    assert.throws(() => replaceModuleUrl(distribution, 'missing:id:1', 'maven/missing/id/1/id-1.jar'), /found 0/)
})

test('prepare produces deterministic templates, descriptors, and publish state', async (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-publisher-'))
    const version = '1.0.1-test.1'
    const jarPath = createTestMod(fixture, version)
    const communityContractPath = createTestCommunityContract(fixture, version)
    const sourceRepo = path.join(fixture, 'source')
    fs.mkdirSync(sourceRepo)
    fs.writeFileSync(path.join(sourceRepo, 'gradle.properties'), `mod_version=${version}\n`)
    execFileSync('git', ['init'], { cwd: sourceRepo })
    execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: sourceRepo })
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: sourceRepo })
    execFileSync('git', ['add', 'gradle.properties'], { cwd: sourceRepo })
    execFileSync('git', ['commit', '-m', 'Test source'], { cwd: sourceRepo })
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim()
    const outputA = path.join(projectRoot, 'dist', `publisher-test-a-${process.pid}`)
    const outputB = path.join(projectRoot, 'dist', `publisher-test-b-${process.pid}`)
    t.after(() => {
        fs.rmSync(fixture, { recursive: true, force: true })
        fs.rmSync(outputA, { recursive: true, force: true })
        fs.rmSync(outputB, { recursive: true, force: true })
    })
    const options = {
        modPath: jarPath,
        modVersion: version,
        packVersion: '1.0.1-test.1',
        sourceRepository: 'https://github.com/nickallegator/Cobble-Power-1.21.X',
        sourceTag: `v${version}`,
        sourceCommit,
        sourceRepo,
        communityContractPath,
        createdAt: '2026-08-09T00:00:00.000Z'
    }
    await prepareRelease({ ...options, outputDir: outputA })
    await prepareRelease({ ...options, outputDir: outputB })
    for(const file of ['distribution-template.json', 'release.json', 'publish-state.json', 'pack.lock.json']) {
        assert.equal(fs.readFileSync(path.join(outputA, file), 'utf8'), fs.readFileSync(path.join(outputB, file), 'utf8'), file)
    }
    const distribution = JSON.parse(fs.readFileSync(path.join(outputA, 'distribution-template.json'), 'utf8'))
    const serialized = JSON.stringify(distribution)
    assert.match(serialized, /r2:\/\/maven\/net\/allegator\/cobblepower/)
    assert.match(serialized, /r2:\/\/third-party\/com\/cobblemon/)
    assert.equal(serialized.includes('publisher.invalid'), false)
    const descriptor = JSON.parse(fs.readFileSync(path.join(outputA, 'release.json'), 'utf8'))
    assert.deepEqual(descriptor.communityContracts.supportedTypes, [
        'automation', 'battle-trainers', 'builder-presets', 'resource-packs'
    ])
    assert.equal(descriptor.communityContracts.sha256.length, 64)
})

test('streaming file hashing reports both launcher and release digests', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-hash-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const filePath = path.join(root, 'artifact.jar')
    fs.writeFileSync(filePath, 'artifact')
    const result = await hashFile(filePath)
    assert.equal(result.size, 8)
    assert.equal(result.md5.length, 32)
    assert.equal(result.sha256.length, 64)
})
