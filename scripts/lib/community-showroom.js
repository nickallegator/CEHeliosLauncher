'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const AdmZip = require('adm-zip')

const {
    DEFAULT_COMPATIBILITY,
    TYPES,
    canonicalizeAutomation,
    canonicalizeGradient,
    canonicalizeTrainer
} = require('../../libraries/community-core')
const { parseCanonicalSchematic } = require('../../libraries/schematics-core')
const { renderSchematicPreviewSvg } = require('../../libraries/schematics-preview')
const { validateResourcePack } = require('../../backend/src/services/communityResourcePack')

const SHOWROOM_SCHEMA_VERSION = 1
const SHOWROOM_PROFILE_ID = 'Cobble-Power-1.21.1'
const SHOWROOM_PLAYER_UUID = '12345678123442348234123456789abc'
const SCHEMATIC_TYPE = 'schematics'
const SHOWROOM_TYPES = Object.freeze([
    SCHEMATIC_TYPE,
    TYPES.AUTOMATION,
    TYPES.BATTLE_TRAINERS,
    TYPES.BUILDER_PRESETS,
    TYPES.RESOURCE_PACKS
])
const SHOWROOM_SESSION_TOKEN = 'local-community-showroom-session'
const RESOURCE_PACK_ITEM_ID = '40000000-0000-4000-8000-000000000001'
const SHOWROOM_MANIFEST = 'showroom-manifest.json'

const ITEM_IDS = Object.freeze({
    [SCHEMATIC_TYPE]: '60000000-0000-4000-8000-000000000001',
    [TYPES.AUTOMATION]: '10000000-0000-4000-8000-000000000001',
    [TYPES.BATTLE_TRAINERS]: '20000000-0000-4000-8000-000000000001',
    [TYPES.BUILDER_PRESETS]: '30000000-0000-4000-8000-000000000001',
    [TYPES.RESOURCE_PACKS]: RESOURCE_PACK_ITEM_ID
})

const REVISION_IDS = Object.freeze({
    [SCHEMATIC_TYPE]: '70000000-0000-4000-8000-000000000001',
    [TYPES.AUTOMATION]: '50000000-0000-4000-8000-000000000001',
    [TYPES.BATTLE_TRAINERS]: '50000000-0000-4000-8000-000000000002',
    [TYPES.BUILDER_PRESETS]: '50000000-0000-4000-8000-000000000003',
    [TYPES.RESOURCE_PACKS]: '50000000-0000-4000-8000-000000000004'
})

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5ZKYAAAAASUVORK5CYII=',
    'base64'
)

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

function md5(value) {
    return crypto.createHash('md5').update(value).digest('hex')
}

function jsonBuffer(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function createSchematicArtifact() {
    const palette = [
        'minecraft:deepslate_tiles',
        'minecraft:stripped_spruce_log[axis=y]',
        'minecraft:stripped_spruce_log[axis=x]',
        'minecraft:stripped_spruce_log[axis=z]',
        'minecraft:spruce_planks',
        'minecraft:cut_copper',
        'minecraft:oxidized_cut_copper',
        'minecraft:glass',
        'minecraft:lantern[hanging=true,waterlogged=false]'
    ]
    const placed = new Map()
    const place = (x, y, z, state) => placed.set(`${x},${y},${z}`, { pos: [x, y, z], state })

    for(let x = -5; x <= 5; x += 1) {
        for(let z = -4; z <= 4; z += 1) place(x, 0, z, 0)
    }
    for(const x of [-5, 5]) {
        for(const z of [-4, 4]) {
            for(let y = 1; y <= 5; y += 1) place(x, y, z, 1)
        }
    }
    for(let x = -4; x <= 4; x += 1) {
        place(x, 1, 4, 4)
        place(x, 5, 4, 2)
        place(x, 5, -4, 2)
        if(x < -1 || x > 1) place(x, 1, -4, 4)
        for(const y of [2, 3]) {
            place(x, y, 4, x % 3 === 0 ? 7 : 4)
            if(x < -1 || x > 1) place(x, y, -4, x % 3 === 0 ? 7 : 4)
        }
    }
    for(let z = -3; z <= 3; z += 1) {
        place(-5, 5, z, 3)
        place(5, 5, z, 3)
        for(const y of [1, 2, 3]) {
            place(-5, y, z, z % 3 === 0 ? 7 : 4)
            place(5, y, z, z % 3 === 0 ? 7 : 4)
        }
    }
    for(let x = -5; x <= 5; x += 1) {
        for(let z = -4; z <= 4; z += 1) {
            place(x, 6, z, (Math.abs(x) + Math.abs(z)) % 4 === 0 ? 6 : 5)
        }
    }
    for(const x of [-3, 0, 3]) {
        place(x, 5, 0, 8)
    }

    const blocks = [...placed.values()].sort((left, right) =>
        left.pos[1] - right.pos[1]
        || left.pos[2] - right.pos[2]
        || left.pos[0] - right.pos[0])
    const result = parseCanonicalSchematic({
        format: 'cobblepower_schematic',
        version: 2,
        name: 'Copper Workshop Pavilion',
        category: 'workshop',
        type: 'standard',
        icon: 'minecraft:cut_copper',
        palette,
        blocks
    }, { stripBlockEntityNbt: true })
    return { bytes: Buffer.from(result.serialized, 'utf8'), result }
}

function createAutomationArtifact() {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const sharedSpaceId = '22222222-2222-4222-8222-222222222222'
    const result = canonicalizeAutomation({
        format: 'cobblepower_automation_bundle',
        version: 1,
        rootAssetId: operationId,
        assets: [
            {
                kind: 'operation',
                sourceAssetId: operationId,
                document: {
                    format: 'cobblepower_operation',
                    version: 1,
                    operationId,
                    name: 'Apricorn Sorting Line',
                    metadata: {
                        asset_id: operationId,
                        asset_kind: 'operation',
                        shared_space_dependencies: sharedSpaceId
                    },
                    graph: {
                        nodes: [
                            {
                                nodeId: '31111111-1111-4111-8111-111111111111',
                                blockTypeId: 'cobblepower:event_manual_trigger',
                                x: 80,
                                y: 120,
                                parameters: {}
                            },
                            {
                                nodeId: '32222222-2222-4222-8222-222222222222',
                                blockTypeId: 'cobblepower:action_send_message',
                                x: 420,
                                y: 120,
                                parameters: { message: 'Apricorn sorting cycle complete' }
                            }
                        ],
                        edges: [
                            {
                                edgeId: '33333333-3333-4333-8333-333333333333',
                                fromNodeId: '31111111-1111-4111-8111-111111111111',
                                fromPin: 'next',
                                toNodeId: '32222222-2222-4222-8222-222222222222',
                                toPin: 'input'
                            }
                        ]
                    }
                }
            },
            {
                kind: 'shared_space',
                sourceAssetId: sharedSpaceId,
                document: {
                    format: 'cobblepower_operation',
                    version: 1,
                    operationId: sharedSpaceId,
                    name: 'Workshop Timing Utilities',
                    metadata: { asset_id: sharedSpaceId, asset_kind: 'shared_space' },
                    graph: {
                        nodes: [{
                            nodeId: '34444444-4444-4444-8444-444444444444',
                            blockTypeId: 'cobblepower:action_wait',
                            x: 160,
                            y: 100,
                            parameters: { ticks: '20' }
                        }],
                        edges: []
                    }
                }
            }
        ]
    })
    return { bytes: Buffer.from(result.serialized, 'utf8'), result }
}

function createTrainerArtifact() {
    const result = canonicalizeTrainer({
        format: 'cobblepower_battle_projector_trainer',
        version: 1,
        name: 'Engineer Marlow',
        skin_id: 'agshowroom:copper_engineer',
        skill: 6,
        communityDependencies: [{
            itemId: RESOURCE_PACK_ITEM_ID,
            revisionId: REVISION_IDS[TYPES.RESOURCE_PACKS]
        }],
        team: [
            {
                species: 'cobblemon:pikachu',
                level: 28,
                gender: 'MALE',
                nature: 'timid',
                ability: 'static',
                moves: ['thunderbolt', 'quick_attack', 'electro_ball', 'double_team'],
                ivs: [25, 20, 22, 28, 24, 31],
                evs: [0, 0, 0, 120, 0, 180]
            },
            {
                species: 'cobblemon:magnemite',
                level: 30,
                gender: 'GENDERLESS',
                nature: 'modest',
                ability: 'sturdy',
                moves: ['flash_cannon', 'thunder_wave', 'spark', 'light_screen'],
                ivs: [24, 16, 29, 30, 26, 20],
                evs: [80, 0, 40, 180, 0, 0]
            },
            {
                species: 'cobblemon:rotom',
                form: 'heat',
                level: 32,
                gender: 'GENDERLESS',
                nature: 'bold',
                ability: 'levitate',
                moves: ['overheat', 'volt_switch', 'will_o_wisp', 'hex'],
                ivs: [31, 12, 28, 29, 27, 26],
                evs: [120, 0, 120, 60, 0, 0]
            }
        ]
    })
    return { bytes: Buffer.from(result.serialized, 'utf8'), result }
}

function createGradientArtifact() {
    const result = canonicalizeGradient({
        format: 'cobblepower_gradient',
        version: 1,
        settings: { type: 'SMOOTH', noise: true, noise_strength: 0.35 },
        nodes: [
            { x: 0.08, y: 0.15, value: 0, falloff: 0.3, strength: 1 },
            { x: 0.48, y: 0.55, value: 0.5, falloff: 0.28, strength: 0.9 },
            { x: 0.9, y: 0.82, value: 1, falloff: 0.22, strength: 1 }
        ],
        pins: [
            { value: 0, block: 'minecraft:deepslate_tiles' },
            { value: 0.35, block: 'minecraft:tuff_bricks' },
            { value: 0.7, block: 'minecraft:cut_copper' },
            { value: 1, block: 'minecraft:oxidized_cut_copper' }
        ],
        face_islands: [],
        blend: { enabled: true, sharpness: 0.55, radius: 0.3, seed: 421 },
        preview: { grid_cells: 24 }
    })
    return { bytes: Buffer.from(result.serialized, 'utf8'), result }
}

async function createResourcePackArtifact(workspaceRoot) {
    const zip = new AdmZip()
    zip.addFile('pack.mcmeta', jsonBuffer({
        pack: {
            pack_format: 34,
            supported_formats: [34, 34],
            description: 'AG Community showroom textures for Cobble Power and Cobblemon'
        }
    }))
    zip.addFile('pack.png', ONE_PIXEL_PNG)
    zip.addFile('assets/cobblepower/textures/gui/community_showroom_badge.png', ONE_PIXEL_PNG)
    zip.addFile('assets/cobblepower/models/item/community_showroom_badge.json', jsonBuffer({
        parent: 'minecraft:item/generated',
        textures: { layer0: 'cobblepower:gui/community_showroom_badge' }
    }))
    zip.addFile('assets/cobblepower/lang/en_us.json', jsonBuffer({
        'agshowroom.copper_engineer': 'Engineer Marlow'
    }))
    zip.addFile('LICENSE.txt', Buffer.from('Local AG Launcher showroom fixture. Not for redistribution.\n', 'utf8'))
    const bytes = zip.toBuffer()
    const filePath = path.join(workspaceRoot, 'ag-workshop-accents.zip')
    fs.writeFileSync(filePath, bytes)
    const result = await validateResourcePack(filePath)
    return { bytes, result }
}

function previewSvg(type, title) {
    const palettes = {
        [TYPES.AUTOMATION]: ['#102a2a', '#65d1bd', '#e98143'],
        [TYPES.BATTLE_TRAINERS]: ['#291d37', '#d9b35f', '#66c5cc'],
        [TYPES.BUILDER_PRESETS]: ['#18252d', '#87938e', '#b76138'],
        [TYPES.RESOURCE_PACKS]: ['#263527', '#85c56f', '#d77d42']
    }
    const [background, accent, copper] = palettes[type]
    const safeTitle = title.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;'
    })[character])
    return Buffer.from([
        '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432" viewBox="0 0 768 432">',
        `<rect width="768" height="432" fill="${background}"/>`,
        `<path d="M0 342 190 180l122 94 126-146 330 304H0Z" fill="${accent}" opacity=".18"/>`,
        `<path d="M76 87h616v258H76z" fill="none" stroke="${copper}" stroke-width="8"/>`,
        `<circle cx="128" cy="128" r="26" fill="${accent}"/><circle cx="640" cy="304" r="18" fill="${copper}"/>`,
        `<text x="384" y="210" fill="#f3eee0" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700" text-anchor="middle">${safeTitle}</text>`,
        `<text x="384" y="255" fill="${accent}" font-family="Segoe UI, sans-serif" font-size="19" text-anchor="middle">LOCAL COMMUNITY SHOWROOM</text>`,
        '</svg>'
    ].join(''), 'utf8')
}

function createEntry(type, definition, artifact) {
    const bytes = artifact.bytes
    const result = artifact.result
    const itemId = ITEM_IDS[type]
    const revisionId = REVISION_IDS[type]
    const mimeType = type === TYPES.RESOURCE_PACKS ? 'application/zip' : 'application/json'
    const format = result.format || { id: 'minecraft_resource_pack', version: 1 }
    return {
        schemaVersion: 1,
        id: itemId,
        type,
        key: `${type}:${itemId}`,
        title: definition.title,
        description: definition.description,
        creator: { id: '9001', name: 'AG Workshop Team' },
        ownerId: null,
        tags: definition.tags,
        license: 'Community-Use-1.0',
        rightsAttestedAt: '2026-08-11T12:00:00.000Z',
        publishedAt: definition.publishedAt,
        updatedAt: definition.updatedAt,
        stats: { likes: definition.likes, views: definition.views, downloads: definition.downloads },
        compatibility: { ...DEFAULT_COMPATIBILITY },
        revision: {
            id: revisionId,
            number: 1,
            sha256: sha256(bytes),
            sizeBytes: bytes.length,
            mimeType,
            formatId: format.id,
            formatVersion: format.version
        },
        dependencies: result.dependencies || [],
        typeData: result.typeData || {},
        thumbnailUrl: `/v1/community/items/${type}/${itemId}/preview`,
        capabilities: { canEdit: false, canDelete: false, canReport: true, liked: false },
        artifact: bytes,
        preview: previewSvg(type, definition.title)
    }
}

function createSchematicEntry(definition, artifact) {
    const itemId = ITEM_IDS[SCHEMATIC_TYPE]
    const revision = {
        id: REVISION_IDS[SCHEMATIC_TYPE],
        number: 1,
        sha256: artifact.result.sha256,
        sizeBytes: artifact.result.sizeBytes,
        mimeType: 'application/json',
        formatId: 'cobblepower_schematic',
        formatVersion: 2
    }
    return {
        schemaVersion: 1,
        id: itemId,
        type: SCHEMATIC_TYPE,
        key: `${SCHEMATIC_TYPE}:${itemId}`,
        title: definition.title,
        description: definition.description,
        creator: { id: '9001', name: 'AG Workshop Team' },
        ownerId: null,
        tags: definition.tags,
        license: 'Community-Use-1.0',
        rightsAttestedAt: '2026-08-11T12:00:00.000Z',
        publishedAt: definition.publishedAt,
        updatedAt: definition.updatedAt,
        stats: { likes: definition.likes, views: definition.views, downloads: definition.downloads },
        compatibility: { ...DEFAULT_COMPATIBILITY },
        revision,
        schematic: { version: 2, revision },
        dependencies: [],
        typeData: {
            blockCount: artifact.result.blockCount,
            bounds: artifact.result.bounds,
            paletteSize: artifact.result.canonical.palette.length
        },
        thumbnailUrl: `/v1/community/items/${SCHEMATIC_TYPE}/${itemId}/preview`,
        capabilities: { canEdit: false, canDelete: false, canReport: true, liked: false },
        artifact: artifact.bytes,
        canonical: artifact.result.canonical,
        preview: Buffer.from(renderSchematicPreviewSvg(artifact.result, { title: definition.title }), 'utf8')
    }
}

function schematicDetail(entry) {
    const size = entry.typeData.bounds?.size || [0, 0, 0]
    return {
        schemaVersion: 2,
        id: entry.id,
        name: entry.title,
        title: entry.title,
        description: entry.description,
        creator: entry.creator.name,
        ownerId: entry.ownerId,
        tags: entry.tags,
        release: entry.publishedAt,
        updatedAt: entry.updatedAt,
        downloads: entry.stats.downloads,
        likes: entry.stats.likes + (entry.capabilities.liked ? 1 : 0),
        views: entry.stats.views,
        version: String(entry.revision.formatVersion),
        revision: entry.revision,
        blockCount: entry.typeData.blockCount,
        size: size.join(' x '),
        hash: entry.revision.sha256,
        schematic: entry.canonical,
        thumbnailUrl: null,
        liked: entry.capabilities.liked,
        capabilities: entry.capabilities
    }
}

async function createShowroomFixtures(workspaceRoot) {
    fs.mkdirSync(workspaceRoot, { recursive: true })
    const artifacts = {
        [SCHEMATIC_TYPE]: createSchematicArtifact(),
        [TYPES.AUTOMATION]: createAutomationArtifact(),
        [TYPES.BATTLE_TRAINERS]: createTrainerArtifact(),
        [TYPES.BUILDER_PRESETS]: createGradientArtifact(),
        [TYPES.RESOURCE_PACKS]: await createResourcePackArtifact(workspaceRoot)
    }
    const definitions = {
        [SCHEMATIC_TYPE]: {
            title: 'Copper Workshop Pavilion',
            description: 'A complete build represented as individual blocks and rendered in the interactive 3D schematic viewer.',
            tags: ['schematic', 'workshop', 'copper'],
            likes: 137, views: 618, downloads: 214,
            publishedAt: '2026-07-30T12:00:00.000Z', updatedAt: '2026-08-11T10:15:00.000Z'
        },
        [TYPES.AUTOMATION]: {
            title: 'Apricorn Sorting Line',
            description: 'An Operation bundled with its reusable workshop timing Shared Space.',
            tags: ['automation', 'operations', 'shared-space'],
            likes: 84, views: 460, downloads: 132,
            publishedAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-10T15:30:00.000Z'
        },
        [TYPES.BATTLE_TRAINERS]: {
            title: 'Engineer Marlow',
            description: 'A three-Pokémon electric workshop challenge with a Resource Pack skin dependency.',
            tags: ['trainer', 'electric', 'intermediate'],
            likes: 61, views: 389, downloads: 97,
            publishedAt: '2026-08-02T12:00:00.000Z', updatedAt: '2026-08-09T11:15:00.000Z'
        },
        [TYPES.BUILDER_PRESETS]: {
            title: 'Weathered Copper Workshop',
            description: 'A smooth, lightly noisy deepslate-to-oxidized-copper material gradient.',
            tags: ['gradient', 'copper', 'builder'],
            likes: 109, views: 522, downloads: 188,
            publishedAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-11T08:45:00.000Z'
        },
        [TYPES.RESOURCE_PACKS]: {
            title: 'AG Workshop Accents',
            description: 'A minimal valid 1.21.1 pack supplying Cobble Power workshop art and the trainer skin namespace.',
            tags: ['resource-pack', 'ui', 'cobblepower'],
            likes: 72, views: 405, downloads: 121,
            publishedAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-08T09:00:00.000Z'
        }
    }
    return SHOWROOM_TYPES.map(type => type === SCHEMATIC_TYPE
        ? createSchematicEntry(definitions[type], artifacts[type])
        : createEntry(type, definitions[type], artifacts[type]))
}

function publicEntry(entry) {
    const value = { ...entry }
    delete value.artifact
    delete value.preview
    delete value.canonical
    return value
}

function writeJson(response, statusCode, value, headers = {}) {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    response.writeHead(statusCode, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...headers
    })
    response.end(body)
}

function sendBuffer(request, response, statusCode, body, contentType, headers = {}) {
    response.writeHead(statusCode, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=60',
        'Content-Type': contentType,
        'Content-Length': body.length,
        ...headers
    })
    if(request.method === 'HEAD') response.end()
    else response.end(body)
}

function decodeCursor(value) {
    if(!value) return 0
    try {
        const decoded = Buffer.from(String(value), 'base64url').toString('utf8')
        const match = decoded.match(/^showroom:(\d+)$/)
        if(!match) throw new Error('invalid')
        return Number(match[1])
    } catch(_error) {
        return null
    }
}

function encodeCursor(offset) {
    return Buffer.from(`showroom:${offset}`, 'utf8').toString('base64url')
}

function filterCatalog(entries, url) {
    const category = String(url.searchParams.get('category') || 'all').toLowerCase()
    if(category !== 'all' && !SHOWROOM_TYPES.includes(category)) return { error: 'invalid_category' }
    const query = String(url.searchParams.get('query') || '').trim().toLowerCase()
    const creator = String(url.searchParams.get('creator') || '').trim().toLowerCase()
    const tags = String(url.searchParams.get('tags') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    const sort = url.searchParams.get('sort') === 'recent' ? 'recent' : 'popular'
    const limit = Math.min(48, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '24', 10) || 24))
    const offset = decodeCursor(url.searchParams.get('cursor'))
    if(offset == null) return { error: 'invalid_cursor' }
    let values = entries.filter(entry => category === 'all' || entry.type === category)
    if(query) values = values.filter(entry => [entry.title, entry.description, entry.creator.name, ...entry.tags].join(' ').toLowerCase().includes(query))
    if(creator) values = values.filter(entry => entry.creator.name.toLowerCase().includes(creator))
    if(tags.length) values = values.filter(entry => tags.every(tag => entry.tags.map(value => value.toLowerCase()).includes(tag)))
    values.sort(sort === 'recent'
        ? (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
        : (left, right) => right.stats.likes - left.stats.likes || right.updatedAt.localeCompare(left.updatedAt) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id))
    const selected = values.slice(offset, offset + limit)
    return {
        schemaVersion: 1,
        category,
        sort,
        items: selected.map(publicEntry),
        nextCursor: offset + selected.length < values.length ? encodeCursor(offset + selected.length) : null
    }
}

function createShowroomRequestHandler(entries, getBaseUrl) {
    const byKey = new Map(entries.map(entry => [`${entry.type}:${entry.id}`, entry]))
    return (request, response) => {
        const baseUrl = getBaseUrl()
        const url = new URL(request.url, baseUrl || 'http://127.0.0.1')
        if(request.method === 'OPTIONS') {
            response.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS'
            })
            response.end()
            return
        }
        if(url.pathname === '/health') {
            writeJson(response, 200, { status: 'ready', mode: 'local-community-showroom' })
            return
        }
        if(url.pathname === '/v1/community/capabilities' && request.method === 'GET') {
            writeJson(response, 200, {
                schemaVersion: 1,
                defaultCategory: 'all',
                defaultSort: 'popular',
                showroom: true,
                categories: SHOWROOM_TYPES.map(id => ({ id, readable: true, writable: false }))
            })
            return
        }
        if(url.pathname === '/v1/community/catalog' && request.method === 'GET') {
            const catalog = filterCatalog(entries, url)
            if(catalog.error) {
                writeJson(response, 400, { error: catalog.error })
                return
            }
            const etag = `"${sha256(JSON.stringify(catalog))}"`
            if(request.headers['if-none-match'] === etag) {
                response.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' })
                response.end()
                return
            }
            writeJson(response, 200, catalog, { ETag: etag })
            return
        }
        const schematicDownloadMatch = url.pathname.match(/^\/v1\/schematics\/([^/]+)\/download$/)
        if(schematicDownloadMatch && request.method === 'GET') {
            const entry = byKey.get(`${SCHEMATIC_TYPE}:${decodeURIComponent(schematicDownloadMatch[1])}`)
            writeJson(response, entry ? 200 : 404, entry ? entry.canonical : { error: 'not_found' })
            return
        }
        const schematicEngagementMatch = url.pathname.match(/^\/v1\/schematics\/([^/]+)\/(like|view|report)$/)
        if(schematicEngagementMatch && ['POST', 'DELETE'].includes(request.method)) {
            const entry = byKey.get(`${SCHEMATIC_TYPE}:${decodeURIComponent(schematicEngagementMatch[1])}`)
            if(!entry) {
                writeJson(response, 404, { error: 'not_found' })
                return
            }
            const action = schematicEngagementMatch[2]
            if(action === 'like') entry.capabilities.liked = request.method === 'POST'
            if(action === 'view') entry.stats.views += 1
            writeJson(response, 200, {
                schemaVersion: 2,
                localOnly: true,
                liked: entry.capabilities.liked,
                likes: entry.stats.likes + (entry.capabilities.liked ? 1 : 0),
                views: entry.stats.views
            })
            return
        }
        const schematicDetailMatch = url.pathname.match(/^\/v1\/schematics\/([^/]+)$/)
        if(schematicDetailMatch && request.method === 'GET') {
            const entry = byKey.get(`${SCHEMATIC_TYPE}:${decodeURIComponent(schematicDetailMatch[1])}`)
            writeJson(response, entry ? 200 : 404, entry ? schematicDetail(entry) : { error: 'not_found' })
            return
        }
        const itemMatch = url.pathname.match(/^\/v1\/community\/items\/([^/]+)\/([^/]+)$/)
        if(itemMatch && request.method === 'GET') {
            const entry = byKey.get(`${decodeURIComponent(itemMatch[1])}:${decodeURIComponent(itemMatch[2])}`)
            writeJson(response, entry ? 200 : 404, entry ? publicEntry(entry) : { error: 'not_found' })
            return
        }
        const previewMatch = url.pathname.match(/^\/v1\/community\/items\/([^/]+)\/([^/]+)\/preview$/)
        if(previewMatch && ['GET', 'HEAD'].includes(request.method)) {
            const entry = byKey.get(`${decodeURIComponent(previewMatch[1])}:${decodeURIComponent(previewMatch[2])}`)
            if(!entry) writeJson(response, 404, { error: 'not_found' })
            else sendBuffer(request, response, 200, entry.preview, 'image/svg+xml; charset=utf-8')
            return
        }
        const downloadMatch = url.pathname.match(/^\/v1\/community\/items\/([^/]+)\/([^/]+)\/download$/)
        if(downloadMatch && request.method === 'GET') {
            const entry = byKey.get(`${decodeURIComponent(downloadMatch[1])}:${decodeURIComponent(downloadMatch[2])}`)
            if(!entry) writeJson(response, 404, { error: 'not_found' })
            else writeJson(response, 200, {
                schemaVersion: 1,
                itemId: entry.id,
                revisionId: entry.revision.id,
                sha256: entry.revision.sha256,
                sizeBytes: entry.revision.sizeBytes,
                mimeType: entry.revision.mimeType,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                downloadUrl: `${baseUrl}/showroom/artifacts/${entry.type}/${entry.id}`
            })
            return
        }
        const artifactMatch = url.pathname.match(/^\/showroom\/artifacts\/([^/]+)\/([^/]+)$/)
        if(artifactMatch && ['GET', 'HEAD'].includes(request.method)) {
            const entry = byKey.get(`${decodeURIComponent(artifactMatch[1])}:${decodeURIComponent(artifactMatch[2])}`)
            if(!entry) writeJson(response, 404, { error: 'not_found' })
            else sendBuffer(request, response, 200, entry.artifact, entry.revision.mimeType, {
                'Content-Disposition': `attachment; filename="ag-showroom-${entry.type}-${entry.id}.${entry.type === TYPES.RESOURCE_PACKS ? 'zip' : 'json'}"`,
                'X-Content-SHA256': entry.revision.sha256
            })
            return
        }
        const engagementMatch = url.pathname.match(/^\/v1\/community\/items\/([^/]+)\/([^/]+)\/(like|view|report)$/)
        if(engagementMatch && ['POST', 'DELETE'].includes(request.method)) {
            const entry = byKey.get(`${decodeURIComponent(engagementMatch[1])}:${decodeURIComponent(engagementMatch[2])}`)
            if(!entry) {
                writeJson(response, 404, { error: 'not_found' })
                return
            }
            if(engagementMatch[3] === 'like') entry.capabilities.liked = request.method === 'POST'
            writeJson(response, 200, {
                schemaVersion: 1,
                localOnly: true,
                liked: entry.capabilities.liked,
                likes: entry.stats.likes + (entry.capabilities.liked ? 1 : 0)
            })
            return
        }
        if(url.pathname === '/v1/auth/minecraft' && request.method === 'POST') {
            writeJson(response, 200, {
                token: SHOWROOM_SESSION_TOKEN,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                userId: 'showroom-user',
                profile: { id: SHOWROOM_PLAYER_UUID, displayName: 'Workshop Tester', avatarUrl: null },
                entitlements: []
            })
            return
        }
        if(url.pathname === '/v1/entitlements' && request.method === 'GET') {
            writeJson(response, 200, { entitlements: [] })
            return
        }
        if(url.pathname === '/v1/me' && request.method === 'GET') {
            writeJson(response, 200, { id: 'showroom-user', displayName: 'Workshop Tester', avatarUrl: null, entitlements: [] })
            return
        }
        if(url.pathname.startsWith('/v1/community/uploads')) {
            writeJson(response, 403, {
                error: 'showroom_read_only',
                message: 'Publishing is disabled in the local Community showroom.'
            })
            return
        }
        writeJson(response, 404, { error: 'not_found' })
    }
}

async function startShowroomServer(entries) {
    let baseUrl = null
    const server = http.createServer(createShowroomRequestHandler(entries, () => baseUrl))
    server.keepAliveTimeout = 5000
    server.headersTimeout = 6000
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
    return {
        server,
        baseUrl,
        async close() {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        }
    }
}

function injectShowroomDistribution(source, baseUrl) {
    const distribution = structuredClone(source)
    const profile = distribution.servers?.find(server => server.id === SHOWROOM_PROFILE_ID)
    if(!profile) throw new Error(`The development distribution does not contain ${SHOWROOM_PROFILE_ID}.`)
    const marker = Buffer.from('AG Launcher local Community showroom marker. This is not a mod JAR.\n', 'utf8')
    profile.name = 'Cobble Power Community Showroom'
    profile.description = 'Disposable local profile for previewing and installing Community fixture content.'
    profile.version = '1.0.3-test.1-showroom'
    profile.modules = (profile.modules || []).filter(module => !String(module.id).startsWith('net.allegator.cobblepower:cobblepower:'))
    profile.modules.push({
        id: 'net.allegator.cobblepower:cobblepower:1.0.3-test.1',
        name: 'Cobble Power 1.0.3-test.1 (showroom compatibility marker)',
        type: 'ForgeMod',
        required: { value: false, def: false },
        artifact: {
            size: marker.length,
            MD5: md5(marker),
            url: `${baseUrl}/showroom/compatibility-marker`,
            path: 'mods/cobblepower-showroom-marker.jar'
        }
    })
    distribution.community = { schemaVersion: 1, enabled: true, apiBaseUrl: baseUrl }
    distribution.schematics = {
        schemaVersion: 2,
        enabled: true,
        apiBaseUrl: baseUrl,
        features: { core: true, collections: false, creators: false },
        allowedVisibilities: ['public']
    }
    if(distribution.access) {
        distribution.access.apiBaseUrl = baseUrl
        distribution.access.authUrl = baseUrl
    }
    return distribution
}

function createShowroomConfig(gameDataDirectory) {
    const expiry = Date.now() + 365 * 24 * 60 * 60 * 1000
    return {
        settings: {
            game: { resWidth: 1280, resHeight: 720, fullscreen: false, autoConnect: false, launchDetached: true },
            launcher: {
                allowPrerelease: true,
                dataDirectory: gameDataDirectory,
                schematics: { autoDownloadModAssets: false }
            }
        },
        newsCache: { date: null, content: null, dismissed: true },
        clientToken: 'local-showroom-client',
        selectedServer: SHOWROOM_PROFILE_ID,
        selectedAccount: SHOWROOM_PLAYER_UUID,
        authenticationDatabase: {
            [SHOWROOM_PLAYER_UUID]: {
                type: 'microsoft',
                accessToken: 'local-showroom-minecraft-token',
                username: 'Workshop Tester',
                uuid: SHOWROOM_PLAYER_UUID,
                displayName: 'Workshop Tester',
                expiresAt: expiry,
                microsoft: {
                    access_token: 'local-showroom-microsoft-token',
                    refresh_token: 'local-showroom-refresh-token',
                    expires_at: expiry
                }
            }
        },
        modConfigurations: [],
        javaConfig: {},
        access: {
            sessionToken: SHOWROOM_SESSION_TOKEN,
            sessionExpiresAt: new Date(expiry).toISOString(),
            entitlements: [],
            lastSync: new Date().toISOString(),
            channelGrant: { channel: null, releaseId: null, authorizedAt: null },
            profile: { id: 'showroom-user', displayName: 'Workshop Tester', avatarUrl: null }
        }
    }
}

async function createShowroomEnvironment(options = {}) {
    const appDirectory = path.resolve(options.appDirectory || path.join(__dirname, '..', '..'))
    const rootDirectory = options.rootDirectory
        ? path.resolve(options.rootDirectory)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-showroom-'))
    assertSafeShowroomRoot(rootDirectory)
    const launcherDirectory = path.join(rootDirectory, 'launcher-user-data')
    const gameDataDirectory = path.join(rootDirectory, 'minecraft-data')
    const fixtureDirectory = path.join(rootDirectory, 'fixtures')
    fs.mkdirSync(launcherDirectory, { recursive: true })
    fs.mkdirSync(gameDataDirectory, { recursive: true })
    const entries = await createShowroomFixtures(fixtureDirectory)
    const api = await startShowroomServer(entries)
    try {
        const sourceDistribution = JSON.parse(fs.readFileSync(path.join(appDirectory, 'distribution_dev.json'), 'utf8'))
        const distribution = injectShowroomDistribution(sourceDistribution, api.baseUrl)
        const distributionPath = path.join(rootDirectory, 'distribution-showroom.json')
        const configPath = path.join(launcherDirectory, 'config.json')
        fs.writeFileSync(distributionPath, `${JSON.stringify(distribution, null, 2)}\n`, 'utf8')
        fs.writeFileSync(configPath, `${JSON.stringify(createShowroomConfig(gameDataDirectory), null, 2)}\n`, 'utf8')
        const instanceRoot = path.join(gameDataDirectory, 'instances', SHOWROOM_PROFILE_ID)
        fs.mkdirSync(path.join(instanceRoot, 'resourcepacks'), { recursive: true })
        fs.writeFileSync(path.join(instanceRoot, 'options.txt'), 'fov:0.0\nresourcePacks:["vanilla","file/existing-showroom-pack.zip"]\nshowSubtitles:true\n', 'utf8')
        const manifest = {
            schemaVersion: SHOWROOM_SCHEMA_VERSION,
            createdAt: new Date().toISOString(),
            rootDirectory,
            launcherDirectory,
            gameDataDirectory,
            instanceRoot,
            distributionPath,
            apiBaseUrl: api.baseUrl,
            entries: entries.map(entry => ({ type: entry.type, id: entry.id, title: entry.title, sha256: entry.revision.sha256 }))
        }
        fs.writeFileSync(path.join(rootDirectory, SHOWROOM_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        return {
            ...manifest,
            appDirectory,
            entries,
            api,
            environment: {
                ...process.env,
                NODE_ENV: 'test',
                AG_COMMUNITY_SHOWROOM: '1',
                HELIOS_DISTRO_DEV: '1',
                HELIOS_DISTRO_LOCAL_PATH: distributionPath,
                HELIOS_SCHEMATICS_API_URL: api.baseUrl,
                HELIOS_ACCESS_API_URL: api.baseUrl,
                HELIOS_ACCESS_AUTH_URL: api.baseUrl,
                HELIOS_ACCESS_SESSION_TOKEN: SHOWROOM_SESSION_TOKEN,
                HELIOS_ACCESS_ENTITLEMENTS: ''
            }
        }
    } catch(error) {
        await api.close().catch(() => {})
        throw error
    }
}

function assertSafeShowroomRoot(rootDirectory) {
    if(!fs.existsSync(rootDirectory)) {
        fs.mkdirSync(rootDirectory, { recursive: true })
        return
    }
    const names = fs.readdirSync(rootDirectory)
    if(names.length === 0) return
    const manifestPath = path.join(rootDirectory, SHOWROOM_MANIFEST)
    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch(_error) {
        throw new Error(`Refusing to use non-empty directory without a valid ${SHOWROOM_MANIFEST}: ${rootDirectory}`)
    }
    if(manifest?.schemaVersion !== SHOWROOM_SCHEMA_VERSION || path.resolve(manifest.rootDirectory || '') !== rootDirectory) {
        throw new Error(`Refusing to use a directory that is not owned by the AG Community showroom: ${rootDirectory}`)
    }
}

module.exports = {
    ITEM_IDS,
    REVISION_IDS,
    SHOWROOM_PLAYER_UUID,
    SHOWROOM_PROFILE_ID,
    SHOWROOM_SCHEMA_VERSION,
    SHOWROOM_TYPES,
    assertSafeShowroomRoot,
    createShowroomEnvironment,
    createShowroomFixtures,
    decodeCursor,
    filterCatalog,
    injectShowroomDistribution,
    publicEntry,
    startShowroomServer
}
