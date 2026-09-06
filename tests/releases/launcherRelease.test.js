'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    assertSigningPolicy,
    createSbom,
    expectedArtifactNames,
    prepare,
    releaseChannel,
    validateTag,
    verify
} = require('../../scripts/launcher-release')

const version = require('../../package.json').version

test('launcher release version and signing policies fail closed', () => {
    assert.equal(releaseChannel('2.8.0-test.1'), 'test')
    assert.equal(releaseChannel('2.8.0'), 'stable')
    assert.throws(() => releaseChannel('2.8.0-beta.1'), /Unsupported/)
    assert.throws(() => validateTag('v2.8.0-test.2', '2.8.0-test.1'), /must equal/)
    assert.doesNotThrow(() => assertSigningPolicy('2.8.0-test.1', {}))
    assert.throws(() => assertSigningPolicy('2.8.0', {}), /Public Trust signing/)
})

test('CycloneDX launcher SBOM generation is deterministic and excludes secret paths', () => {
    const lock = {
        packages: {
            '': { name: 'ag-launcher', version },
            'node_modules/example': { version: '1.2.3', license: 'MIT', integrity: `sha512-${Buffer.from('digest').toString('base64')}` }
        }
    }
    const first = createSbom(lock)
    const second = createSbom(lock)
    assert.deepEqual(first, second)
    assert.equal(first.bomFormat, 'CycloneDX')
    assert.equal(first.components[0].name, 'example')
    assert.equal(JSON.stringify(first).includes('C:\\Users'), false)
})

test('release preparation writes and verifies the exact immutable asset set', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-launcher-release-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const installer = expectedArtifactNames(version)[0]
    fs.writeFileSync(path.join(directory, installer), 'installer')
    fs.writeFileSync(path.join(directory, `${installer}.blockmap`), 'blockmap')
    fs.writeFileSync(path.join(directory, 'latest.yml'), `version: ${version}\npath: ${installer}\n`)
    const notes = path.join(directory, 'notes.md')
    fs.writeFileSync(notes, '# Notes\n')

    const prepared = prepare({ dir: directory, notes, tag: `v${version}` })
    assert.equal(prepared.descriptor.channel, 'test')
    assert.equal(verify({ dir: directory, tag: `v${version}` }).artifactCount, 6)

    fs.appendFileSync(path.join(directory, installer), 'tampered')
    assert.throws(() => verify({ dir: directory, tag: `v${version}` }), /checksum mismatch/)
})
