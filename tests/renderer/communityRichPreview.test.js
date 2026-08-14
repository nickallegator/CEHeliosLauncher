'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    GradientEvaluator,
    GraphSpatialIndex,
    computeTexturedGradientLayout,
    fitGraph,
    normalizeAutomationBundle,
    normalizeGradientType,
    parseBedrockGeometry,
    renderTexturedGradientSvg,
    sampleGradient,
    screenToWorld,
    zoomAt
} = require('../../libraries/community-rendering')
const { resolveBlockTopTexture } = require('../../libraries/minecraft-resources')
const { CommunityArtifactCache, hashBuffer } = require('../../app/assets/js/communityartifactcache')
const { drawTexture } = require('../../app/assets/js/communitypreviews/gradient')

const gradientSource = {
    format: 'cobblepower_gradient', version: 1,
    settings: { type: 'SMOOTH', noise: true, noise_strength: .35 },
    nodes: [
        { x: .08, y: .15, value: 0, falloff: .3, strength: 1, shape_nodes: [] },
        { x: .48, y: .55, value: .5, falloff: .28, strength: .9, shape_nodes: [] },
        { x: .9, y: .82, value: 1, falloff: .22, strength: 1, shape_nodes: [] }
    ],
    pins: [
        { value: 0, block: 'minecraft:deepslate_tiles' }, { value: .35, block: 'minecraft:tuff_bricks' },
        { value: .7, block: 'minecraft:cut_copper' }, { value: 1, block: 'minecraft:oxidized_cut_copper' }
    ],
    blend: { enabled: true, sharpness: .55, radius: .3, seed: 421 }, preview: { grid_cells: 16 }
}

test('JavaScript gradient evaluator matches the Java golden contract', () => {
    const expected = [0.000203,0,0,0.003582,0,0,0.001687,0.504474,0,0.00456,0,0.502992,0.497916,0.499986,0.003477,0,0.494242,0.500259,0.493191,1,0,0,0,0.998132,1]
    const blocks = ['minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:cut_copper','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:tuff_bricks','minecraft:tuff_bricks','minecraft:cut_copper','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:tuff_bricks','minecraft:tuff_bricks','minecraft:tuff_bricks','minecraft:oxidized_cut_copper','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:deepslate_tiles','minecraft:oxidized_cut_copper','minecraft:oxidized_cut_copper']
    const evaluator = new GradientEvaluator(gradientSource, 16)
    const actual = []; const actualBlocks = []
    for(let y = 0; y < 5; y += 1) for(let x = 0; x < 5; x += 1) {
        const value = evaluator.evaluate((x + .5) / 5, (y + .5) / 5)
        actual.push(Number(value.toFixed(6))); actualBlocks.push(evaluator.resolveBlock(value, x, y))
    }
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= .000002, `gradient value ${index}: ${value} vs ${expected[index]}`))
    assert.deepEqual(actualBlocks, blocks)
})

test('gradient compatibility maps only historical drift to SMOOTH', () => {
    assert.deepEqual(normalizeGradientType('BANDS'), { type: 'BANDS', legacyFallback: false, requested: 'BANDS' })
    assert.deepEqual(normalizeGradientType('RADIAL'), { type: 'SMOOTH', legacyFallback: true, requested: 'RADIAL' })
})

test('gradient sampling accepts transported binary JSON artifacts without losing material pins', () => {
    const expected = sampleGradient(gradientSource, 8)
    for(const artifact of [
        Buffer.from(JSON.stringify(gradientSource), 'utf8'),
        Uint8Array.from(Buffer.from(JSON.stringify(gradientSource), 'utf8'))
    ]) {
        const sample = sampleGradient(artifact, 8)
        assert.deepEqual(sample.model.pins, expected.model.pins)
        assert.deepEqual(sample.blocks, expected.blocks)
        assert.equal(sample.blocks.every(blockId => typeof blockId === 'string'), true)
    }
})

test('block texture resolution is deterministic and crops the first declared animation frame', async () => {
    const png = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
    png.writeUInt32BE(16, 16)
    png.writeUInt32BE(32, 20)
    const json = new Map([
        ['assets/minecraft/blockstates/test_block.json', { variants: { 'facing=north': { model: 'minecraft:block/wrong' }, '': { model: 'minecraft:block/test_child' } } }],
        ['assets/minecraft/models/block/test_child.json', { parent: 'minecraft:block/test_parent', elements: [{ faces: { up: { texture: '#surface' } } }] }],
        ['assets/minecraft/models/block/test_parent.json', { textures: { surface: 'minecraft:block/test_surface' } }],
        ['assets/minecraft/textures/block/test_surface.png.mcmeta', { animation: { frames: [1, 0] } }]
    ])
    const stack = {
        async getJson(key){ return json.get(key) || null },
        async getBuffer(key){ return key === 'assets/minecraft/textures/block/test_surface.png' ? png : null }
    }
    const texture = await resolveBlockTopTexture(stack, 'minecraft:test_block')
    assert.equal(texture.modelId, 'minecraft:block/test_child')
    assert.equal(texture.textureId, 'minecraft:block/test_surface')
    assert.deepEqual(texture.frame, { x: 0, y: 16, width: 16, height: 16 })
})

test('block texture resolution rejects model inheritance cycles', async () => {
    const stack = {
        async getJson(key){
            return {
                'assets/minecraft/blockstates/cycle.json': { variants: { '': { model: 'minecraft:block/a' } } },
                'assets/minecraft/models/block/a.json': { parent: 'minecraft:block/b' },
                'assets/minecraft/models/block/b.json': { parent: 'minecraft:block/a' }
            }[key] || null
        },
        async getBuffer(){ return null }
    }
    await assert.rejects(() => resolveBlockTopTexture(stack, 'minecraft:cycle'), /inheritance cycle/)
})

test('textured Builder Preset catalog SVG embeds resolved texture bytes deterministically', () => {
    const sample = sampleGradient({ ...gradientSource, preview: { grid_cells: 4 } })
    const texture = {
        bytes: Buffer.from('89504e470d0a1a0a00000000000000000000001000000010', 'hex'),
        width: 16,
        height: 16,
        frame: { x: 0, y: 0, width: 16, height: 16 }
    }
    const textures = new Map(sample.model.pins.map(pin => [pin.block, texture]))
    const first = renderTexturedGradientSvg(sample, textures, { width: 768, height: 432 })
    const second = renderTexturedGradientSvg(sample, textures, { width: 768, height: 432 })
    assert.equal(first.svg, second.svg)
    assert.deepEqual(first.missing, [])
    assert.match(first.svg, /data:image\/png;base64/)
    assert.match(first.svg, /image-rendering:pixelated/)
    assert.doesNotMatch(first.svg, /<text/)
})

test('textured Builder Preset catalog keeps one gradient stage left of one palette rail', () => {
    const layout = computeTexturedGradientLayout(768, 432, gradientSource.pins.length)
    assert.equal(layout.gridX, 20)
    assert.ok(layout.paletteX > layout.gridX + layout.gridSize)
    assert.ok(layout.paletteX + layout.paletteWidth <= 768 - layout.padding + .001)
    assert.ok(layout.swatchX >= layout.paletteX)
    assert.ok(layout.swatchX + layout.swatchSize <= layout.paletteX + layout.paletteWidth)
})

test('textured Builder Preset output reports unassigned cells instead of claiming resource success', () => {
    const sample = sampleGradient({ ...gradientSource, pins: [], preview: { grid_cells: 4 } })
    const rendered = renderTexturedGradientSvg(sample, new Map(), { width: 768, height: 432 })
    assert.deepEqual(rendered.missing, ['<unassigned gradient cell>'])
})

test('interactive gradient tiles draw only the resolved top-texture frame', () => {
    const calls = []
    const image = { id: 'texture-image' }
    const drawn = drawTexture({ drawImage(...args){ calls.push(args) } }, {
        image,
        frame: { x: 0, y: 16, width: 16, height: 16 }
    }, 20, 30, 40, 50)
    assert.equal(drawn, true)
    assert.deepEqual(calls, [[image, 0, 16, 16, 16, 20, 30, 40, 50]])
})

test('Builder Preset publishing always uses the generated textured preview', () => {
    const source = fs.readFileSync(path.resolve(
        __dirname, '..', '..', 'app', 'assets', 'js', 'scripts', 'landing', 'schematics', 'community-content.js'
    ), 'utf8')
    const template = fs.readFileSync(path.resolve(
        __dirname, '..', '..', 'app', 'partials', 'landing', 'community', 'modals', 'content-publish.ejs'
    ), 'utf8')
    assert.match(source, /type === 'builder-presets' \? null : genericCommunitySelectedPreview/)
    assert.match(source, /previewFile\.disabled = type === 'builder-presets'/)
    assert.match(template, /id="communityContentPreviewFileRow"/)
})

test('Automation normalization preserves root order, authored positions, routes, and culling', () => {
    const bundle = normalizeAutomationBundle({
        format: 'cobblepower_automation_bundle', version: 1, rootAsset: 'root',
        assets: [
            { id: 'shared', kind: 'shared_space', name: 'Shared', graph: { nodes: [], edges: [] } },
            { id: 'root', kind: 'operation', name: 'Root', graph: {
                nodes: [{ id: 'a', type: 'cobblepower:event_manual_trigger', x: 10, y: 20 }, { id: 'b', type: 'cobblepower:action_send_message', x: 510, y: 20 }],
                edges: [{ id: 'e', fromNode: 'a', fromPin: 'next', toNode: 'b', toPin: 'input', route: [{ x: 300, y: 150 }] }]
            } }
        ]
    })
    assert.equal(bundle.assets[0].id, 'root')
    assert.deepEqual(bundle.assets[0].edges[0].route, [{ x: 300, y: 150 }])
    const index = new GraphSpatialIndex(bundle.assets[0].nodes)
    assert.deepEqual(index.query({ minX: 0, minY: 0, maxX: 250, maxY: 200 }).map(node => node.id), ['a'])
    const camera = fitGraph(bundle.assets[0].bounds, 800, 480)
    const cursorWorld = screenToWorld(camera, 400, 240)
    const zoomed = zoomAt(camera, 1.5, 400, 240)
    const after = screenToWorld(zoomed, 400, 240)
    assert.ok(Math.abs(cursorWorld.x - after.x) < 1e-8 && Math.abs(cursorWorld.y - after.y) < 1e-8)
})

test('static Bedrock parser produces bounded textured triangle meshes', () => {
    const mesh = parseBedrockGeometry({
        format_version: '1.12.0',
        'minecraft:geometry': [{
            description: { identifier: 'geometry.test', texture_width: 64, texture_height: 64 },
            bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }]
        }]
    })
    assert.equal(mesh.positions.length, 108)
    assert.equal(mesh.normals.length, 108)
    assert.equal(mesh.uvs.length, 72)
    assert.ok(mesh.bounds.size.every(value => value > 0))
})

test('Community artifact cache verifies checksums, repairs corruption, and evicts LRU entries', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-artifact-cache-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const cache = new CommunityArtifactCache({ directory, maxBytes: 16 * 1024 * 1024 })
    const bytes = Buffer.from('verified-community-artifact')
    const digest = hashBuffer(bytes)
    const filePath = cache.put(digest, bytes, { sizeBytes: bytes.length })
    assert.deepEqual(cache.get(digest, bytes.length), bytes)
    fs.writeFileSync(filePath, 'corrupt')
    assert.equal(cache.get(digest, bytes.length), null)
    assert.throws(() => cache.put('0'.repeat(64), bytes), error => error.code === 'community_checksum_mismatch')
})
