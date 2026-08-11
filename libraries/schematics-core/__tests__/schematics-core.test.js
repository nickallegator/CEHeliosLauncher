'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    FORMAT_ID,
    FORMAT_VERSION,
    MAX_BLOCKS,
    SchematicValidationError,
    adaptCanonicalForPlayer,
    computeBounds,
    hashCanonicalSchematic,
    normalizeJsonSchematic,
    parseCanonicalSchematic,
    stableStringify
} = require('../index')

function canonical(overrides = {}) {
    return {
        format: FORMAT_ID,
        version: FORMAT_VERSION,
        id: 'cobblepower:client/00000000-0000-0000-0000-000000000001/source',
        name: 'Bridge',
        category: 'utility',
        icon: 'minecraft:oak_planks',
        type: 'bridge',
        bridge: { axis: 'x', regions: [{ type: 'start', min: [0, 0, 0], max: [0, 0, 0] }] },
        scalable: { axes: ['x'] },
        modifiers: [{ id: 'cobblepower:offset', data: '{x:1}' }],
        palette: ['minecraft:oak_stairs[facing=east,half=bottom]', 'minecraft:chest[facing=north]'],
        blocks: [
            { pos: [0, 0, 0], state: 0 },
            { pos: [1, 0, 0], state: 1, nbt: '{Items:[{Slot:0b,id:"minecraft:diamond",count:64}]}' }
        ],
        ...overrides
    }
}

test('canonical v2 preserves format metadata and state strings', () => {
    const result = parseCanonicalSchematic(canonical())
    assert.equal(result.canonical.format, FORMAT_ID)
    assert.equal(result.canonical.version, 2)
    assert.equal(result.canonical.type, 'bridge')
    assert.deepEqual(result.canonical.bridge.axis, 'x')
    assert.deepEqual(result.canonical.scalable.axes, ['x'])
    assert.equal(result.canonical.modifiers[0].id, 'cobblepower:offset')
    assert.equal(result.canonical.palette[0], 'minecraft:oak_stairs[facing=east,half=bottom]')
    assert.equal(result.blockCount, 2)
    assert.equal(result.sha256.length, 64)
})

test('legacy raw blocks convert to canonical v2 and preview model', async () => {
    const raw = {
        name: 'Tower',
        type: 'standard',
        blocks: [
            { pos: [0, 0, 0], block: 'minecraft:stone' },
            { pos: [1, 0, 0], block: 'minecraft:stone' },
            { pos: [0, 1, 0], state: 'minecraft:wall_torch[facing=east]' }
        ]
    }
    const { schematic, canonical: converted, warnings } = await normalizeJsonSchematic(raw)
    assert.equal(converted.format, FORMAT_ID)
    assert.equal(converted.version, 2)
    assert.equal(converted.palette.length, 2)
    assert.equal(schematic.palette[1].block, 'minecraft:wall_torch')
    assert.equal(schematic.palette[1].state.facing, 'east')
    assert.deepEqual(schematic.bounds.size, [2, 2, 1])
    assert.match(warnings[0], /converted/i)
})

test('content hash is deterministic and excludes installed player id', () => {
    const first = parseCanonicalSchematic(canonical()).canonical
    const second = parseCanonicalSchematic(canonical({
        id: 'cobblepower:client/00000000-0000-0000-0000-000000000002/source'
    })).canonical
    assert.equal(hashCanonicalSchematic(first), hashCanonicalSchematic(second))
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})

test('public canonicalization strips block entity NBT and reports it', () => {
    const result = parseCanonicalSchematic(canonical(), { stripBlockEntityNbt: true })
    assert.equal(result.canonical.blocks[1].nbt, undefined)
    assert.equal(result.sanitization.blockEntityNbtRemoved, 1)
    assert.match(result.warnings.at(-1), /removed block-entity nbt/i)
})

test('future versions require a launcher update', () => {
    assert.throws(
        () => parseCanonicalSchematic(canonical({ version: FORMAT_VERSION + 1 })),
        error => error instanceof SchematicValidationError && error.code === 'future_version' && /launcher update/i.test(error.message)
    )
})

test('block and byte limits are enforced', () => {
    assert.throws(
        () => parseCanonicalSchematic(canonical({ blocks: Array.from({ length: MAX_BLOCKS + 1 }, (_, index) => ({ pos: [index, 0, 0], state: 0 })) })),
        error => error.code === 'too_many_blocks'
    )
    assert.throws(
        () => parseCanonicalSchematic(canonical(), { sourceBytes: (5 * 1024 * 1024) + 1 }),
        error => error.code === 'file_too_large'
    )
})

test('invalid palette indexes, duplicate positions, and traversal ids are rejected', () => {
    assert.throws(() => parseCanonicalSchematic(canonical({ blocks: [{ pos: [0, 0, 0], state: 99 }] })), /palette index/i)
    assert.throws(() => parseCanonicalSchematic(canonical({ blocks: [
        { pos: [0, 0, 0], state: 0 },
        { pos: [0, 0, 0], state: 0 }
    ] })), /duplicate block position/i)
    assert.throws(() => adaptCanonicalForPlayer(canonical(), '00000000000000000000000000000001', '../escape'), /community schematic id/i)
})

test('player adaptation changes only the installed id', () => {
    const source = parseCanonicalSchematic(canonical(), { stripBlockEntityNbt: true })
    const installed = adaptCanonicalForPlayer(source.canonical, '00112233445566778899aabbccddeeff', 'garden-plot')
    assert.equal(installed.id, 'cobblepower:client/00112233-4455-6677-8899-aabbccddeeff/garden-plot')
    assert.equal(hashCanonicalSchematic(installed), source.sha256)
})

test('computeBounds handles empty and populated block arrays', () => {
    assert.deepEqual(computeBounds([]), { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] })
    assert.deepEqual(computeBounds([{ pos: [-1, 2, 0] }, { pos: [3, 4, 5] }]).size, [5, 3, 6])
})
