'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { parseCanonicalSchematic, toPreviewModel } = require('../../libraries/schematics-core')
const { colorForState, exposedFaces, renderSchematicPreviewSvg } = require('../../libraries/schematics-preview')
const { buildSchematicMesh } = require('../../libraries/schematics-visualizer')

function fixture() {
    return parseCanonicalSchematic({
        format: 'cobblepower_schematic',
        version: 2,
        name: 'Preview fixture',
        palette: ['minecraft:deepslate_tiles', 'minecraft:cut_copper'],
        blocks: [
            { pos: [0, 0, 0], state: 0 },
            { pos: [1, 0, 0], state: 1 },
            { pos: [0, 1, 0], state: 1 }
        ]
    })
}

test('schematic card previews are deterministic projections of canonical blocks', () => {
    const parsed = fixture()
    const first = renderSchematicPreviewSvg(parsed)
    const second = renderSchematicPreviewSvg(parsed)

    assert.equal(first, second)
    assert.match(first, /Preview fixture 3D preview/)
    assert.match(first, /<polygon/)
    assert.match(first, /fill="#[0-9a-f]{6}"/i)
})

test('schematic preview generation caps complex surfaces without losing output', () => {
    const parsed = fixture()
    const faces = exposedFaces(parsed, 2)

    assert.equal(faces.length, 2)
    assert.equal(colorForState('minecraft:oxidized_cut_copper'), '#4f9d82')
    assert.throws(() => renderSchematicPreviewSvg({ format: 'cobblepower_schematic', version: 2, palette: [], blocks: [] }), /empty schematic/)
})

test('interactive meshes retain palette colors when no Minecraft textures are available', () => {
    const schematic = toPreviewModel(fixture())
    const paletteColors = [[0.2, 0.4, 0.6], [0.8, 0.35, 0.2]]
    const mesh = buildSchematicMesh(schematic, {}, { paletteColors, usePaletteColors: true })

    assert.ok(mesh.opaque.positions.length > 0)
    assert.deepEqual(
        Array.from(mesh.opaque.colors.slice(0, 3)).map(value => Number(value.toFixed(2))),
        paletteColors[0]
    )
})
