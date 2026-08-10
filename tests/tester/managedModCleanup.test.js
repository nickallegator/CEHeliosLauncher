'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { quarantineManagedDropins } = require('../../app/assets/js/managedmodcleanup')

test('superseded active Cobble Power drop-ins are quarantined while other mods and caches remain', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-cleanup-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const mods = path.join(root, 'Cobble-Power-1.21.1', 'mods')
    const versioned = path.join(mods, '1.21.1')
    fs.mkdirSync(versioned, { recursive: true })
    fs.writeFileSync(path.join(mods, 'cobblepower-1.0.0.jar'), 'old')
    fs.writeFileSync(path.join(versioned, 'cobblepower-1.0.1-test.1.jar'), 'duplicate')
    fs.writeFileSync(path.join(mods, 'jei.jar'), 'keep')
    fs.writeFileSync(path.join(mods, 'cobblepower-disabled.jar.disabled'), 'keep-disabled')

    const moved = quarantineManagedDropins(root, 'Cobble-Power-1.21.1', '1.21.1', 1234)
    assert.equal(moved.length, 2)
    assert.equal(fs.existsSync(path.join(mods, 'cobblepower-1.0.0.jar')), false)
    assert.equal(fs.existsSync(path.join(versioned, 'cobblepower-1.0.1-test.1.jar')), false)
    assert.equal(fs.existsSync(path.join(mods, 'jei.jar')), true)
    assert.equal(fs.existsSync(path.join(mods, 'cobblepower-disabled.jar.disabled')), true)
    assert.equal(fs.readdirSync(path.join(mods, '.cobblepower-superseded')).length, 2)
})
