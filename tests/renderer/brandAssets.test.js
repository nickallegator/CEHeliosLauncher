'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const Brand = require('../../app/assets/js/brand')

const root = path.resolve(__dirname, '..', '..')

function digest(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

test('package and Electron Builder identities match the runtime brand contract', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const baseBuilder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    const channelBuilder = fs.readFileSync(path.join(root, 'electron-builder.channel.yml'), 'utf8')

    assert.equal(packageJson.name, Brand.packageName)
    assert.equal(packageJson.productName, Brand.productName)
    assert.ok(baseBuilder.includes(`appId: '${Brand.appId}'`))
    assert.match(baseBuilder, /productName: 'Allegator Games Launcher'/)
    assert.match(baseBuilder, /executableName: 'AG Launcher'/)
    assert.match(baseBuilder, /icon: 'build\/icon\.ico'/)
    assert.match(channelBuilder, /artifactName: 'AG-Launcher-Test-setup-\$\{version\}\.\$\{ext\}'/)
})

test('generated logo assets are optimized, consistent, and retain legacy binary aliases', () => {
    const logo = path.join(root, 'app', 'assets', 'brand', 'allegator-games-logo.svg')
    const rendererIcon = path.join(root, 'app', 'assets', 'brand', 'allegator-games-app-icon.png')
    const buildPng = path.join(root, 'build', 'icon.png')
    const buildIco = path.join(root, 'build', 'icon.ico')
    const buildIcns = path.join(root, 'build', 'icon.icns')
    const legacyPng = path.join(root, 'app', 'assets', 'images', 'SealCircle.png')
    const legacyIco = path.join(root, 'app', 'assets', 'images', 'SealCircle.ico')

    assert.equal(/data:image\//.test(fs.readFileSync(logo, 'utf8')), false)
    assert.ok(fs.statSync(logo).size < 64 * 1024)
    assert.equal(digest(rendererIcon), digest(buildPng))
    assert.equal(digest(legacyPng), digest(buildPng))
    assert.equal(digest(legacyIco), digest(buildIco))
    assert.ok(fs.statSync(buildIco).size > 0)
    assert.ok(fs.statSync(buildIcns).size > 0)
})
