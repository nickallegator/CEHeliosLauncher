'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { writeJsonAtomic } = require('../../app/assets/js/atomicjson')

test('authorized distribution replacement commits atomically', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-atomic-json-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const target = path.join(root, 'distribution_dev.json')
    fs.writeFileSync(target, '{"release":"old"}')
    writeJsonAtomic(target, { release: 'new' })
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { release: 'new' })
    assert.equal(fs.readdirSync(root).some(file => file.endsWith('.tmp')), false)
})

test('staging failure preserves the previous distribution and removes temporary files', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-atomic-failure-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const target = path.join(root, 'distribution_dev.json')
    fs.writeFileSync(target, '{"release":"old"}')
    assert.throws(() => writeJsonAtomic(target, { release: 'new' }, {
        beforeCommit: () => { throw new Error('simulated interruption') }
    }), /simulated interruption/)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { release: 'old' })
    assert.equal(fs.readdirSync(root).some(file => file.endsWith('.tmp')), false)
})
