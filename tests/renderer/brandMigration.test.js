'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const Brand = require('../../app/assets/js/brand')
const { migrateBrandUserData } = require('../../app/assets/js/brandmigration')

test('Allegator Games identity is stable and distinct from a mod profile', () => {
    assert.equal(Brand.productName, 'Allegator Games Launcher')
    assert.equal(Brand.shortName, 'AG Launcher')
    assert.equal(Brand.appId, 'net.allegator.games.launcher')
    assert.equal(Brand.dataDirectoryName, '.ag-launcher')
    assert.ok(Brand.legacyUserDataDirectoryNames.includes('Cobble Power Test Launcher'))
})

test('brand migration copies durable state without changing the legacy profile', (t) => {
    const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-launcher-brand-'))
    t.after(() => fs.rmSync(appDataDirectory, { recursive: true, force: true }))
    const source = path.join(appDataDirectory, 'Cobble Power Test Launcher')
    const target = path.join(appDataDirectory, Brand.userDataDirectoryName)
    fs.mkdirSync(path.join(source, 'schematics-cache'), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.json'), '{"selectedServer":"Cobble-Power-1.21.1"}')
    fs.writeFileSync(path.join(source, 'distribution_dev.json'), '{"servers":[]}')
    fs.writeFileSync(path.join(source, 'schematics-cache', 'catalog-v2.json'), '{"items":[]}')
    fs.mkdirSync(path.join(source, 'GPUCache'))
    fs.writeFileSync(path.join(source, 'GPUCache', 'ignored.bin'), 'cache')

    const result = migrateBrandUserData({
        appDataDirectory,
        targetDirectory: target,
        legacyNames: Brand.legacyUserDataDirectoryNames
    })

    assert.equal(result.migrated, true)
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"selectedServer":"Cobble-Power-1.21.1"}')
    assert.equal(fs.existsSync(path.join(target, 'schematics-cache', 'catalog-v2.json')), true)
    assert.equal(fs.existsSync(path.join(target, 'GPUCache')), false)
    assert.equal(fs.existsSync(path.join(source, 'config.json')), true)
})

test('brand migration never overwrites an Allegator Games configuration', (t) => {
    const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-launcher-brand-existing-'))
    t.after(() => fs.rmSync(appDataDirectory, { recursive: true, force: true }))
    const source = path.join(appDataDirectory, 'Cobble Power Test Launcher')
    const target = path.join(appDataDirectory, Brand.userDataDirectoryName)
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(source, 'config.json'), '{"source":true}')
    fs.writeFileSync(path.join(target, 'config.json'), '{"target":true}')

    const result = migrateBrandUserData({
        appDataDirectory,
        targetDirectory: target,
        legacyNames: Brand.legacyUserDataDirectoryNames
    })

    assert.deepEqual(result, { migrated: false, reason: 'target-config-exists' })
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"target":true}')
})
