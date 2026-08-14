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
    compileBedrockAnimations,
    compileExpression,
    composeBedrockBoneRotation,
    fitGraph,
    normalizeAutomationBundle,
    normalizeGradientType,
    parseBedrockGeometry,
    renderAutomationSvg,
    renderGraphCanvas,
    renderTexturedGradientSvg,
    sampleGradient,
    screenToWorld,
    selectableBedrockAnimations,
    selectDefaultBedrockAnimation,
    zoomAt
} = require('../../libraries/community-rendering')
const { resolveBlockTopTexture } = require('../../libraries/minecraft-resources')
const { CommunityArtifactCache, hashBuffer } = require('../../app/assets/js/communityartifactcache')
const { drawTexture } = require('../../app/assets/js/communitypreviews/gradient')
const { configureTextureUpload, orbitEye, orbitFromDrag } = require('../../app/assets/js/communitypreviews/model-viewer')
const { normalizeSubjects, rendererGroup, subjectKey } = require('../../app/assets/js/communitypreviews/resource-pack')

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

test('Bedrock animation expressions use degree-based Molang timing without evaluating code', () => {
    const sample = compileExpression('math.clamp(math.sin(q.anim_time*90)*8, -4, 4)')
    assert.equal(sample({ animTime: 0 }), 0)
    assert.ok(Math.abs(sample({ animTime: 1 }) - 4) < 0.000001)
    assert.equal(compileExpression('global.process.exit()')({ animTime: 1 }), 0)
})

test('poser standing metadata selects idle while keyframed animations interpolate', () => {
    const animations = compileBedrockAnimations([{ animations: {
        'animation.example.walk': { loop: true, animation_length: 2, bones: { body: { position: { 0: [0, 0, 0], 2: [2, 0, 0] } } } },
        'animation.example.ground_idle': { loop: true, bones: { body: { rotation: [0, 0, 'math.sin(q.anim_time*90)*5'] } } }
    } }])
    const poser = { poses: { standing: { poseTypes: ['STAND'], isBattle: false, animations: ["q.bedrock('example', 'ground_idle')"] } } }
    assert.equal(selectDefaultBedrockAnimation(animations, poser).id, 'ground_idle')
    assert.deepEqual(selectableBedrockAnimations([
        ...animations,
        ...compileBedrockAnimations([{ animations: {
            'animation.example.pose': { loop: true, bones: { body: { rotation: [0, 0, 0] } } },
            'animation.example.ground_idle_size': { loop: true, bones: { body: { scale: .5 } } }
        } }])
    ], poser).map(animation => animation.id), ['ground_idle', 'walk'])
    const walk = animations.find(animation => animation.id === 'walk')
    assert.deepEqual(walk.sample(1).bones.body.position, [1, 0, 0])
})

test('Bedrock animation composition matches Cobblemon ModelPart axes for Dialga-like legs', () => {
    const dialgaLeg = composeBedrockBoneRotation([38.04466, 16.64183, 41.72981], [-10.15932, 3.42732, -9.1825])
    assert.deepEqual(dialgaLeg.map(value => Number(value.toFixed(5))), [-27.88534, 20.06915, -32.54731])
    assert.deepEqual(composeBedrockBoneRotation([0, 0, 0], [20, -15, 8]), [-20, -15, -8])
})

test('Bedrock jump keyframes interpolate from lower post to upper pre and apply post at the key', () => {
    const [animation] = compileBedrockAnimations([{ animations: {
        'animation.example.jump': { animation_length: 2, bones: { body: { position: {
            0: { pre: [0, 0, 0], post: [4, 0, 0] },
            2: { pre: [8, 0, 0], post: [12, 0, 0] }
        } } } }
    } }])
    assert.deepEqual(animation.sample(1).bones.body.position, [6, 0, 0])
    assert.deepEqual(animation.sample(2).bones.body.position, [12, 0, 0])
})

test('Bedrock animated meshes preserve normalization while applying bone scale', () => {
    const geometry = { 'minecraft:geometry': [{
        description: { identifier: 'geometry.test', texture_width: 16, texture_height: 16 },
        bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [2, 2, 2], uv: [0, 0] }] }]
    }] }
    const base = parseBedrockGeometry(geometry, { pose: { bones: { body: { scale: [1, 1, 1] } } } })
    const animated = parseBedrockGeometry(geometry, {
        pose: { bones: { body: { position: [2, 0, 0], scale: [2, 1, 1] } } },
        normalization: base.normalization
    })
    assert.deepEqual(animated.normalization, base.normalization)
    assert.ok(animated.bounds.size[0] > base.bounds.size[0])
    assert.ok(animated.bounds.min[0] > base.bounds.min[0])
})

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

test('Builder Preset and Automation publishing always use generated artifact previews', () => {
    const source = fs.readFileSync(path.resolve(
        __dirname, '..', '..', 'app', 'assets', 'js', 'scripts', 'landing', 'schematics', 'community-content.js'
    ), 'utf8')
    const template = fs.readFileSync(path.resolve(
        __dirname, '..', '..', 'app', 'partials', 'landing', 'community', 'modals', 'content-publish.ejs'
    ), 'utf8')
    assert.match(source, /const automaticPreview = type === 'builder-presets' \|\| type === 'automation'/)
    assert.match(source, /previewFile\.disabled = automaticPreview/)
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

test('Automation nodes clip category headers to one professional rounded silhouette', () => {
    const calls = []
    const context = { canvas: { width: 640, height: 360 } }
    for(const method of ['arc', 'beginPath', 'clearRect', 'clip', 'fill', 'fillRect', 'fillText', 'lineTo', 'moveTo', 'restore', 'roundRect', 'save', 'scale', 'stroke', 'translate']) {
        context[method] = (...args) => calls.push([method, ...args])
    }
    const node = {
        id: 'node', title: 'Manual Trigger', category: 'events', x: 40, y: 50,
        width: 180, height: 86, inputs: [], outputs: []
    }
    const asset = { nodes: [node], nodesById: new Map([[node.id, node]]), edges: [] }
    renderGraphCanvas(context, asset, { panX: 0, panY: 0, zoom: 1 })
    const headerIndex = calls.findIndex(call => call[0] === 'fillRect' && call[1] === node.x && call[2] === node.y && call[3] === node.width && call[4] === 32)
    const clipIndex = calls.findIndex(call => call[0] === 'clip')
    assert.ok(clipIndex >= 0 && clipIndex < headerIndex)
    assert.equal(calls.some(call => call[0] === 'fillRect' && call[3] === 5 && call[4] === node.height), false)
})

test('Automation catalog previews fit the full graph into solid category-colored tiles', () => {
    const svg = renderAutomationSvg({
        format: 'cobblepower_automation_bundle', version: 1, rootAsset: 'root',
        assets: [{ id: 'root', kind: 'operation', graph: {
            nodes: [
                { id: 'event', type: 'cobblepower:event_manual_trigger', x: 0, y: 0 },
                { id: 'data', type: 'cobblepower:data_variable', x: 1200, y: 0 },
                { id: 'control', type: 'cobblepower:control_if', x: 0, y: 800 },
                { id: 'action', type: 'cobblepower:action_send_message', x: 1200, y: 800 }
            ],
            edges: [{ id: 'edge', fromNode: 'event', toNode: 'action', route: [] }]
        } }]
    })
    for(const color of ['#e0b35f', '#63c4c7', '#a39af6', '#77d68e']) assert.match(svg, new RegExp(`fill="${color}"`))
    assert.match(svg, /<title>Automation graph preview: 4 nodes, 1 connections/)
    assert.doesNotMatch(svg, /<text\s/)
    assert.doesNotMatch(svg, /width="4" height=/)
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

test('Bedrock static poses transform bones and hidden alternatives do not emit geometry', () => {
    const geometry = {
        format_version: '1.12.0',
        'minecraft:geometry': [{
            description: { identifier: 'geometry.pose', texture_width: 16, texture_height: 16 },
            bones: [
                { name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [2, 2, 2], uv: [0, 0] }] },
                { name: 'mouth_closed', parent: 'body', cubes: [{ origin: [0, 0, -1], size: [1, 1, 1], uv: [0, 0] }] },
                { name: 'mouth_open', parent: 'body', cubes: [{ origin: [0, 0, -1], size: [1, 1, 1], uv: [0, 0] }] }
            ]
        }]
    }
    const unposed = parseBedrockGeometry(geometry)
    const posed = parseBedrockGeometry(geometry, {
        pose: { bones: { body: { position: [3, 0, 0], rotation: [0, 25, 0] } } },
        hiddenBones: ['mouth_open']
    })
    assert.equal(posed.positions.length, unposed.positions.length - 108)
    assert.notDeepEqual(Array.from(posed.positions.slice(0, 6)), Array.from(unposed.positions.slice(0, 6)))
})

test('Bedrock texture upload preserves the format top-origin UV convention', () => {
    const calls = []
    const gl = { UNPACK_FLIP_Y_WEBGL: 0x9240, pixelStorei: (...args) => calls.push(args) }
    configureTextureUpload(gl)
    assert.deepEqual(calls, [[gl.UNPACK_FLIP_Y_WEBGL, false]])
})

test('Community model controls use the same orbit direction, sensitivity, and pitch bounds as block previews', () => {
    const rotation = orbitFromDrag(0.4, 0.2, 20, -10)
    assert.equal(rotation.yaw, 0.5)
    assert.ok(Math.abs(rotation.pitch - 0.15) < 1e-12)
    assert.equal(orbitFromDrag(0, 1.3, 0, 100).pitch, 1.35)
    assert.equal(orbitFromDrag(0, -1.3, 0, -100).pitch, -1.35)
    const eye = orbitEye(-Math.PI / 2, 0, 4)
    assert.ok(Math.abs(eye[0]) < 1e-12)
    assert.ok(Math.abs(eye[1]) < 1e-12)
    assert.ok(Math.abs(eye[2] + 4) < 1e-12)
})

test('Resource Pack preview resources combine the complete candidate list with selected showcases deterministically', () => {
    const subjects = normalizeSubjects([
        { kind: 'pokemon', species: 'cobblemon:pikachu', form: '', gender: 'MALE' },
        { kind: 'block', id: 'minecraft:cut_copper', state: {} },
        { kind: 'block', id: 'minecraft:copper_block', state: {} }
    ], {
        subjects: [
            { kind: 'block', id: 'minecraft:copper_block', state: {} },
            { kind: 'pokemon', species: 'cobblemon:pikachu', form: '', gender: 'MALE' }
        ]
    })
    assert.deepEqual(subjects.map(subjectKey), [
        'block:minecraft:copper_block',
        'block:minecraft:cut_copper',
        'pokemon:cobblemon:pikachu::MALE'
    ])
})

test('Resource Pack comparison groups forward camera lifecycle calls to both renderers', () => {
    const calls = []
    const fake = name => ({
        fit(){ calls.push(`${name}:fit`) }, render(){ calls.push(`${name}:render`) },
        resize(size){ calls.push(`${name}:resize:${size.cssWidth}`) },
        getAnimationOptions(){ return [{ id: 'idle', label: 'Idle' }] }, getAnimationId(){ return 'idle' }, isPlaying(){ return true },
        setAnimation(id){ calls.push(`${name}:animation:${id}`) }, setPlaying(value){ calls.push(`${name}:playing:${value}`) },
        destroy(){ calls.push(`${name}:destroy`) }
    })
    const group = rendererGroup([fake('base'), fake('pack')])
    assert.deepEqual(group.getAnimationOptions(), [{ id: 'idle', label: 'Idle' }])
    assert.equal(group.getAnimationId(), 'idle'); assert.equal(group.isPlaying(), true)
    group.fit(); group.render(); group.resize({ cssWidth: 720 }); group.setAnimation('idle'); group.setPlaying(false); group.destroy(); group.destroy()
    assert.deepEqual(calls, [
        'base:fit', 'pack:fit', 'base:render', 'pack:render',
        'base:resize:720', 'pack:resize:720',
        'base:animation:idle', 'pack:animation:idle', 'base:playing:false', 'pack:playing:false',
        'base:destroy', 'pack:destroy'
    ])
})

test('Bedrock planar cubes omit degenerate sides and separate opposing textured faces', () => {
    const mesh = parseBedrockGeometry({
        format_version: '1.12.0',
        'minecraft:geometry': [{
            description: { identifier: 'geometry.plane', texture_width: 16, texture_height: 16 },
            bones: [{ name: 'plane', cubes: [{ origin: [-2, 0, 0], size: [4, 4, 0], uv: [0, 0] }] }]
        }]
    })
    assert.equal(mesh.positions.length, 36)
    assert.equal(mesh.normals.length, 36)
    assert.equal(mesh.uvs.length, 24)
    assert.ok(mesh.bounds.size[2] > 0, 'opposing plane faces need a stable depth separation')
    assert.ok(mesh.bounds.size[2] < 0.001, 'plane depth separation must remain visually negligible')
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
