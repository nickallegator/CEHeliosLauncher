'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { prepare, validateApiBase, verifyOutput } = require('../../scripts/build-channel-launcher')

test('channel installer preparation embeds only schema-v2 bootstrap configuration', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-builder-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    prepare('https://api.example.test', { stagingRoot: root })
    const testerRoot = path.join(root, 'tester')
    const files = fs.readdirSync(testerRoot).sort()
    assert.deepEqual(files, ['distribution_bootstrap.json', 'tester-channel.json'])
    const channel = JSON.parse(fs.readFileSync(path.join(testerRoot, 'tester-channel.json'), 'utf8'))
    assert.equal(channel.schemaVersion, 2)
    assert.equal(channel.remoteDistributionUrl, 'https://api.example.test/v1/releases/channels/test/distribution')
    assert.equal(channel.offlineGrantSeconds, 86400)
})

test('channel installer requires HTTPS except for local development', () => {
    assert.equal(validateApiBase('https://api.example.test/'), 'https://api.example.test')
    assert.equal(validateApiBase('http://localhost:8080/'), 'http://localhost:8080')
    assert.throws(() => validateApiBase('http://api.example.test'), /must use HTTPS/)
})

test('channel output verification requires the authenticated channel and Cobble Power bootstrap profile', (t) => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-staging-'))
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-output-'))
    t.after(() => fs.rmSync(stagingRoot, { recursive: true, force: true }))
    t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))

    const build = prepare('https://api.example.test', { stagingRoot })
    const testerRoot = path.join(outputRoot, 'win-unpacked', 'resources', 'tester')
    fs.mkdirSync(testerRoot, { recursive: true })
    fs.cpSync(path.join(stagingRoot, 'tester'), testerRoot, { recursive: true })
    fs.writeFileSync(
        path.join(outputRoot, `AG-Launcher-Test-setup-${build.launcherVersion}.exe`),
        'installer fixture'
    )
    fs.writeFileSync(path.join(outputRoot, 'win-unpacked', 'AG Launcher.exe'), 'executable fixture')

    const verified = verifyOutput('https://api.example.test', build, { outputRoot })
    assert.equal(path.basename(verified.installerPath), `AG-Launcher-Test-setup-${build.launcherVersion}.exe`)
    assert.equal(path.basename(verified.executablePath), 'AG Launcher.exe')

    const channel = JSON.parse(fs.readFileSync(verified.channelPath, 'utf8'))
    channel.remoteDistributionUrl = 'https://wrong.example.test/v1/releases/channels/test/distribution'
    fs.writeFileSync(verified.channelPath, JSON.stringify(channel))
    assert.throws(
        () => verifyOutput('https://api.example.test', build, { outputRoot }),
        /Packaged channel URL is invalid/
    )
})
