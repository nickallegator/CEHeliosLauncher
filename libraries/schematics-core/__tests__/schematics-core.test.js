const assert = require('node:assert/strict')
const test = require('node:test')

const {
    normalizeJsonSchematic,
    computeBounds,
    stableStringify
} = require('../index')

test('normalizeJsonSchematic builds palette, bounds, and hash', async () => {
    const raw = {
        name: 'Tower',
        blocks: [
            { pos: [0, 0, 0], block: 'minecraft:stone' },
            { pos: [1, 0, 0], block: 'minecraft:stone' },
            { pos: [0, 1, 0], block: 'minecraft:stone' },
            { pos: [1, 1, 0], block: 'minecraft:torch' }
        ]
    }

    const { schematic, warnings } = await normalizeJsonSchematic(raw)
    assert.equal(warnings.length, 0)
    assert.equal(schematic.name, 'Tower')
    assert.equal(schematic.palette.length, 2)
    assert.equal(schematic.blocks.length, 4)
    assert.deepEqual(schematic.bounds.min, [0, 0, 0])
    assert.deepEqual(schematic.bounds.max, [1, 1, 0])
    assert.deepEqual(schematic.bounds.size, [2, 2, 1])
    assert.equal(schematic.meta.blockCount, 4)
    assert.equal(typeof schematic.meta.hash, 'string')
    assert.equal(schematic.meta.hash.length, 64)
    assert.ok(schematic.id)
})

test('computeBounds handles empty blocks', () => {
    const bounds = computeBounds([])
    assert.deepEqual(bounds.min, [0, 0, 0])
    assert.deepEqual(bounds.max, [0, 0, 0])
    assert.deepEqual(bounds.size, [0, 0, 0])
})

test('stableStringify is deterministic', () => {
    const a = { b: 1, a: 2, nested: { z: 3, y: 4 } }
    const b = { nested: { y: 4, z: 3 }, a: 2, b: 1 }
    assert.equal(stableStringify(a), stableStringify(b))
})

test('normalizeJsonSchematic reports warnings for bad blocks', async () => {
    const raw = {
        name: 'Broken',
        blocks: [
            { pos: [0, 0], block: 'minecraft:stone' },
            { pos: [0, 0, 0], block: '' },
            { pos: ['a', 0, 0], block: 'minecraft:stone' }
        ]
    }

    const { schematic, warnings } = await normalizeJsonSchematic(raw)
    assert.ok(warnings.length >= 2)
    assert.equal(schematic.blocks.length, 0)
})
